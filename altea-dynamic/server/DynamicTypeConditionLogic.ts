import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/fluentOperations";
import "@altea/altea-eval/server/EvalLogic"; // FluentInclude.withEvals
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Administrator } from "@altea/altea/server/administrator";
import { Connector } from "@altea/altea/server/connection/connector";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { StartParameters } from "@altea/altea/data/utils/startParameters";
import { getLocation } from "@altea/altea/data/registration";
import {
    DynamicTypeConditionEntity, DynamicTypeConditionOperation,
    DynamicTypeConditionSymbolEntity, DynamicTypeConditionSymbolOperation,
} from "../data/DynamicTypeCondition";
import { DynamicCodeCompiler, type GeneratedModule } from "./DynamicCodeCompiler";

// Port of Signum.Dynamic's Types/DynamicTypeConditionLogic.cs — the two tables plus the GENERATOR that
// registers each condition.
//
// Generated, as in Signum: the row carries an `EvalEmbedded` so the editor can compile and test the script,
// but the REAL registration is generated code, which is what gives the condition an expression TREE. That
// matters more here than in Signum: altea splices a registered TypeCondition into every query of the type
// as a WHERE, so a generated condition narrows a search, where a merely-compiled function could only guard
// a save. Signum's generator does the same thing (`TypeConditionLogic.Register<X>(sym, e => <script>)`) and
// the port follows it line for line.
//
// altea divergences:
//  - the generated symbol container is `export namespace CodeGenTypeCondition { export const X:
//    TypeConditionSymbol = init(); }`, and the quote-transformer fills in the key
//    `"CodeGenTypeCondition.X"` — byte-identical to what Signum's
//    `new TypeConditionSymbol(typeof(CodeGenTypeCondition), "X")` produces, so a migrated database's rule
//    rows still match.
//  - `TypeConditionLogic.register` lives in @altea/altea-auth (Signum keeps it in Signum.Authorization
//    too), so the generated module imports it from there.

export namespace DynamicTypeConditionLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(DynamicTypeConditionSymbolEntity)
            .withUniqueIndex(e => [e.name])
            .withSave(DynamicTypeConditionSymbolOperation.Save)
            .withQuery();

        sb.include(DynamicTypeConditionEntity)
            .withUniqueIndex(e => [e.symbolName, e.entityType])
            .withSave(DynamicTypeConditionOperation.Save)
            .withQuery()
            .withEvals()
            .withOperations((op) => {
                op.withConstructFrom(DynamicTypeConditionEntity, DynamicTypeConditionOperation.Clone, {
                    construct: e => {
                        const result = DynamicTypeConditionEntity.create({
                            symbolName: e.symbolName,
                            entityType: e.entityType,
                        });
                        result.eval = e.eval;
                        return result;
                    },
                });
            });
    }

    /** Every row — tolerant of a missing table and the expected type-cache mismatch (see DynamicTypeLogic). */
    export async function getTypeConditions(): Promise<DynamicTypeConditionEntity[]> {
        const t = Connector.current().schema.tryTable(DynamicTypeConditionEntity);
        if (t == null || !await Administrator.existsTable(t))
            return [];

        const { result } = await StartParameters.withIgnoredDatabaseMismatches(async () =>
            await ExecutionMode.global(async () =>
                await table(DynamicTypeConditionEntity).toArray() as DynamicTypeConditionEntity[]));

        return result;
    }

    export function writeDynamicStarter(conditions: DynamicTypeConditionEntity[]): string[] {
        return conditions.length === 0 ? [] : ["CodeGenTypeConditionStarter.start(sb);"];
    }

    export function getCodeFiles(conditions: DynamicTypeConditionEntity[]): GeneratedModule[] {
        if (conditions.length === 0)
            return [];

        return [{
            fileName: "CodeGenTypeCondition.ts",
            content: new DynamicTypeConditionCodeGenerator(conditions).getFileCode(),
        }];
    }
}

/** Signum's DynamicTypeConditionCodeGenerator. */
export class DynamicTypeConditionCodeGenerator {

    constructor(readonly conditions: DynamicTypeConditionEntity[]) { }

    getFileCode(): string {
        const imports = new Map<string, Set<string>>();
        const typeOnly = new Set<string>();
        const add = (specifier: string, name: string, isType = false): void => {
            const set = imports.get(specifier) ?? new Set<string>();
            set.add(name);
            imports.set(specifier, set);
            if (isType)
                typeOnly.add(name);
        };

        add("@altea/altea/data/reflection", "init");
        add("@altea/altea-auth/data/Rules", "TypeConditionSymbol", true);
        add("@altea/altea-auth/server/TypeConditionLogic", "TypeConditionLogic");
        add("@altea/altea/server/schema", "SchemaBuilder", true);

        for (const c of this.conditions) {
            const location = getLocation(c.entityType.className);
            if (location != null)
                add(DynamicCodeCompiler.specifierFor(location.packageName, location.fileName), c.entityType.className);
        }

        // Distinct symbol names: two conditions on DIFFERENT types may share one name, which is the point
        // of a symbol (Signum's generator groups the same way).
        const names = [...new Set(this.conditions.map(c => c.symbolName.name))].sort();

        const lines = [
            "export namespace CodeGenTypeCondition {",
            ...names.map(n => `    export const ${n}: TypeConditionSymbol = init();`),
            "}",
            "",
            "export namespace CodeGenTypeConditionStarter {",
            "",
            "    export function start(sb: SchemaBuilder): void {",
        ];

        for (const c of this.conditions) {
            // The script is spliced as the LAMBDA BODY, exactly as Signum splices it — which is what makes
            // the transformer stamp a tree for it and the condition usable as a query filter.
            const script = c.eval.script.trim();
            const body = script.includes(";") || script.startsWith("{") ? `{ ${script} }` : script;
            lines.push(`        TypeConditionLogic.register(${c.entityType.className}, `
                + `CodeGenTypeCondition.${c.symbolName.name}, e => ${body});`);
        }

        lines.push("    }");
        lines.push("}");

        const importLines = [...imports.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([specifier, ns]) => `import { `
                + [...ns].sort().map(n => (typeOnly.has(n) ? "type " : "") + n).join(", ")
                + ` } from "${specifier}";`);

        return [
            "// GENERATED by @altea/altea-dynamic (DynamicTypeConditionLogic). Edited here, it is",
            "// overwritten on the next compile — change the DynamicTypeCondition rows instead.",
            "",
            ...importLines,
            "",
            ...lines,
            "",
        ].join("\n");
    }
}
