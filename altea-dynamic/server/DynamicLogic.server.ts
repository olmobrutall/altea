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
import { DynamicPanelServer } from "./DynamicPanelServer.server";
import { DynamicViewLogic } from "./DynamicViewLogic.server";
import { DynamicCSSOverrideLogic } from "./DynamicCSSOverrideLogic.server";
import { DynamicSqlMigrationLogic } from "./DynamicSqlMigrationLogic.server";
import { DynamicTypeLogic } from "./DynamicTypeLogic.server";
import { DynamicExpressionLogic } from "./DynamicExpressionLogic.server";
import { DynamicValidationLogic } from "./DynamicValidationLogic.server";
import { DynamicTypeConditionLogic } from "./DynamicTypeConditionLogic.server";
import { DynamicMixinConnectionLogic } from "./DynamicMixinConnectionLogic.server";
import { DynamicApiLogic } from "./DynamicApiLogic.server";
import { DynamicIsolationLogic } from "./DynamicIsolationLogic.server";
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

    /**
     * Signum's `OnWriteDynamicStarter`: what each contributor wants the generated starter to call.
     *
     * `lines` are the calls; `imports` are the generated modules those calls name. Signum needs no
     * imports — one assembly, one namespace — while a TypeScript module has to say where a name comes
     * from, and forgetting that produced a starter referencing a `CodeGenExpressionStarter` it had never
     * imported.
     */
    export const starterWriters: Array<() => Promise<{
        imports?: Array<{ module: string; name: string }>;
        lines: string[];
    }>> = [];

    /** Signum's `OnApplicationServerRestarted`. */
    export let onApplicationServerRestarted: (() => void) | undefined;

    /** The code-gen directory, or null when the app never configured the compiled half. */
    export function codeGenDirectoryOrNull(): string | null {
        return DynamicCodeCompiler.isConfigured() ? DynamicCodeCompiler.codeGenDirectory() : null;
    }

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
        /**
         * DynamicIsolation — OFF by default, unlike its five siblings.
         *
         * Isolation is an app-wide commitment (@altea/altea-isolation refuses to start unless EVERY table
         * declared a strategy), so generating `Isolation.register` calls for an app that never started it
         * would commit it to that assertion by accident. Signum has the same hazard and the same answer:
         * its app calls `DynamicIsolationLogic.Start` / `RegisterIsolations` or it does not.
         */
        isolations?: boolean;
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

        // The panel's own endpoint — how an author sees a compile failure at all (the diagnostics exist
        // only in the process that tried to compile).
        if (sb.webBuilder != null)
            DynamicPanelServer.start(sb.webBuilder);

        if (options?.types ?? true) {
            DynamicTypeLogic.start(sb);
            codeFileGenerators.push(async () => DynamicTypeLogic.getCodeFiles(await DynamicTypeLogic.getTypes()));
            starterWriters.push(async () => ({
                lines: DynamicTypeLogic.writeDynamicStarter(await DynamicTypeLogic.getTypes()),
            }));
        }

        if (options?.expressions ?? true) {
            DynamicExpressionLogic.start(sb);
            codeFileGenerators.push(async () =>
                DynamicExpressionLogic.getCodeFiles(await DynamicExpressionLogic.getExpressions()));
            starterWriters.push(async () => ({
                imports: [{ module: "CodeGenExpressionStarter", name: "CodeGenExpressionStarter" }],
                lines: DynamicExpressionLogic.writeDynamicStarter(await DynamicExpressionLogic.getExpressions()),
            }));
        }

        if (options?.validations ?? true)
            DynamicValidationLogic.start(sb); // an EVAL, so nothing is generated

        if (options?.typeConditions ?? true) {
            DynamicTypeConditionLogic.start(sb);
            codeFileGenerators.push(async () =>
                DynamicTypeConditionLogic.getCodeFiles(await DynamicTypeConditionLogic.getTypeConditions()));
            starterWriters.push(async () => ({
                imports: [{ module: "CodeGenTypeCondition", name: "CodeGenTypeConditionStarter" }],
                lines: DynamicTypeConditionLogic.writeDynamicStarter(await DynamicTypeConditionLogic.getTypeConditions()),
            }));
        }

        if (options?.mixinConnections ?? true) {
            DynamicMixinConnectionLogic.start(sb);
            // No starter line: a mixin must be DECLARED before any type carrying it is included, so
            // `beforeSchema` runs it — Signum's separate `RegisterMixins` step.
            codeFileGenerators.push(async () =>
                DynamicMixinConnectionLogic.getCodeFiles(await DynamicMixinConnectionLogic.getConnections()));
        }

        if (options?.isolations === true) {
            DynamicIsolationLogic.start(sb);
            // No starter line: like a mixin connection, `Isolation.register` declares a MIXIN whose field
            // is a column, so it must land before the schema is built — beforeSchema, not the starter.
            codeFileGenerators.push(async () =>
                await DynamicIsolationLogic.getCodeFiles(await DynamicTypeLogic.getTypes()));
        }

        if (options?.apis ?? true) {
            DynamicApiLogic.start(sb);
            // No starter line either: the generated module takes a WebBuilder, and the HOST calls it.
            codeFileGenerators.push(async () =>
                DynamicApiLogic.getCodeFiles(await DynamicApiLogic.getApis()));
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
            const starterImports: Array<{ module: string; name: string }> = [];
            for (const writer of starterWriters) {
                const { imports, lines } = await writer();
                starterLines.push(...lines);
                starterImports.push(...imports ?? []);
            }

            modules.push({
                fileName: codeGenStarterFile,
                content: starterCode(modules, starterImports, starterLines),
            });

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
    function starterCode(
        modules: GeneratedModule[],
        starterImports: Array<{ module: string; name: string }>,
        starterLines: string[],
    ): string {
        // A per-type logic module exports a namespace named after itself; a contributor's module need not
        // (CodeGenTypeCondition.ts exports CodeGenTypeConditionStarter), so it states both.
        const imports = [
            ...modules
                .filter(m => m.fileName.endsWith("Logic.ts"))
                .map(m => m.fileName.replace(/\.ts$/, ""))
                .map(m => ({ module: m, name: m.replace(/^.*\//, "") })),
            // Only what was actually GENERATED: a contributor states its import unconditionally, but its
            // module exists only when it had rows (no dynamic type conditions ⇒ no CodeGenTypeCondition.ts,
            // and importing it would fail the whole compile).
            ...starterImports.filter(i => modules.some(m => m.fileName === i.module + ".ts")),
        ];

        return [
            "// GENERATED by @altea/altea-dynamic (DynamicLogic).",
            "",
            `import type { SchemaBuilder } from "@altea/altea/server/schema";`,
            ...imports.map(i => `import { ${i.name} } from "./${i.module}";`),
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

    /**
     * Signum's `BeforeSchema` + `RegisterMixins` — everything that must land before the schema is built,
     * plus the dynamic API routes.
     *
     * Takes the SchemaBuilder because the routes are mounted through `sb.webBuilder`, which is how every
     * altea module registers its own (see DynamicViewLogic). By this point `AuthLogic.start` has already
     * run, so a dynamic endpoint sits behind the auth middleware like a declared one — mounting earlier
     * would leave it unauthenticated, the ordering @altea/altea-files documents.
     */
    export function beforeSchema(sb: SchemaBuilder): void {
        if (codeGenError != null)
            return;

        try {
            // MIXINS FIRST, and this is Signum's ordering (its separate `RegisterMixins`): a mixin's
            // fields become columns on the owner's table, so the declaration has to land before any type
            // carrying it is included by the generated starter.
            const mixins = lastCompilation?.modules.get("CodeGenMixinLogic.ts");
            (mixins?.["CodeGenMixinLogic"] as { start?: () => void } | undefined)?.start?.();

            // Isolation for the same reason and in the same window: `Isolation.register` declares the
            // IsolationMixin on each dynamic type, whose field is a column.
            const isolations = lastCompilation?.modules.get("CodeGenIsolationLogic.ts");
            (isolations?.["CodeGenIsolationLogic"] as { start?: () => void } | undefined)?.start?.();

            const module = lastCompilation?.modules.get("CodeGenBeforeSchema.ts");
            const namespace = module?.["CodeGenBeforeSchema"] as { start?: () => void } | undefined;
            namespace?.start?.();

            // The dynamic API module cannot ride on the generated starter — it takes a WebBuilder, not a
            // SchemaBuilder — so it is handed to its own logic, and the HOST calls registerRoutes(ws).
            const controller = lastCompilation?.modules.get("CodeGenController.ts");
            DynamicApiLogic.generated = controller?.["CodeGenController"] as typeof DynamicApiLogic.generated;
            // A TERMINAL run has no WebBuilder, and that is fine: there are no routes to serve there.
            if (sb.webBuilder != null)
                DynamicApiLogic.registerRoutes(sb.webBuilder);
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
