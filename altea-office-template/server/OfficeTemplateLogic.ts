import "@altea/altea/server";
import { type FluentOperations } from "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/server/resetLazy";
import { cultureNameOf } from "@altea/altea/data/cultureInfoEntity";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { table as tableQuery } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { Entity } from "@altea/altea/data/entity";
import { FileEntity } from "@altea/altea-files/data/Files";
import { Lite } from "@altea/altea/data/lite";
import { getKey as queryKeyOf, type QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { TemplatingLogic } from "@altea/altea-templating/server/TemplatingLogic";
import { TextTemplateParser } from "@altea/altea-templating/server/TextTemplateParser";
import type { BlockNode as TextBlockNode } from "@altea/altea-templating/server/TextTemplateParser.Nodes";
import { MultiEntityModel, QueryModel } from "@altea/altea-templating/data/Templating";
import {
    OfficeConverterSymbol, OfficeModelEntity, OfficeTemplateEntity, OfficeTemplateMessage,
    OfficeTemplateOperation, OfficeTemplatePermission, OfficeTemplateVisibleOn, OfficeTransformerSymbol,
    officeTemplateValidations,
} from "../data/OfficeTemplate";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { OxmlPackage } from "./oxml/OxmlPackage";
import { OfficeTemplateParser } from "./OfficeTemplateParser";
import { OfficeTemplateRenderer } from "./OfficeTemplateRenderer";
import type { IOfficeModel } from "./OfficeTemplateParameters";
import { OfficeModelLogic, multiEntityOfficeModel, queryOfficeModel } from "./OfficeModelLogic";
import { toDataTableProviders, type OfficeContext } from "./TableBinder";
import { ModelDataTableProvider, UserChartDataTableProvider, UserQueryDataTableProvider } from "./DataTableProviders";
import { OxmlElement } from "./oxml/OxmlElement";
import { OfficeServer } from "./OfficeServer";
import { OfficeAttachmentLogic } from "./OfficeAttachmentLogic";
import { registerOfficeTemplateXml } from "./OfficeTemplateXml";
import { finalize as finalizeSpreadsheetPath, prepareSpreadsheet } from "./spreadsheet/SpreadsheetUtils";
import { OfficeTemplateTokenSync } from "./OfficeTemplateTokenSync";
import { TokenMigrationLogic } from "@altea/altea-user-assets/server/TokenMigrationLogic";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import type { Type, BaseEntity } from "@altea/altea/data/entity";
import { modelClassName, type ModelClass } from "@altea/altea-templating/server/ValueProviders";

// Port of Signum.Word's WordTemplateLogic.cs — see port/OfficeTemplate.md.
//
// Registration, the caches, and `createReport`: the one function that turns a stored template plus an
// entity into finished document bytes.
//
// The package is opened explicitly (`OxmlPackage.load` / mutate / `save()`), the culture is threaded
// through TemplateParameters rather than an ambient thread culture, and the whole path is ASYNC because
// query execution is. The two StaticPropertyValidations are DECLARED on the entity's fields and
// implemented here (`officeTemplateValidations`); the template one is async, which the core validator
// contract permits.
//
// The stored-token migration subscription is OfficeTemplateTokenSync, registered from start() below.

/** The produced file plus the name the template computed for it. */
export interface OfficeFileContent {
    readonly fileName: string;
    readonly bytes: Uint8Array;
}

/** Applied to the OPENED package after rendering, before saving. */
export type OfficeTransformer = (ctx: OfficeContext, package_: OxmlPackage) => void | Promise<void>;

/** Applied to the SAVED bytes — e.g. render to PDF. */
export type OfficeConverter = (ctx: OfficeContext, bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;

// NOT PORTED, by design: Signum ships three concrete helpers that are .NET-only and are, in its own
// design, pluggable add-ons rather than engine parts —
//
//   GdiBitmapConverter    System.Drawing (Windows-only since .NET 6)
//   ImageSharpConverter   the ImageSharp package
//   HtmlToWordConverter   the HtmlToOpenXml package — turns an HTML fragment into WordprocessingML
//
// The first two implement its IImageConverter, whose counterpart lives in
// OfficeImageReplacer.server.ts and is OPTIONAL there (raw bytes need no image library at all). The third
// has no altea counterpart yet: an app that needs HTML-into-Word can register an OfficeTransformerSymbol
// that does it, which is the extension point a converter plugs into.

export namespace OfficeTemplateLogic {
    export const transformers = new Map<string, OfficeTransformer>();
    export const converters = new Map<string, OfficeConverter>();

    export let officeTemplatesLazy: ResetLazy<Map<string, OfficeTemplateEntity>> = null!;
    export let templatesByQueryKey: ResetLazy<Map<string, OfficeTemplateEntity[]>> = null!;

    /** The app's culture resolver. */
    export let getCulture: ((entity: Entity | null) => string) | undefined;

    /**
     * @param options.attachments  Start the @altea/altea-email seam — the OfficeAttachment table, so an
     *   EmailTemplate can attach a rendered report. Default true. Signum has no caller for
     *   `WordAttachmentLogic.Start` at all: the app opts in, and Southwind does not
     *   (`WordTemplateLogic.Start(sb)` alone), so its database has the word_template tables and no
     *   word_attachment.
     */
    export function start(sb: SchemaBuilder, options?: { attachments?: boolean }): void {
        // Token migrations (@altea/altea-user-assets): repair this module's stored query tokens when a
        // schema rename invalidates them. GUARDED, because token migrations are opt-in per app — a host
        // that never starts them must not pay for a subscription that can never fire.
        if (TokenMigrationLogic.isStarted())
            OfficeTemplateTokenSync.register();

        PermissionLogic.registerPermissions(OfficeTemplatePermission.GenerateReport);

        TemplatingLogic.start(sb);

        sb.include(OfficeTemplateEntity)
            .withOperations(registerOfficeTemplateOperations)
            .withQuery();

        // The two property validations. They are DECLARED on the entity's fields (see
        // officeTemplateValidations) and implemented here, because both need server-only machinery. The
        // template one is async — the core validator contract permits that, and every server validation
        // path awaits it, so an unparseable template is rejected on SAVE.
        officeTemplateValidations.template = async t => (await validateTemplate(t)) ?? null;
        officeTemplateValidations.fileName = t => validateFileName(t) ?? null;

        OfficeModelLogic.start(sb);

        // The two symbol registries. SymbolLogic seeds every DECLARED symbol (Signum seeds only the
        // REGISTERED keys) — the same divergence @altea/altea-files documents for FileTypeSymbol: a declared
        // but unregistered transformer gets a row and throws on use.
        SymbolLogic.start(sb, OfficeTransformerSymbol);
        sb.include(OfficeTransformerSymbol).withQuery();
        SymbolLogic.start(sb, OfficeConverterSymbol);
        sb.include(OfficeConverterSymbol).withQuery();

        // The three built-in providers (the registry is public, so an app can add more).
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
        if (options?.attachments !== false)
            OfficeAttachmentLogic.start(sb);

        if (sb.webBuilder != null)
            OfficeServer.start(sb.webBuilder);
    }

    // ---- registries ----------------------------------------------------------------------------

    export function registerTransformer(symbol: OfficeTransformerSymbol, transformer: OfficeTransformer): void {
        transformers.set(symbol.key, transformer);
    }

    export function registerConverter(symbol: OfficeConverterSymbol, converter: OfficeConverter): void {
        converters.set(symbol.key, converter);
    }

    // ---- template lookup -----------------------------------------------------------------------

    export async function getFromCache(lite: Lite<OfficeTemplateEntity>): Promise<OfficeTemplateEntity> {
        const found = (await officeTemplatesLazy.value()).get(String(lite.id));
        if (found == null)
            throw new Error(`Office report template ${lite} not in cache`);
        return found;
    }

    /**
     * Where a template is offered.
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

    /**
     * Takes the query KEY, not the QueryName: the only caller is the
     * route, which has the key off the wire, and the key is all this ever used it for.
     */
    export async function getApplicableOfficeTemplates(
        queryKey: string, entity: Entity | null, visibleOn: OfficeTemplateVisibleOn,
    ): Promise<Lite<OfficeTemplateEntity>[]> {
        const candidates = (await templatesByQueryKey.value()).get(queryKey) ?? [];

        const out: Lite<OfficeTemplateEntity>[] = [];
        for (const t of candidates)
            if (isVisible(t, visibleOn) && isApplicable(t, entity))
                out.push(t.toLite());
        return out;
    }

    /** The stored script, or "always" when unset. */
    export function isApplicable(t: OfficeTemplateEntity, entity: Entity | null): boolean {
        if (t.applicable == null)
            return true;
        try {
            return t.applicable.algorithm(entity);
        } catch (e) {
            throw new Error(
                `Error evaluating Applicable for OfficeTemplate '${t.name}' with entity '${entity}': ${(e as Error).message}`);
        }
    }

    // ---- validation ----------------------------------------------------------------------------

    /**
     * Parse the stored document and report the parser's errors. Runs on save
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

    /** The file name is itself a text template. */
    export function validateFileName(template: OfficeTemplateEntity): string | undefined {
        if (template.fileName == null)
            return undefined;

        const queryName = template.query == null ? undefined : QueryLogic.tryGetQueryNameByKey(template.query.key);
        const modelType = template.model == null ? undefined : OfficeModelLogic.toType(template.model);

        // altea's tryParse returns a single joined message, not a TemplateError list.
        const result = TextTemplateParser.tryParse(template.fileName, queryName, modelType);
        return result.errorMessage === "" ? undefined : result.errorMessage;
    }

    // ---- a model's own template (Signum's WordModelLogic.GetDefaultTemplate / CreateReport) ------------

    /** Signum's `WordTemplateLogic.GetCultureInfo`: the culture a report about `entity` renders in. Unset ⇒
     *  the current UI culture. */
    export let getCultureInfo: ((entity: Entity | null) => string | undefined) | undefined;

    /**
     * The template a MODEL renders with: its single applicable template in the entity's culture (else the
     * parent culture, else the only one). A model with no template at all gets its default one, created in
     * its own transaction with authorization off — a system report must work for whoever triggered it.
     */
    export async function getDefaultTemplate(modelEntity: OfficeModelEntity, entity: Entity | null): Promise<OfficeTemplateEntity> {
        const templates = [...(await officeTemplatesLazy.value()).values()]
            .filter(t => t.model != null && String(t.model.id) === String(modelEntity.id));

        if (templates.length === 0 && OfficeModelLogic.hasDefaultTemplateConstructor(modelEntity))
            return await Transaction.forceNew(() => ExecutionMode.global(async () => {
                const template = await OfficeModelLogic.createDefaultTemplateInternal(modelEntity);
                await template.save();
                officeTemplatesLazy.reset();
                return template;
            }));

        const culture = getCultureInfo?.(entity) ?? CultureInfo.currentUICulture();
        const parent = CultureInfo.currentUICulture().split("-")[0];
        const candidates = templates.filter(t => isApplicable(t, entity));
        const inCulture = (name: string): OfficeTemplateEntity | undefined => {
            const found = candidates.filter(t => cultureNameOf(t.culture) === name);
            if (found.length > 1)
                throw new Error(`More than one active OfficeTemplate for OfficeModel ${modelEntity.className} in ${name} found`);
            return found[0];
        };

        const result = inCulture(culture) ?? inCulture(parent);
        if (result != null)
            return result;
        if (candidates.length !== 1)
            throw new Error(`${candidates.length === 0 ? "No" : "More than one"} active OfficeTemplate for ${modelEntity.className} in ${CultureInfo.currentUICulture()} or ${parent}`);
        return candidates[0];
    }

    /** Signum's `IWordModel.CreateReportFileContent()`: render a model with its own template. The model's
     *  CLASS is the registered model type. */
    export async function createReportFileContentFromModel(model: IOfficeModel, avoidConversion = false): Promise<OfficeFileContent> {
        const modelEntity = await OfficeModelLogic.toOfficeModelEntity(model.constructor as ModelClass);
        const template = await getDefaultTemplate(modelEntity, model.untypedEntity);
        return await createReportFileContent(template, null, model, avoidConversion);
    }

    // ---- the report ----------------------------------------------------------------------------

    export async function createReportFileContentFromLite(
        lite: Lite<OfficeTemplateEntity>, entity?: Entity | null, model?: IOfficeModel, avoidConversion = false,
    ): Promise<OfficeFileContent> {
        return await createReportFileContent(await getFromCache(lite), entity, model, avoidConversion);
    }

    export async function createReportFileContent(
        template: OfficeTemplateEntity, entity?: Entity | null, model?: IOfficeModel, avoidConversion = false,
    ): Promise<OfficeFileContent> {
        return await createReport(template, entity, model, avoidConversion, true);
    }

    /**
     * The whole pipeline:
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

        if (!(await PermissionLogic.isAuthorized(OfficeTemplatePermission.GenerateReport)))
            throw new UnauthorizedAccessException(
                `Not authorized for '${OfficeTemplatePermission.GenerateReport.key}'`);

        let targetEntity: Entity | null = null;
        if (template.model != null) {
            if (model == null)
                model = OfficeModelLogic.createModel(template.model, entity ?? null);
            else if (OfficeModelLogic.toType(template.model) !== model.constructor
                && OfficeModelLogic.toType(template.model).name !== model.constructor?.name)
                throw new Error(
                    `model should be a ${template.model.className} instead of ${model.constructor?.name}`);
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
                package_, queryName, cultureNameOf(template.culture) ?? CultureInfo.currentUICulture(),
                template, model, targetEntity, fileNameBlock);

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

        // A system report
        // must be able to read rows the triggering user cannot.
        return template.disableAuthorization ? await ExecutionMode.global(run) : await run();
    }

}

/**
 * A Word table cell MUST contain at least one paragraph. Rendering can empty a cell
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

// ---- OfficeTemplateEntity's operations --------------------------------------------------------

function registerOfficeTemplateOperations(op: FluentOperations<OfficeTemplateEntity>): void {
    op.withExecute(OfficeTemplateOperation.Save, {
    canBeNew: true,
    canBeModified: true,
    // The saver persists the template itself; what this body is for is
    // the SUPERSEDED document. A FileEntity is IMMUTABLE (FileLogic refuses a modified saved row), so
    // replacing a template's file makes a NEW row and the old one would leak. Signum reads the persisted
    // one and schedules `Transaction.PreRealCommit += oldFile.Delete()` — deferred because the template
    // still points at it until this save commits. The read projects the ID alone: the reference is a full
    // FileEntity here, so selecting it would drag the whole document back for nothing.
    execute: async (t: OfficeTemplateEntity) => {
        if (t.isNew)
            return;
        const oldId = await t.inDB(x => x.template.id);
        if (oldId == null || oldId === t.template?.id)
            return;
        Transaction.preRealCommit(async () => {
            await tableQuery(FileEntity).filter(f => f.id == oldId).executeDelete();
        });
    },
    });

    op.withDelete(OfficeTemplateOperation.Delete, {
    delete: async (t: OfficeTemplateEntity) => { await t.delete(); },
    });

    // Registered as an OPERATION so the UI can gate on CanExecute; the actual work is done
    // by the route (it must stream a file back), hence the "UI-only operation" throw.
    op.withExecute(OfficeTemplateOperation.CreateOfficeReport, {
    // The guard is avoidImplicitSave — the operation
    // must never write the template it is executed on.
    avoidImplicitSave: true,
    canExecute: (t: OfficeTemplateEntity) => t.model != null && OfficeModelLogic.requiresExtraParameters(t.model)
        ? OfficeTemplateMessage._01RequiresExtraParameters.niceToString("OfficeModel", t.model.className)
        : null,
    execute: () => { throw new Error("UI-only operation"); },
    });
}
