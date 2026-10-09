import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import "@altea/altea/server/fluentOperations"; // FluentInclude.withOperations
import ts from "typescript";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Administrator } from "@altea/altea/server/administrator";
import { Connector } from "@altea/altea/server/connection/connector";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { StartParameters } from "@altea/altea/data/utils/startParameters";
import { getLocation } from "@altea/altea/data/registration";
import { globalValidators, type FieldInfo } from "@altea/altea/data/reflection";
import { EvalLogic } from "@altea/altea-eval/server/EvalLogic";
import { EvalCompiler } from "@altea/altea-eval/server/EvalCompiler";
import {
    DynamicTypeEntity, DynamicTypeOperation, DynamicBaseType, DynamicTypeMessage, DynamicTypeImportsProfile, typeNameWithSuffix, logicName,
} from "../data/DynamicType";
import { DynamicCodeCompiler, type CompileOptions, type GeneratedModule } from "./DynamicCodeCompiler";

// A DynamicType row IS its source (see data/DynamicType): `<Name>.ts` is the data module verbatim and
// `<Name>Logic.ts` the server module. What this adds around them:
//
//  - the RULES that need a parser (one real entity, named after the row; the logic namespace), checked on
//    save through `globalValidators` so they land on the field like any other validation;
//  - the IMPORTS: the source names what it uses and the compile writes the imports, resolving each name
//    through the "DynamicType" import profile — the eval configuration plus the decorators and operation
//    symbols a type declaration needs. The editor runs the same pass over the same profile.

export namespace DynamicTypeLogic {


    /** What a server module needs in scope that no NAME brings in: the fluent `include` surface. */
    const serverModulePrelude = [
        `import "@altea/altea/server/fluentOperations";`,
        `import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";`,
    ];

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(DynamicTypeEntity)
            .withUniqueIndex(e => [e.typeName])
            .withQuery()
            .withOperations(op => {
                op.withConstruct(DynamicTypeOperation.Create, {
                    construct: () => DynamicTypeEntity.create({ baseType: DynamicBaseType.Entity }),
                });

                op.withConstructFrom(DynamicTypeEntity, DynamicTypeOperation.Clone, {
                    // The NAME is left empty (two types cannot share one); the source is copied verbatim.
                    construct: e => DynamicTypeEntity.create({ baseType: e.baseType, dataCode: e.dataCode, serverCode: e.serverCode }),
                });

                // `canBeNew`: the first save of a type is the point.
                op.withSave(DynamicTypeOperation.Save, { canBeNew: true });
                op.withDelete(DynamicTypeOperation.Delete);
            });

        globalValidators.push(validateSource);

        EvalLogic.registerImportsProfile(DynamicTypeImportsProfile, base => base
            .lazy("@altea/altea/data/decorators", "*")
            .lazy("@altea/altea/data/operations", "*")
            .lazy("@altea/altea/server/schema", ["SchemaBuilder"])
            .eager("@altea/altea/server/fluentOperations", [])
            .eager("@altea/altea/server/dynamicQuery/fluentIncludeQuery", []));
    }

    // ---- The source rules ------------------------------------------------------------------------------

    function validateSource(entity: unknown, fi: FieldInfo): string | null {
        if (!(entity instanceof DynamicTypeEntity) || isBlank(entity.typeName))
            return null;

        if (fi.name === "dataCode")
            return isBlank(entity.dataCode) ? null : dataModuleError(entity);

        if (fi.name === "serverCode")
            return serverModuleError(entity);

        return null;
    }

    /**
     * The data module declares the exported class `<Name><Suffix>`; for an ENTITY type that class is the
     * module's ONE real entity (an `@entity` that is not a part) — `@part` rows, embeddeds, models and enums
     * may sit beside it in any number. Any other base type declares no real entity at all.
     */
    function dataModuleError(e: DynamicTypeEntity): string | null {
        const source = ts.createSourceFile("data.ts", e.dataCode, ts.ScriptTarget.Latest, true);
        const classes = source.statements.filter(ts.isClassDeclaration);

        const expected = typeNameWithSuffix(e.typeName, e.baseType);
        const main = classes.find(c => c.name?.text === expected);
        if (main == null || !isExported(main))
            return DynamicTypeMessage.TheDataModuleMustDeclare0.niceToString(expected);

        const entities = classes.filter(isRealEntity);
        if (e.baseType !== DynamicBaseType.Entity)
            return entities.length === 0 ? null
                : DynamicTypeMessage.TheDataModuleDeclaresMoreThanOneEntity0.niceToString(names(entities));

        if (!entities.includes(main))
            return DynamicTypeMessage._0MustBeAnEntity.niceToString(expected);

        return entities.length === 1 ? null
            : DynamicTypeMessage.TheDataModuleDeclaresMoreThanOneEntity0.niceToString(names(entities));
    }

    /** `export namespace <Name>Logic { export function start(sb) … }` — what the generated starter calls. */
    function serverModuleError(e: DynamicTypeEntity): string | null {
        if (isBlank(e.serverCode))
            return e.baseType === DynamicBaseType.Entity ? DynamicTypeMessage.AnEntityNeedsAServerModule.niceToString() : null;

        const name = logicName(e.typeName);
        const source = ts.createSourceFile("server.ts", e.serverCode!, ts.ScriptTarget.Latest, true);
        const ns = source.statements.find((s): s is ts.ModuleDeclaration =>
            ts.isModuleDeclaration(s) && s.name.getText(source) === name && isExported(s));
        const hasStart = ns?.body != null && ts.isModuleBlock(ns.body) && ns.body.statements.some(s =>
            ts.isFunctionDeclaration(s) && s.name?.text === "start" && isExported(s));

        return hasStart ? null : DynamicTypeMessage.TheServerModuleMustExport0.niceToString(name);
    }

    function isExported(node: ts.Node): boolean {
        return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    }

    /** `@entity(…)` whose kind is not a part, and no `@part`. */
    function isRealEntity(c: ts.ClassDeclaration): boolean {
        let isEntity = false;
        for (const d of ts.getDecorators(c) ?? []) {
            const call = ts.isCallExpression(d.expression) ? d.expression : undefined;
            const callee = call?.expression ?? d.expression;
            const name = ts.isIdentifier(callee) ? callee.text : undefined;
            if (name === "part")
                return false;
            if (name === "entity") {
                const kind = call?.arguments[0];
                if (kind != null && ts.isStringLiteral(kind) && (kind.text === "Part" || kind.text === "SharedPart"))
                    return false;
                isEntity = true;
            }
        }
        return isEntity;
    }

    function names(classes: readonly ts.ClassDeclaration[]): string {
        return classes.map(c => c.name?.text ?? "?").join(", ");
    }

    // ---- Reading the rows ------------------------------------------------------------------------------

    /**
     * One DynamicType row, as the code-gen reads it.
     *
     * A PROJECTION, not the entity, and that is load-bearing: an optional MIXIN may add columns to
     * `dynamic_type` (DynamicIsolationMixin does), and those do not exist until the `sync` after the app
     * declares it. Reading the whole entity would fail at the exact moment the types are needed to BUILD the
     * schema — and a schema built without them scripts every dynamic table as a DROP.
     */
    export interface DynamicTypeInfo {
        typeName: string;
        baseType: DynamicBaseType;
        dataCode: string;
        serverCode: string | null;
    }

    /**
     * Every DynamicType row, read with `ExecutionMode.global()` and tolerating a missing table and a
     * type-cache MISMATCH: this runs while the schema is being BUILT, before the dynamic types are in it, so
     * the database's `type` rows for them look "Extra" — `withIgnoredDatabaseMismatches` is the seam for
     * exactly that. The real check still runs at `schema.initialize()`.
     */
    export async function getTypes(): Promise<DynamicTypeInfo[]> {
        // The TABLE, not the type: on the very first boot of a fresh database there is none.
        const t = Connector.current().schema.tryTable(DynamicTypeEntity);
        if (t == null || !await Administrator.existsTable(t))
            return [];

        const { result } = await StartParameters.withIgnoredDatabaseMismatches(async () =>
            await ExecutionMode.global(async () =>
                await table(DynamicTypeEntity)
                    .map(dt => ({
                        typeName: dt.typeName,
                        baseType: dt.baseType,
                        dataCode: dt.dataCode,
                        serverCode: dt.serverCode,
                    }))
                    .toArray()));

        return result;
    }

    // ---- The code files ------------------------------------------------------------------------------

    /** The lines the generated starter calls: one per type with a server module. */
    export function writeDynamicStarter(types: DynamicTypeInfo[]): string[] {
        return types.filter(t => !isBlank(t.serverCode)).map(t => `${logicName(t.typeName)}.start(sb);`);
    }

    /** The data module verbatim, and the server module after the imports no name brings in. */
    export function getCodeFiles(types: DynamicTypeInfo[]): GeneratedModule[] {
        return types.flatMap(t => [
            { fileName: t.typeName + ".ts", content: t.dataCode, client: true },
            ...isBlank(t.serverCode) ? [] : [{
                fileName: logicName(t.typeName) + ".ts",
                content: [...serverModulePrelude, "", t.serverCode!].join("\n"),
            }],
        ]);
    }

    /**
     * How the compile resolves a name the source uses without importing it: another dynamic type's export
     * (its data module, by relative path), else the import profile — a framework module by its package
     * specifier, an application type by where reflection says it was declared.
     */
    export function compileOptions(types: DynamicTypeInfo[]): CompileOptions {
        const own = new Map<string, string>();
        for (const t of types)
            for (const name of exportedNames(t.dataCode))
                own.set(name, "./" + t.typeName);

        const profile = profileNames();

        return {
            implicitImports: (name, fileName) => {
                const local = own.get(name);
                if (local != null)
                    return local === "./" + fileName.replace(/\.ts$/, "") ? undefined : local;

                const specifier = profile.get(name);
                if (specifier == null)
                    return undefined;
                if (!specifier.startsWith("."))
                    return specifier;

                // The profile names an application module relative to the APP; the code-gen directory
                // reaches it by its own path.
                const location = getLocation(name);
                return location == null ? undefined : DynamicCodeCompiler.specifierFor(location.packageName, location.fileName);
            },
        };
    }

    /** Identifier -> specifier for the whole profile: its lazy names and the names its eager lines import. */
    function profileNames(): Map<string, string> {
        const result = new Map<string, string>();
        if (!EvalLogic.isStarted())
            return result;

        const configuration = EvalCompiler.clientConfiguration(EvalLogic.importsFor(DynamicTypeImportsProfile));
        for (const line of configuration.eagerLines) {
            const match = /^import \{ (.*) \} from "([^"]+)";$/.exec(line);
            if (match != null)
                for (const name of match[1].split(",").map(n => n.trim()))
                    result.set(name, match[2]);
        }
        for (const [name, specifier] of configuration.names)
            if (!result.has(name))
                result.set(name, specifier);
        return result;
    }

    /** The names a module exports at its top level. */
    export function exportedNames(code: string): string[] {
        const source = ts.createSourceFile("module.ts", code, ts.ScriptTarget.Latest, true);
        const result: string[] = [];
        for (const s of source.statements) {
            if (!isExported(s))
                continue;
            if ((ts.isClassDeclaration(s) || ts.isEnumDeclaration(s) || ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s)
                || ts.isTypeAliasDeclaration(s)) && s.name != null)
                result.push(s.name.text);
            else if (ts.isModuleDeclaration(s))
                result.push(s.name.getText(source));
            else if (ts.isVariableStatement(s))
                for (const d of s.declarationList.declarations)
                    if (ts.isIdentifier(d.name))
                        result.push(d.name.text);
        }
        return result;
    }
}

function isBlank(s: string | null | undefined): boolean {
    return s == null || s.trim() === "";
}
