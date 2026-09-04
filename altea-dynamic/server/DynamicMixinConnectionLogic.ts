import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/fluentOperations";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Administrator } from "@altea/altea/server/administrator";
import { Connector } from "@altea/altea/server/connection/connector";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { StartParameters } from "@altea/altea/data/utils/startParameters";
import { getLocation } from "@altea/altea/data/registration";
import { DynamicMixinConnectionEntity, DynamicMixinConnectionOperation } from "../data/DynamicMixinConnection";
import { DynamicCodeCompiler, type GeneratedModule } from "./DynamicCodeCompiler";

// Port of Signum.Dynamic's Mixins/DynamicMixinConnectionLogic.cs — "attach this mixin to this type",
// generated as a module that declares it before the schema is built.
//
// Generated, and it must be: a mixin's fields become COLUMNS on the owner's table, so the declaration has
// to happen while the schema is being built. That is why Signum runs its `CodeGenMixinLogic` from
// `RegisterMixins` (before `Schema.Initialize`) and why a new connection needs a restart and then a `sync`
// — the message `TheEntityShouldBeSynchronizedToApplyMixins` (data/DynamicType) says exactly that.
//
// altea divergences:
//  - `MixinDeclarations.register(Target, Mixin)` takes both types as CONSTRUCTORS, so the generated module
//    imports each — resolved through `getLocation`, as in every other generator here. Signum passes
//    `typeof(X)` and relies on its `using` list.
//  - altea INLINES a mixin's fields onto the owner's table (there is no mixin step in a PropertyRoute —
//    see SchemaBuilder's note), so a connection adds columns to the owner rather than a separate table.
//    Signum's shape is the same for a mixin; what differs is only how a route names it.

export namespace DynamicMixinConnectionLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(DynamicMixinConnectionEntity)
            .withUniqueIndex(e => [e.entityType, e.mixinName])
            .withSave(DynamicMixinConnectionOperation.Save)
            .withDelete(DynamicMixinConnectionOperation.Delete)
            .withQuery();
    }

    /** Every row — tolerant of a missing table and the expected type-cache mismatch (see DynamicTypeLogic). */
    export async function getConnections(): Promise<DynamicMixinConnectionEntity[]> {
        const t = Connector.current().schema.tryTable(DynamicMixinConnectionEntity);
        if (t == null || !await Administrator.existsTable(t))
            return [];

        const { result } = await StartParameters.withIgnoredDatabaseMismatches(async () =>
            await ExecutionMode.global(async () =>
                await table(DynamicMixinConnectionEntity).toArray() as DynamicMixinConnectionEntity[]));

        return result;
    }

    /**
     * NOT a starter line.
     *
     * Signum calls `CodeGenMixinLogic.Start()` from `DynamicLogic.RegisterMixins`, separately from
     * `StartDynamicModules`, because a mixin must be declared BEFORE any type that carries it is included.
     * altea keeps that ordering: DynamicLogic runs this module's `start` from `beforeSchema`, not from the
     * generated starter.
     */
    export function writeDynamicStarter(): string[] {
        return [];
    }

    export function getCodeFiles(connections: DynamicMixinConnectionEntity[]): GeneratedModule[] {
        if (connections.length === 0)
            return [];

        return [{
            fileName: "CodeGenMixinLogic.ts",
            content: new DynamicMixinConnectionCodeGenerator(connections).getFileCode(),
        }];
    }
}

/** Signum's mixin generator (inline in its logic file). */
export class DynamicMixinConnectionCodeGenerator {

    constructor(readonly connections: DynamicMixinConnectionEntity[]) { }

    getFileCode(): string {
        const imports = new Map<string, Set<string>>();
        const add = (specifier: string, name: string): void => {
            const set = imports.get(specifier) ?? new Set<string>();
            set.add(name);
            imports.set(specifier, set);
        };

        add("@altea/altea/data/mixinDeclarations", "MixinDeclarations");

        const lines = [
            "export namespace CodeGenMixinLogic {",
            "",
            "    export function start(): void {",
        ];

        for (const c of this.connections) {
            const target = c.entityType.entity?.className ?? c.entityType.toString();
            const mixin = c.mixinName;

            for (const name of [target, mixin]) {
                const location = getLocation(name);
                if (location != null)
                    add(DynamicCodeCompiler.specifierFor(location.packageName, location.fileName), name);
            }

            lines.push(`        MixinDeclarations.register(${target}, ${mixin});`);
        }

        lines.push("    }");
        lines.push("}");

        const importLines = [...imports.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([specifier, names]) => `import { ${[...names].sort().join(", ")} } from "${specifier}";`);

        return [
            "// GENERATED by @altea/altea-dynamic (DynamicMixinConnectionLogic). Edited here, it is",
            "// overwritten on the next compile — change the DynamicMixinConnection rows instead.",
            "",
            ...importLines,
            "",
            ...lines,
            "",
        ].join("\n");
    }
}
