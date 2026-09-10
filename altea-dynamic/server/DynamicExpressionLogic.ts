import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/fluentOperations";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Administrator } from "@altea/altea/server/administrator";
import { Connector } from "@altea/altea/server/connection/connector";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { StartParameters } from "@altea/altea/data/utils/startParameters";
import { getLocation } from "@altea/altea/data/registration";
import {
    DynamicExpressionEntity, DynamicExpressionOperation, DynamicExpressionTranslation,
} from "../data/DynamicExpression";
import { DynamicCodeCompiler, type GeneratedModule } from "./DynamicCodeCompiler";

// Port of Signum.Dynamic's Expression/DynamicExpressionLogic.cs — the table plus the GENERATOR that turns
// each row into a registered query expression.
//
// Generated, not evaluated, and that is Signum's choice too: an expression must reach the LINQ provider as
// a TREE, and only the quote-transformer over real source produces one. What altea generates is the shape
// its own code uses for a registered expression — a `withQuoted` prototype member plus a
// `QueryLogic.expressions.register` — where Signum generates a static `Expression<Func<,>>` field, an
// `[ExpressionField]` extension method, and the same registration.
//
// altea divergences:
//  - **there is no generated prototype MEMBER**, only the registration. altea's own code writes a
//    `withQuoted` member beside `QueryLogic.expressions.register` so that APPLICATION code can call the
//    expression by name; a dynamic expression has no compile-time callers, so the member buys nothing and
//    costs a `declare module` block plus a `this`-vs-`e` mismatch (the stored body is written against
//    `e`, as in Signum, while a prototype member only has `this`). Registering the lambda directly is
//    also closer to Signum, whose generated extension method exists for the same reason altea's member
//    would — to give C# something to call.
//  - **there is no `CodeGenExpressionMessage` enum and no `ColumnDisplayName`.** Signum generates an enum
//    member per expression so its caption can be translated, then feeds it to `ColumnDisplayName`. altea
//    resolves a column's caption from the member's own `@niceName`, and there is no QueryDescription to
//    hang a display name on — so `translation` decides what `niceName` the registration passes, and
//    nothing is generated for it. `TranslateExpressionName` means "use the name", and the app translates
//    it like any other registered name; `ReuseTranslationOfReturnType` means "let the return type name
//    it", which is `QueryLogic.expressions.register`'s own default.
//  - `IDynamicExpressionEvaluator` is not ported (see the entity).
//  - Signum's `GetAlreadyTranslatedExpressions` / `GetFormattedExpressions` hooks into DynamicTypeLogic go
//    with the enum: format and unit are applied here, on the registration, not woven into another
//    generator's output.

export namespace DynamicExpressionLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(DynamicExpressionEntity)
            .withUniqueIndex(e => [e.fromType, e.name])
            .withSave(DynamicExpressionOperation.Save)
            .withDelete(DynamicExpressionOperation.Delete)
            .withQuery()
            .withOperations(op => {
                op.withConstructFrom(DynamicExpressionEntity, DynamicExpressionOperation.Clone, {
                    construct: e => DynamicExpressionEntity.create({
                        name: e.name + "_2",
                        returnType: e.returnType,
                        fromType: e.fromType,
                        body: e.body,
                    }),
                });
            });
    }

    /** Every row — tolerant of a missing table and of the expected type-cache mismatch (see DynamicTypeLogic). */
    export async function getExpressions(): Promise<DynamicExpressionEntity[]> {
        const t = Connector.current().schema.tryTable(DynamicExpressionEntity);
        if (t == null || !await Administrator.existsTable(t))
            return [];

        const { result } = await StartParameters.withIgnoredDatabaseMismatches(async () =>
            await ExecutionMode.global(async () =>
                await table(DynamicExpressionEntity).toArray() as DynamicExpressionEntity[]));

        return result;
    }

    export function writeDynamicStarter(expressions: DynamicExpressionEntity[]): string[] {
        return expressions.length === 0 ? [] : ["CodeGenExpressionStarter.start(sb);"];
    }

    /** ONE module holding every expression. */
    export function getCodeFiles(expressions: DynamicExpressionEntity[]): GeneratedModule[] {
        if (expressions.length === 0)
            return [];

        return [{
            fileName: "CodeGenExpressionStarter.ts",
            content: new DynamicExpressionCodeGenerator(expressions).getFileCode(),
        }];
    }
}

export class DynamicExpressionCodeGenerator {

    constructor(readonly expressions: DynamicExpressionEntity[]) { }

    getFileCode(): string {
        // Imports are discovered while writing, so the body comes first.
        const imports = new Map<string, Set<string>>();
        const typeOnly = new Set<string>();
        const add = (specifier: string, name: string, isType = false): void => {
            const set = imports.get(specifier) ?? new Set<string>();
            set.add(name);
            imports.set(specifier, set);
            if (isType)
                typeOnly.add(name);
        };

        add("@altea/altea/server/dynamicQuery/queryLogic", "QueryLogic");
        add("@altea/altea/server/schema", "SchemaBuilder", true);

        // Each owning type's module — the same `getLocation` lookup DynamicTypeLogic uses.
        const moduleOf = new Map<string, string>();
        for (const e of this.expressions) {
            const location = getLocation(e.fromType);
            if (location == null)
                continue; // an unknown type: the compiler will say so, with the line

            const specifier = DynamicCodeCompiler.specifierFor(location.packageName, location.fileName);
            moduleOf.set(e.fromType, specifier);
            add(specifier, e.fromType);
        }

        const blocks: string[] = [
            "export namespace CodeGenExpressionStarter {",
            "",
            "    export function start(sb: SchemaBuilder): void {",
        ];

        if (this.expressions.length === 0) {
            blocks.push("        // no dynamic expressions");
        } else {
            for (const e of this.expressions) {
                // The BODY is spliced inline, as the lambda's own expression — which is what makes the
                // transformer stamp a tree for it, and what the LINQ provider lowers. It cannot be factored
                // into a named function: a CALL inside a query lambda has no SQL translation.
                blocks.push(`        QueryLogic.expressions.register(${e.fromType}, `
                    + `(e: ${e.fromType}) => ${e.body}${registrationOptions(e)});`);
            }
        }

        blocks.push("    }");
        blocks.push("}");

        const importLines = [...imports.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([specifier, names]) => `import { `
                + [...names].sort().map(n => (typeOnly.has(n) ? "type " : "") + n).join(", ")
                + ` } from "${specifier}";`);

        return [
            "// GENERATED by @altea/altea-dynamic (DynamicExpressionLogic). Edited here, it is overwritten",
            "// on the next compile — change the DynamicExpression rows instead.",
            "",
            ...importLines,
            "",
            ...blocks,
            "",
        ].join("\n");
    }
}

/**
 * The `register` options a row asks for.
 *
 * `key` is always the expression's NAME, which is what makes the query token stable across a rename of the
 * owning type. `niceName` follows `translation`, and `format` / `unit` are Signum's `ForceFormat` /
 * `ForceUnit` — applied here rather than through a second generator's hooks.
 */
function registrationOptions(e: DynamicExpressionEntity): string {
    const parts = [`key: ${JSON.stringify(e.name)}`];

    if (e.translation === DynamicExpressionTranslation.TranslateExpressionName)
        parts.push(`niceName: () => ${JSON.stringify(e.name)}`);
    // ReuseTranslationOfReturnType: leave niceName unset — register's default names it after the RETURN
    // type, which is exactly what Signum's option means.
    // NoTranslation: the raw name, which is also what leaving it unset gives for a scalar.

    if (e.format != null && e.format !== "")
        parts.push(`format: ${JSON.stringify(e.format)}`);

    if (e.unit != null && e.unit !== "")
        parts.push(`unit: ${JSON.stringify(e.unit)}`);

    return `, { ${parts.join(", ")} }`;
}
