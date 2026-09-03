import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { Schema } from "@altea/altea/server/schema/schema";
import { Connector } from "@altea/altea/server/connection/connector";
import { Administrator } from "@altea/altea/server/administrator";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { ExceptionEntity } from "@altea/altea/data/exception";
import { SafeConsole } from "@altea/altea/server/safeConsole";
import chalk from "chalk";
import { DynamicPanelPermission } from "../data/DynamicPanel";
import { DynamicViewLogic } from "./DynamicViewLogic.server";
import { DynamicCSSOverrideLogic } from "./DynamicCSSOverrideLogic.server";
import { DynamicSqlMigrationLogic } from "./DynamicSqlMigrationLogic.server";
import { DynamicTypeLogic } from "./DynamicTypeLogic.server";
import { DynamicCodeCompiler, type GeneratedModule, type DynamicCompilationResult } from "./DynamicCodeCompiler.server";

// Port of Signum.Dynamic's DynamicLogic.cs — but only its ROLE as the module's entry point. The BODY of
// Signum's DynamicLogic does not port at all, and that is the single most important thing to know about this
// package, so it is written out here rather than buried in a commit message.
//
// ---- What Signum.Dynamic is, and why it splits in two --------------------------------------------------
//
// Signum.Dynamic lets an administrator define parts of the application from the running app itself. Its
// features fall into two groups, divided by ONE question: does the feature need a COMPILER?
//
//   INTERPRETED — ported, and this is the whole package:
//     DynamicView / DynamicViewOverride / DynamicViewSelector  a view is a JSON node TREE plus small
//                                                              JavaScript snippets; the client interprets
//                                                              it (client/View/NodeUtils + Nodes). Nothing
//                                                              is compiled, so it ports as-is.
//     DynamicCSSOverride                                       a stylesheet, as text.
//     DynamicSqlMigration                                      a schema-diff script, as text.
//
//   COMPILED — NOT ported:
//     DynamicType, DynamicExpression, DynamicValidation, DynamicApi, DynamicTypeCondition,
//     DynamicMixinConnection, DynamicIsolation
//
// Every member of the second group works the same way: it GENERATES C# source into a `CodeGen` directory,
// compiles it with Roslyn (`Microsoft.CodeAnalysis.CSharp`, via Signum.Eval) into `CodeGenAssembly.dll`,
// loads that assembly, and RESTARTS the application server so the new types take part in the schema. There
// is no counterpart for that here, and the gap is not the compiler itself — TypeScript has one, and altea
// already drives it (`tspc -b`). It is that altea's entity model is stamped onto each class at BUILD time by
// the quote-transformer, so a type invented at runtime would need the transformer to run over generated
// source, the process to restart, and the schema to be synchronized — a design project, not a port. If it is
// ever wanted, it belongs in its own package on top of this one.
//
// Consequently Signum.Eval does not port either (it IS the Roslyn host), and two of its pieces that this
// package would otherwise use are re-homed:
//   - `EvalPanelPermission.ViewDynamicPanel` becomes `DynamicPanelPermission.ViewDynamicPanel` (data/DynamicPanel).
//   - `EvalClient.Options.registerDynamicPanelSearch`, the registry behind the panel's search box, becomes
//     `DynamicClient.registerDynamicPanelSearch` (client/DynamicClient).
// And `DynamicPanelPermission.RestartApplication` is dropped: there is no compilation step to restart for.
export namespace DynamicLogic {

    /** Signum's `CodeGenNamespace` / `CodeGenDirectory`. There is no namespace here — a module is the unit. */
    export const codeGenStarterFile = "CodeGenStarter.ts";

    /**
     * Signum's `CodeGenError`: the ONE compilation failure the whole startup carries.
     *
     * Kept as a field rather than thrown, because a server that cannot compile its dynamic code must still
     * BOOT — otherwise the only way to fix a bad definition would be to edit the database by hand. Every
     * step below checks it first, exactly as Signum's do, so one failure stops the rest without unwinding.
     */
    export let codeGenError: Error | undefined;

    /** The generated modules the last compile wrote — what the panel lists. */
    export let lastCompilation: DynamicCompilationResult | undefined;

    /** Signum's `GetCodeFiles` event: every contributor of generated modules. */
    export const codeFileGenerators: Array<() => Promise<GeneratedModule[]>> = [];

    /** Signum's `OnWriteDynamicStarter`: the lines each contributor wants in the generated starter. */
    export const starterWriters: Array<() => Promise<string[]>> = [];

    /** Signum's `OnApplicationServerRestarted`. */
    export let onApplicationServerRestarted: (() => void) | undefined;

    export function start(sb: SchemaBuilder, options?: {
        views?: boolean;
        cssOverrides?: boolean;
        sqlMigrations?: boolean;
        /** The COMPILED half — off unless the app configured DynamicCodeCompiler (see compileDynamicCode). */
        types?: boolean;
        expressions?: boolean;
        validations?: boolean;
        typeConditions?: boolean;
        mixinConnections?: boolean;
        apis?: boolean;
    }): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum's `PermissionLogic.RegisterPermissions(…)`: in altea a symbol is seeded merely by being
        // declared and imported, so referencing it here is what registers it.
        void DynamicPanelPermission.ViewDynamicPanel;
        void DynamicPanelPermission.RestartApplication;

        // Each sub-module is opt-in, because each is independently useful and they share nothing but the
        // panel. Signum starts them from the application's Starter one by one; the flags keep that choice
        // while giving the app a single call.
        if (options?.views ?? true)
            DynamicViewLogic.start(sb);

        if (options?.cssOverrides ?? true)
            DynamicCSSOverrideLogic.start(sb);

        if (options?.sqlMigrations ?? true)
            DynamicSqlMigrationLogic.start(sb);

        if (options?.types ?? true) {
            DynamicTypeLogic.start(sb);
            codeFileGenerators.push(async () => DynamicTypeLogic.getCodeFiles(await DynamicTypeLogic.getTypes()));
            starterWriters.push(async () => DynamicTypeLogic.writeDynamicStarter(await DynamicTypeLogic.getTypes()));
        }

    }

    /**
     * Signum's `CompileDynamicCode` — generate every contributor's modules, compile them, load them.
     *
     * Called by the APP's Starter between `DynamicLogic.start` and `schema.initialize()`: the generated
     * types must exist before the schema is built, because a schema is built once. That ordering is
     * Signum's too, and it is why a new or changed type needs a RESTART to take part, and a `sync` before
     * its table exists.
     *
     * A failure is recorded, not thrown — see codeGenError.
     */
    export async function compileDynamicCode(): Promise<void> {
        if (!DynamicCodeCompiler.isConfigured())
            return; // the app did not opt into the compiled half

        try {
            const modules: GeneratedModule[] = [];
            for (const generator of codeFileGenerators)
                modules.push(...await generator());

            // Signum generates a `CodeGenStarter` and finds it by searching the assembly's types; here it
            // is one more generated module whose exports are handed straight back.
            const starterLines: string[] = [];
            for (const writer of starterWriters)
                starterLines.push(...await writer());

            modules.push({ fileName: codeGenStarterFile, content: starterCode(modules, starterLines) });

            const result = await DynamicCodeCompiler.compileAndLoad(modules);
            lastCompilation = result;

            if (result.errors.length > 0)
                codeGenError = new Error("Dynamic code did not compile:\n"
                    + result.errors.map(e => `  ${e.fileName}(${e.line}): ${e.message}`).join("\n"));
        } catch (e) {
            codeGenError = e instanceof Error ? e : new Error(String(e));
        }
    }

    /** The generated `CodeGenStarter` module: import every generated logic and call its `start(sb)`. */
    function starterCode(modules: GeneratedModule[], starterLines: string[]): string {
        const logicModules = modules
            .filter(m => m.fileName.endsWith("Logic.ts"))
            .map(m => m.fileName.replace(/\.ts$/, ""));

        return [
            "// GENERATED by @altea/altea-dynamic (DynamicLogic).",
            "",
            `import type { SchemaBuilder } from "@altea/altea/server/schema";`,
            ...logicModules.map(m => `import { ${m.replace(/^.*\//, "")} } from "./${m}";`),
            "",
            "export namespace CodeGenStarter {",
            "",
            "    export function start(sb: SchemaBuilder): void {",
            ...(starterLines.length === 0 ? ["        // no dynamic types"] : starterLines.map(l => "        " + l)),
            "    }",
            "}",
            "",
        ].join("\n");
    }

    /**
     * Signum's `StartDynamicModules` — run the generated starter, so each generated type is INCLUDED in
     * the schema being built.
     *
     * Signum reflects over the loaded assembly for a type named `CodeGenStarter` and invokes its `Start`;
     * here the module's exports are already in hand.
     */
    export function startDynamicModules(sb: SchemaBuilder): void {
        if (codeGenError != null)
            return;

        try {
            const starter = lastCompilation?.modules.get(codeGenStarterFile);
            const namespace = starter?.["CodeGenStarter"] as { start?: (sb: SchemaBuilder) => void } | undefined;
            namespace?.start?.(sb);
        } catch (e) {
            codeGenError = e instanceof Error ? e : new Error(String(e));
        }
    }

    /** Signum's `BeforeSchema` — the definitions' `customBeforeSchema` blocks, before the schema is built. */
    export function beforeSchema(): void {
        if (codeGenError != null)
            return;

        try {
            const module = lastCompilation?.modules.get("CodeGenBeforeSchema.ts");
            const namespace = module?.["CodeGenBeforeSchema"] as { start?: () => void } | undefined;
            namespace?.start?.();
        } catch (e) {
            codeGenError = e instanceof Error ? e : new Error(String(e));
        }
    }

    /**
     * Signum's `RegisterExceptionIfAny` — say loudly that the server came up WITHOUT its dynamic types,
     * log the failure once the Exception table is reachable, and warn about what a `sync` would now do.
     *
     * That last warning is the important one and it is Signum's: with the types missing from the schema,
     * a synchronization would see their tables as orphans and script them as DROPs.
     */
    export function registerExceptionIfAny(): void {
        const e = codeGenError;
        if (e == null)
            return;

        Schema.current.initializing.push(async () => {
            const t = Connector.current().schema.tryTable(ExceptionEntity);
            if (t != null && await Administrator.existsTable(t))
                await ExceptionLogic.logException(e);
        });

        SafeConsole.writeLineColor(chalk.red, "IMPORTANT!: Starting without Dynamic Entities.");
        SafeConsole.writeLineColor(chalk.yellow, "   Error: " + e.message);
        SafeConsole.writeLineColor(chalk.red, "Synchronizing will try to DROP dynamic types. Clean the script manually!");
    }
}
