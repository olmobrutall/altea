import "@altea/altea/server";
import "@altea/altea/server/operationFluentInclude";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { Graph } from "@altea/altea/server/graph";
import { table as tableQuery } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { getKey as queryKeyOf, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { TemplatingLogic } from "@altea/altea-templating/server/TemplatingLogic.server";
import { TextTemplateParser } from "@altea/altea-templating/server/TextTemplateParser.server";
import type { BlockNode as TextBlockNode } from "@altea/altea-templating/server/TextTemplateParser.Nodes.server";
import { MultiEntityModel, QueryModel } from "@altea/altea-templating/data/Templating";
import {
    OfficeConverterSymbol, OfficeModelEntity, OfficeTemplateEntity, OfficeTemplateMessage,
    OfficeTemplateOperation, OfficeTemplatePermission, OfficeTemplateVisibleOn, OfficeTransformerSymbol,
    officeTemplateValidations,
} from "../data/OfficeTemplate";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { OxmlPackage } from "./oxml/OxmlPackage.server";
import { OfficeTemplateParser } from "./OfficeTemplateParser.server";
import { OfficeTemplateRenderer } from "./OfficeTemplateRenderer.server";
import type { IOfficeModel } from "./OfficeTemplateParameters.server";
import { OfficeModelLogic, multiEntityOfficeModel, queryOfficeModel } from "./OfficeModelLogic.server";
import { toDataTableProviders, type OfficeContext } from "./TableBinder.server";
import { ModelDataTableProvider, UserChartDataTableProvider, UserQueryDataTableProvider } from "./DataTableProviders.server";
import { OxmlElement } from "./oxml/OxmlElement.server";
import { OfficeServer } from "./OfficeServer.server";
import { OfficeAttachmentLogic } from "./OfficeAttachmentLogic.server";
import { registerOfficeTemplateXml } from "./OfficeTemplateXml.server";
import { finalize as finalizeSpreadsheetPath, prepareSpreadsheet } from "./spreadsheet/SpreadsheetUtils.server";

// Port of Signum.Word's WordTemplateLogic.cs — registration, the caches, and `createReport`: the one
// function that turns a stored template plus an entity into finished document bytes.
//
// altea divergences, documented inline:
//  - Signum's `ProcessOpenXmlPackage(document => …)` opens the package, runs a callback and returns the
//    saved bytes. Here that is explicit: `OxmlPackage.load` / mutate / `save()`.
//  - `CultureInfoUtils.ChangeBothCultures` has no counterpart — altea threads the culture through
//    TemplateParameters rather than through an ambient thread culture, so there is nothing to swap.
//  - The whole path is ASYNC (altea's query execution is), so `createReport` returns a Promise.
//  - Signum's `WordTemplateVisibleOn` dictionary keyed by model TYPE stays, but keyed by clean name.
//  - `TokenMigrationLogic` (the stored-token migration pass) is not ported; altea has no such subsystem.
//  - Signum's two StaticPropertyValidations are DECLARED on the entity's fields and implemented here (see
//    officeTemplateValidations); the template one is async, which the core validator contract permits.

/** Signum's FileContent — the produced file plus the name the template computed for it. */
export interface OfficeFileContent {
    readonly fileName: string;
    readonly bytes: Uint8Array;
}

/** Applied to the OPENED package after rendering, before saving (Signum's Transformers dictionary). */
export type OfficeTransformer = (ctx: OfficeContext, package_: OxmlPackage) => void | Promise<void>;

/** Applied to the SAVED bytes (Signum's Converters dictionary) — e.g. render to PDF. */
export type OfficeConverter = (ctx: OfficeContext, bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;

// NOT PORTED, by design: Signum ships three concrete helpers that are .NET-only and are, in its own
// design, pluggable add-ons rather than engine parts —
//
//   GdiBitmapConverter    System.Drawing (Windows-only since .NET 6)
//   ImageSharpConverter   the ImageSharp package
//   HtmlToWordConverter   the HtmlToOpenXml package — turns an HTML fragment into WordprocessingML
//
// The first two implement Signum's IImageConverter, whose altea counterpart lives in
// OfficeImageReplacer.server.ts and is OPTIONAL there (raw bytes need no image library at all). The third
// has no altea counterpart yet: an app that needs HTML-into-Word can register an OfficeTransformerSymbol
// that does it, which is the extension point Signum's own converter plugs into.

export namespace OfficeTemplateLogic {
    export const transformers = new Map<string, OfficeTransformer>();
    export const converters = new Map<string, OfficeConverter>();

    export let officeTemplatesLazy: ResetLazy<Map<string, OfficeTemplateEntity>> = null!;
    export let templatesByQueryKey: ResetLazy<Map<string, OfficeTemplateEntity[]>> = null!;

    /** Signum's `Func<Entity?, CultureInfo>? GetCultureInfo` — the app's culture resolver. */
    export let getCulture: ((entity: Entity | null) => string) | undefined;

    export function start(sb: SchemaBuilder): void {
        TemplatingLogic.start(sb);

        sb.include(OfficeTemplateEntity).withQuery();

        new Graph.Execute(OfficeTemplateOperation.Save, {
            canBeNew: true,
            canBeModified: true,
            execute: (_t: OfficeTemplateEntity) => { /* the saver persists it */ },
        }).register();

        // Signum's two StaticPropertyValidations. They are DECLARED on the entity's fields (see
        // officeTemplateValidations) and implemented here, because both need server-only machinery. The
        // template one is async — the core validator contract permits that, and every server validation
        // path awaits it, so an unparseable template is rejected on save exactly as in Signum.
        officeTemplateValidations.template = async t => (await validateTemplate(t)) ?? null;
        officeTemplateValidations.fileName = t => validateFileName(t) ?? null;

        new Graph.Delete(OfficeTemplateOperation.Delete, {
            delete: async (t: OfficeTemplateEntity) => { await t.delete(); },
        }).register();

        // Signum registers this as an operation so the UI can gate on CanExecute; the actual work is done
        // by the route (it must stream a file back), hence the "UI-only operation" throw.
        new Graph.Execute(OfficeTemplateOperation.CreateOfficeReport, {
            // Signum's ForReadonlyEntity; altea's equivalent guard is avoidImplicitSave — the operation
            // must never write the template it is executed on.
            avoidImplicitSave: true,
            canExecute: (t: OfficeTemplateEntity) => t.model != null && OfficeModelLogic.requiresExtraParameters(t.model)
                ? OfficeTemplateMessage._01RequiresExtraParameters.niceToString("OfficeModel", t.model.fullClassName)
                : null,
            execute: () => { throw new Error("UI-only operation"); },
        }).register();


        OfficeModelLogic.start(sb);

        // The two symbol registries. altea's SymbolLogic seeds every DECLARED symbol (Signum seeds only the
        // REGISTERED keys) — the same divergence @altea/altea-files documents for FileTypeSymbol: a declared
        // but unregistered transformer gets a row and throws on use, matching Signum's GetOrThrow.
        SymbolLogic.start(sb, OfficeTransformerSymbol);
        sb.include(OfficeTransformerSymbol).withQuery();
        SymbolLogic.start(sb, OfficeConverterSymbol);
        sb.include(OfficeConverterSymbol).withQuery();

        // Signum's three providers (the registry is public, so an app can add more).
        toDataTableProviders.set("Model", new ModelDataTableProvider());
        toDataTableProviders.set("UserQuery", new UserQueryDataTableProvider());
        toDataTableProviders.set("UserChart", new UserChartDataTableProvider());

        officeTemplatesLazy = sb.globalLazy(async () => {
            const rows = await ExecutionMode.global(() => tableQuery(OfficeTemplateEntity).toArray());
            return new Map(rows.map(r => [String(r.id), r]));
        }, { invalidateWith: [OfficeTemplateEntity] });

        templatesByQueryKey = sb.globalLazy(async () => {
            const byQuery = new Map<string, OfficeTemplateEntity[]>();
            for (const t of (await officeTemplatesLazy.value()).values()) {
                if (t.query == null)
                    continue;
                const list = byQuery.get(t.query.key);
                if (list != null)
                    list.push(t);
                else
                    byQuery.set(t.query.key, [t]);
            }
            return byQuery;
        }, { invalidateWith: [OfficeTemplateEntity] });

        // The user-asset (de)serializer, so a template can be exported / imported as XML.
        registerOfficeTemplateXml();

        // The @altea/altea-email seam: an EmailTemplate may attach a rendered report.
        OfficeAttachmentLogic.start(sb);

        if (sb.webBuilder != null)
            OfficeServer.start(sb.webBuilder);
    }

    // ---- registries ----------------------------------------------------------------------------

    /** Signum's RegisterTransformer. */
    export function registerTransformer(symbol: OfficeTransformerSymbol, transformer: OfficeTransformer): void {
        transformers.set(symbol.key, transformer);
    }

    /** Signum's RegisterConverter. */
    export function registerConverter(symbol: OfficeConverterSymbol, converter: OfficeConverter): void {
        converters.set(symbol.key, converter);
    }

    // ---- template lookup -----------------------------------------------------------------------

    /** Signum's GetFromCache. */
    export async function getFromCache(lite: Lite<OfficeTemplateEntity>): Promise<OfficeTemplateEntity> {
        const found = (await officeTemplatesLazy.value()).get(String(lite.id));
        if (found == null)
            throw new Error(`Office report template ${lite} not in cache`);
        return found;
    }

    /**
     * Signum's VisibleOnDictionary + IsVisible: where a template is offered.
     *
     * A template with no model is a single-entity report. A model-backed one is offered wherever its model
     * says: the two built-in models (a set of entities, a query result) are the ones that can be offered
     * from a search page, so they are keyed here by clean name.
     */
    const visibleOnByModelType = new Map<string, OfficeTemplateVisibleOn>([
        [MultiEntityModel.name, OfficeTemplateVisibleOn.Single | OfficeTemplateVisibleOn.Multiple],
        [QueryModel.name, OfficeTemplateVisibleOn.Single | OfficeTemplateVisibleOn.Multiple | OfficeTemplateVisibleOn.Query],
    ]);

    export function isVisible(t: OfficeTemplateEntity, visibleOn: OfficeTemplateVisibleOn): boolean {
        if (t.model == null)
            return visibleOn === OfficeTemplateVisibleOn.Single;

        // A model that generates its own default template is never offered as a choice.
        if (OfficeModelLogic.hasDefaultTemplateConstructor(t.model))
            return false;

        const modelTypeName = OfficeModelLogic.toType(t.model).name;
        const should = visibleOnByModelType.get(modelTypeName) ?? OfficeTemplateVisibleOn.Single;
        return (should & visibleOn) !== 0;
    }

    /** Signum's GetApplicableWordTemplates. */
    export async function getApplicableOfficeTemplates(
        queryName: QueryName, entity: Entity | null, visibleOn: OfficeTemplateVisibleOn,
    ): Promise<Lite<OfficeTemplateEntity>[]> {
        const key = queryKeyOf(queryName);
        const candidates = (await templatesByQueryKey.value()).get(key) ?? [];

        const out: Lite<OfficeTemplateEntity>[] = [];
        for (const t of candidates)
            if (isVisible(t, visibleOn) && isApplicable(t, entity))
                out.push(t.toLite());
        return out;
    }

    /** Signum's `WordTemplateEntity.IsApplicable` — the registered predicate, or "always". */
    export function isApplicable(t: OfficeTemplateEntity, entity: Entity | null): boolean {
        if (t.applicable == null)
            return true;
        try {
            return TemplatingLogic.isApplicable(t.applicable, entity);
        } catch (e) {
            throw new Error(
                `Error evaluating Applicable for OfficeTemplate '${t.name}' with entity '${entity}': ${(e as Error).message}`);
        }
    }

    // ---- validation ----------------------------------------------------------------------------

    /**
     * Signum's ValidateTemplate — parse the stored document and report the parser's errors. Runs on save
     * so a broken template is rejected at authoring time rather than at report time.
     */
    export async function validateTemplate(template: OfficeTemplateEntity): Promise<string | undefined> {
        if (template.template?.binaryFile == null || template.template.binaryFile.length === 0)
            return undefined;

        const queryName = template.query == null ? undefined : QueryLogic.tryGetQueryNameByKey(template.query.key);
        const modelType = template.model == null ? undefined : OfficeModelLogic.toType(template.model);

        let parser: OfficeTemplateParser | undefined;
        try {
            const package_ = OxmlPackage.load(template.template.binaryFile);
            parser = new OfficeTemplateParser(package_, template, queryName, modelType, prepareSpreadsheet);
            parser.parseDocument();
            parser.createNodes();
            parser.assertClean();
        } catch (e) {
            return [parser?.errors.map(x => x.message).join("\n"), `${(e as Error).name}: ${(e as Error).message}`]
                .filter(x => x != null && x !== "").join("\n");
        }

        return parser.errors.length === 0 ? undefined : parser.errors.map(e => e.message).join("\n");
    }

    /** Signum's ValidateFileName — the file name is itself a text template. */
    export function validateFileName(template: OfficeTemplateEntity): string | undefined {
        if (template.fileName == null)
            return undefined;

        const queryName = template.query == null ? undefined : QueryLogic.tryGetQueryNameByKey(template.query.key);
        const modelType = template.model == null ? undefined : OfficeModelLogic.toType(template.model);

        // altea's tryParse returns a single joined message, not a TemplateError list.
        const result = TextTemplateParser.tryParse(template.fileName, queryName, modelType);
        return result.errorMessage === "" ? undefined : result.errorMessage;
    }

    // ---- the report ----------------------------------------------------------------------------

    /** Signum's CreateReportFileContent(Lite<WordTemplateEntity>, …). */
    export async function createReportFileContentFromLite(
        lite: Lite<OfficeTemplateEntity>, entity?: Entity | null, model?: IOfficeModel, avoidConversion = false,
    ): Promise<OfficeFileContent> {
        return await createReportFileContent(await getFromCache(lite), entity, model, avoidConversion);
    }

    /** Signum's CreateReportFileContent(WordTemplateEntity, …). */
    export async function createReportFileContent(
        template: OfficeTemplateEntity, entity?: Entity | null, model?: IOfficeModel, avoidConversion = false,
    ): Promise<OfficeFileContent> {
        return await createReport(template, entity, model, avoidConversion, true);
    }

    /**
     * Signum's CreateReport — the whole pipeline:
     *
     *   parse (markers → nodes) → assertClean → execute the query → render the nodes → assertClean
     *   → finalize a spreadsheet → fix the document → render the file name → transform → save → convert
     *
     * `avoidConversion` skips the final converter (a PDF step) so the caller can get the raw Office file.
     */
    export async function createReport(
        template: OfficeTemplateEntity,
        entity?: Entity | null,
        model?: IOfficeModel,
        avoidConversion = false,
        wantFileName = false,
    ): Promise<OfficeFileContent> {
        using _prof = HeavyProfiler.log("CreateOfficeReport", () => template.name);

        if (!(await PermissionAuthLogic.isAuthorized(OfficeTemplatePermission.GenerateReport)))
            throw new UnauthorizedAccessException(
                `Not authorized for '${OfficeTemplatePermission.GenerateReport.key}'`);

        let targetEntity: Entity | null = null;
        if (template.model != null) {
            if (model == null)
                model = OfficeModelLogic.createModel(template.model, entity ?? null);
            else if (OfficeModelLogic.toType(template.model) !== model.constructor
                && OfficeModelLogic.toType(template.model).name !== model.constructor?.name)
                throw new Error(
                    `model should be a ${template.model.fullClassName} instead of ${model.constructor?.name}`);
        } else {
            if (entity == null)
                throw new Error("Model should be an Entity");
            targetEntity = entity;
        }

        if (template.template?.binaryFile == null || template.template.binaryFile.length === 0)
            throw new Error(`The OfficeTemplate '${template.name}' has no template document`);

        const run = async (): Promise<OfficeFileContent> => {
            const queryName = template.query == null ? undefined : QueryLogic.tryGetQueryNameByKey(template.query.key);
            const modelType = template.model == null ? undefined : OfficeModelLogic.toType(template.model);

            const package_ = OxmlPackage.load(template.template!.binaryFile!);

            const parser = new OfficeTemplateParser(package_, template, queryName, modelType, prepareSpreadsheet);
            parser.parseDocument();
            parser.createNodes();
            parser.assertClean();

            if (parser.errors.length > 0)
                throw new Error(
                    `Error in template ${template.name}:\n` + parser.errors.map(e => e.message).join("\n"));

            const fileNameBlock: TextBlockNode | undefined = wantFileName
                ? TextTemplateParser.parse(template.fileName, queryName, modelType)
                : undefined;

            const renderer = new OfficeTemplateRenderer(
                package_, queryName, template.culture, template, model, targetEntity, fileNameBlock);

            await renderer.executeQuery();
            await renderer.renderNodes();
            renderer.assertClean();

            // The xlsx row/formula fixup runs AFTER rendering: a row-level @foreach has by then inserted
            // its clones, and the rows it produced still carry the template row's indices.
            if (package_.kind === "spreadsheet")
                finalizeSpreadsheetPath(package_, parser.spreadsheetForeachBlocks);

            fixDocument(package_);

            const fileName = wantFileName ? renderer.renderFileName() : template.fileName;

            const ctx: OfficeContext = { template, entity: targetEntity, model };

            if (template.officeTransformer != null) {
                const transformer = transformers.get(template.officeTransformer.key);
                if (transformer == null)
                    throw new Error(`No transformer registered for '${template.officeTransformer.key}'`);
                await transformer(ctx, package_);
            }

            let bytes = package_.save();

            if (!avoidConversion && template.officeConverter != null) {
                const converter = converters.get(template.officeConverter.key);
                if (converter == null)
                    throw new Error(`No converter registered for '${template.officeConverter.key}'`);
                bytes = await converter(ctx, bytes);
            }

            return { fileName, bytes };
        };

        // Signum: `using (template.DisableAuthorization ? ExecutionMode.Global() : null)` — a system report
        // must be able to read rows the triggering user cannot.
        return template.disableAuthorization ? await ExecutionMode.global(run) : await run();
    }

}

/**
 * Signum's FixDocument: a Word table cell MUST contain at least one paragraph. Rendering can empty a cell
 * (a `@foreach` whose collection came back empty, an `@if` that took the other branch), and Word refuses
 * to open a document with a bare `<w:tc>`, so an empty paragraph is put back.
 */
function fixDocument(package_: OxmlPackage): void {
    for (const part of package_.parts) {
        if (!part.isXml)
            continue;
        for (const cell of part.document.root.descendantsNamed("w:tc")) {
            if (!cell.childElements.some(c => !(c instanceof OxmlElement && c.qualifiedName === "w:tcPr")))
                cell.appendChild(new OxmlElement("w:p"));
        }
    }
}

export { multiEntityOfficeModel, queryOfficeModel };
