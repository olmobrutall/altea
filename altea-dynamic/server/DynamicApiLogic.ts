import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/fluentOperations";
import "@altea/altea-eval/server/EvalLogic"; // FluentInclude.withEvals
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { WebBuilder } from "@altea/altea/server/webApi";
import { table } from "@altea/altea/server/table";
import { Administrator } from "@altea/altea/server/administrator";
import { Connector } from "@altea/altea/server/connection/connector";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { StartParameters } from "@altea/altea/data/utils/startParameters";
import { DynamicApiEntity, DynamicApiOperation } from "../data/DynamicApi";
import type { GeneratedModule } from "./DynamicCodeCompiler";

// Port of Signum.Dynamic's Controllers/DynamicApiLogic.cs — an HTTP endpoint written from the running
// application.
//
// Generated, as in Signum, and the reshaping is what the script IS:
//
//  - Signum generates `CodeGenController.cs`: a class deriving from `ControllerBase` whose BODY is the
//    author's script, so ASP.NET's routing discovers the `[HttpGet]` methods it declares. It also loads
//    that into a SECOND assembly (`CodeGenControllerAssembly`), because a controller assembly has to be
//    discoverable by MVC.
//  - altea has no controllers and no assembly discovery: a route is registered by calling
//    `ws.get(path, meta, handler)`. So the generated module is a function that REGISTERS routes, there is
//    no second compilation unit, and `IDynamicApiEvaluator.DummyEvaluate` — which existed only because a
//    controller has no entry point — is gone.
//
// The routes are registered when the HOST wires them (`DynamicApiLogic.registerRoutes(ws)`), which is why a
// changed script needs a restart, exactly as Signum's controller assembly is loaded once.

export namespace DynamicApiLogic {

    /** The generated module, once compiled — filled by DynamicLogic and read by `registerRoutes`. */
    export let generated: { start?: (ws: WebBuilder) => void } | undefined;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(DynamicApiEntity)
            .withUniqueIndex(e => [e.name])
            .withSave(DynamicApiOperation.Save)
            .withDelete(DynamicApiOperation.Delete)
            .withQuery()
            .withEvals()
            .withOperations(op => {
                op.withConstructFrom(DynamicApiEntity, DynamicApiOperation.Clone, {
                    construct: e => {
                        const result = DynamicApiEntity.create({ name: e.name + "_2" });
                        result.eval = e.eval;
                        return result;
                    },
                });
            });
    }

    /**
     * Register every dynamic endpoint on the app's route builder.
     *
     * The HOST calls this, after `AuthLogic.start` like every other module's routes — a dynamic endpoint
     * has no reason to be less protected than a declared one, and mounting before the auth middleware
     * would leave it unauthenticated (the ordering @altea/altea-files documents).
     */
    export function registerRoutes(ws: WebBuilder): void {
        generated?.start?.(ws);
    }

    /** Every row — tolerant of a missing table and the expected type-cache mismatch (see DynamicTypeLogic). */
    export async function getApis(): Promise<DynamicApiEntity[]> {
        const t = Connector.current().schema.tryTable(DynamicApiEntity);
        if (t == null || !await Administrator.existsTable(t))
            return [];

        const { result } = await StartParameters.withIgnoredDatabaseMismatches(async () =>
            await ExecutionMode.global(async () =>
                await table(DynamicApiEntity).toArray() as DynamicApiEntity[]));

        return result;
    }

    /**
     * NOT a starter line: the generated module takes a `WebBuilder`, not a `SchemaBuilder`, so it cannot
     * ride on `CodeGenStarter`. `DynamicLogic` hands the loaded module to `generated` instead, and the host
     * calls `registerRoutes`.
     */
    export function writeDynamicStarter(): string[] {
        return [];
    }

    export function getCodeFiles(apis: DynamicApiEntity[]): GeneratedModule[] {
        const enabled = apis.filter(a => !a.isDisabled);
        if (enabled.length === 0)
            return [];

        return [{
            fileName: "CodeGenController.ts",
            content: new DynamicApiCodeGenerator(enabled).getFileCode(),
        }];
    }
}

/** Signum's DynamicApiCodeGenerator. */
export class DynamicApiCodeGenerator {

    constructor(readonly apis: DynamicApiEntity[]) { }

    getFileCode(): string {
        const lines = [
            "export namespace CodeGenController {",
            "",
            "    export function start(ws: WebBuilder): void {",
        ];

        for (const api of this.apis) {
            // Each script is its own block, so two of them cannot collide over a local name — Signum
            // relies on them being separate members of one class for the same reason.
            lines.push(`        // ${api.name}`);
            lines.push("        {");
            lines.push(indent(api.eval.script.trim(), 12));
            lines.push("        }");
            lines.push("");
        }

        lines.push("    }");
        lines.push("}");

        return [
            "// GENERATED by @altea/altea-dynamic (DynamicApiLogic). Edited here, it is overwritten on the",
            "// next compile — change the DynamicApi rows instead.",
            "",
            `import type { WebBuilder } from "@altea/altea/server/webApi";`,
            "",
            ...lines,
            "",
        ].join("\n");
    }
}

function indent(text: string, spaces: number): string {
    const pad = " ".repeat(spaces);
    return text.split("\n").map(l => l.trim() === "" ? l : pad + l).join("\n");
}
