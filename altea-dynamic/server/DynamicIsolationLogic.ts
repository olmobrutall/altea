import chalk from "chalk";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Administrator } from "@altea/altea/server/administrator";
import { Connector } from "@altea/altea/server/connection/connector";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { SafeConsole } from "@altea/altea/server/safeConsole";
import { StartParameters } from "@altea/altea/data/utils/startParameters";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { DynamicBaseType, DynamicTypeEntity } from "../data/DynamicType";
import { DynamicTypeLogic } from "./DynamicTypeLogic";
import { DynamicIsolationMixin, isolationStrategies } from "../data/DynamicIsolation";
import type { GeneratedModule } from "./DynamicCodeCompiler";

// Port of Signum.Dynamic's Isolation/DynamicIsolationLogic.cs — one generated module registering each
// dynamic ENTITY type's isolation strategy.
//
// Generated, and it has to be: `Isolation.register` also DECLARES the IsolationMixin on the type, whose
// field becomes a column, so the call must land before the schema is built. That is why Signum runs its
// `CodeGenIsolationLogic` from `DynamicLogic.RegisterIsolations()` — a separate step, like RegisterMixins —
// and why altea runs it from `beforeSchema` alongside the mixin connections.
//
// altea divergences:
//  - **`IsolationLogic.Register<X>(strategy)` becomes `Isolation.register(X, strategy)`**, which lives in
//    the DATA layer here: altea inlines a mixin's fields onto its owner, so the CLIENT has to know a type
//    carries the mixin to deserialize `isolation` at all (the divergence altea-isolation documents).
//  - the strategy is a string LITERAL in the generated call, because altea's `IsolationStrategy` is a
//    string union — see data/DynamicIsolation on why the stored column holds the name.
//  - Signum generates the module unconditionally and every type gets a line (`None` when the mixin is
//    absent). This one generates NOTHING when no type asks for isolation, so an application that merely
//    references the module never gets a `CodeGenIsolationLogic.ts` at all — and, more to the point, never
//    has `Isolation.register` called, which would otherwise commit it to isolation's startup assertion
//    ("every table must declare a strategy"). Signum has the same assertion and the same hazard; it just
//    relies on the app not calling `RegisterIsolations`.

export namespace DynamicIsolationLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Nothing of its own: the mixin is declared by the app (see DynamicIsolationMixin.declare) and the
        // generator is registered by DynamicLogic. Signum's Start is likewise only two event hookups.
    }

    /** Nothing: the module runs from beforeSchema, not from the starter. */
    export function writeDynamicStarter(): string[] {
        return [];
    }

    /**
     *
     * Only the ENTITY types: an embedded / model / mixin has no table of its own, so there is nothing to
     * isolate (Signum filters the same way, `BaseType == DynamicBaseType.Entity`).
     */
    export async function getCodeFiles(types: DynamicTypeLogic.DynamicTypeInfo[]): Promise<GeneratedModule[]> {
        const entities = types.filter(t => t.baseType === DynamicBaseType.Entity);
        if (entities.length === 0)
            return [];

        const byName = await strategies();
        const withStrategy = entities
            .map(t => ({ typeName: t.typeName, strategy: byName.get(t.typeName) ?? "None" }))
            .filter(t => t.strategy !== "None");

        // See the header: no module at all when nothing asks for isolation.
        if (withStrategy.length === 0)
            return [];

        return [{
            fileName: "CodeGenIsolationLogic.ts",
            content: new DynamicIsolationLogicGenerator(withStrategy).getFileCode(),
        }];
    }

    /**
     * The strategy of each type, by type name — Signum's
     * `m.TryMixin<DynamicIsolationMixin>()?.IsolationStrategy ?? IsolationStrategy.None`.
     *
     * Its OWN read, and a TOLERANT one, which is the whole reason DynamicTypeLogic.getTypes projects
     * instead of returning entities: the mixin's column does not exist until the `sync` that follows an
     * app declaring the mixin, and a failure here must not stop the types from being generated. An
     * unreadable strategy simply means "None" — the type is generated, just not isolated, and the next
     * boot after the sync gets it right.
     */
    export async function strategies(): Promise<Map<string, string>> {
        const result = new Map<string, string>();

        if (!MixinDeclarations.isDeclared(DynamicTypeEntity, DynamicIsolationMixin))
            return result;

        const t = Connector.current().schema.tryTable(DynamicTypeEntity);
        if (t == null || !await Administrator.existsTable(t))
            return result;

        try {
            const { result: rows } = await StartParameters.withIgnoredDatabaseMismatches(async () =>
                await ExecutionMode.global(async () =>
                    await table(DynamicTypeEntity)
                        .map(dt => ({
                            typeName: dt.typeName,
                            strategy: dt.mixin(DynamicIsolationMixin).isolationStrategy,
                        }))
                        .toArray()));

            for (const row of rows)
                result.set(row.typeName, normalize(row.strategy));
        } catch (e) {
            // The column is not there yet (the sync that adds it has not run). Not a fault: say so and
            // carry on, rather than failing the whole generation and leaving the schema without its
            // dynamic types — which is what would then script them as DROPs.
            SafeConsole.writeLineColor(chalk.yellow,
                "[dynamic] isolation strategies are not readable yet, treating every type as None: "
                + (e instanceof Error ? e.message : String(e)));
        }

        return result;
    }

    /**
     * Anything that is not one of the three strategies means "None".
     *
     * Not paranoia: a mixin column ADDED to a table with existing rows gets the database default (an empty
     * string), because a field initializer runs in the `create` FACTORY and never for a row that already
     * exists — the trap @altea/altea's operation-log mixin documents. Left unnormalised that generated
     * `Isolation.register(X, "")`, which does not compile.
     */
    function normalize(value: string | null | undefined): string {
        return value != null && isolationStrategies.includes(value as never) ? value : "None";
    }
}

export class DynamicIsolationLogicGenerator {

    constructor(readonly entities: Array<{ typeName: string; strategy: string }>) { }

    getFileCode(): string {
        const imports = new Map<string, Set<string>>();
        const add = (specifier: string, name: string): void => {
            const set = imports.get(specifier) ?? new Set<string>();
            set.add(name);
            imports.set(specifier, set);
        };

        add("@altea/altea-isolation/data/Isolation", "Isolation");

        const lines = [
            "export namespace CodeGenIsolationLogic {",
            "",
            "    export function start(): void {",
        ];

        for (const t of this.entities) {
            // The type's own module is a SIBLING generated file (DynamicTypeLogic writes `<TypeName>.ts`).
            add("./" + t.typeName, t.typeName + "Entity");
            lines.push(`        Isolation.register(${t.typeName}Entity, ${JSON.stringify(t.strategy)});`);
        }

        lines.push("    }");
        lines.push("}");

        const importLines = [...imports.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([specifier, names]) => `import { ${[...names].sort().join(", ")} } from "${specifier}";`);

        return [
            "// GENERATED by @altea/altea-dynamic (DynamicIsolationLogic). Edited here, it is overwritten on",
            "// the next compile — change the DynamicType rows' isolation strategy instead.",
            "",
            ...importLines,
            "",
            ...lines,
            "",
        ].join("\n");
    }
}
