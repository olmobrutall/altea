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
import { EvalPanelPermission } from "@altea/altea-eval/data/EvalPanelPermission";
import { DynamicPanelServer } from "./DynamicPanelServer";
import { DynamicViewLogic } from "./DynamicViewLogic";
import { DynamicCSSOverrideLogic } from "./DynamicCSSOverrideLogic";
import { DynamicSqlMigrationLogic } from "./DynamicSqlMigrationLogic";
import { DynamicTypeLogic } from "./DynamicTypeLogic";
import { DynamicExpressionLogic } from "./DynamicExpressionLogic";
import { DynamicValidationLogic } from "./DynamicValidationLogic";
import { DynamicTypeConditionLogic } from "./DynamicTypeConditionLogic";
import { DynamicMixinConnectionLogic } from "./DynamicMixinConnectionLogic";
import { DynamicApiLogic } from "./DynamicApiLogic";
import { DynamicIsolationLogic } from "./DynamicIsolationLogic";
import { DynamicCodeCompiler, type GeneratedModule, type DynamicCompilationResult } from "./DynamicCodeCompiler";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";

// Port of Signum.Dynamic's DynamicLogic.cs — the module's ENTRY POINT: which features are started, in what
// order, and what happens when the generated code does not compile. The whole picture is in
// port/Dynamic.md.
//
// The module lets an administrator define parts of the application from the running app itself, and its
// features fall into two groups divided by ONE question: does the feature need a COMPILER?
//
//   INTERPRETED — nothing is compiled, so these are pure data:
//     DynamicView / DynamicViewOverride / DynamicViewSelector  a JSON node TREE plus small JavaScript
//                                                              snippets the client interprets
//                                                              (client/View/NodeUtils + Nodes)
//     DynamicCSSOverride                                       a stylesheet, as text
//     DynamicSqlMigration                                      a schema-diff script, as text
//
//   COMPILED — generated into a CodeGen directory, compiled, loaded, and live after a RESTART:
//     DynamicType, DynamicExpression, DynamicValidation, DynamicApi, DynamicTypeCondition,
//     DynamicMixinConnection, DynamicIsolation
//
// The compiled half rests on running the quote-transformer at RUNTIME — see DynamicCodeCompiler, which is
// where that happens and why it is not optional.

export namespace DynamicLogic {

    /** There is no namespace here — a MODULE is the unit. */
    export const codeGenStarterFile = "CodeGenStarter.ts";

    /**
     * The ONE compilation failure the whole startup carries.
     *
     * A FIELD rather than a throw, because a server that cannot compile its dynamic code must still BOOT —
     * otherwise the only way to fix a bad definition would be to edit the database by hand. Every step
     * below checks it first, so one failure stops the rest without unwinding.
     */
    export let codeGenError: Error | undefined;

    /**
     * WHY the dynamic code is missing, which decides what to tell the user:
     *
     *  - `"compile"`: the definitions were read and did not build. The types are real and absent from the
     *    schema, so a synchronization WOULD script their tables as DROPs.
     *  - `"read"`: the definitions could not be read at all, almost always because the schema TRAILS the
     *    code (pointing an altea app at a Signum database is the extreme case). Nothing was generated and
     *    nothing is known, so there is no dynamic table to drop and the answer is simply `sync` then
     *    restart. Signum makes no distinction and prints its DROP warning either way; on a trailing
     *    database that is advice to clean a script that needs no cleaning.
     */
    export let codeGenErrorKind: "compile" | "read" | undefined;

    /** The generated modules the last compile wrote — what the panel lists. */
    export let lastCompilation: DynamicCompilationResult | undefined;

    /** Every contributor of generated modules. */
    export const codeFileGenerators: Array<() => Promise<GeneratedModule[]>> = [];

    /**
     * What each contributor wants the generated starter to call.
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

        // ViewDynamicPanel belongs to the EVAL module, which registers it in its own start.
        PermissionLogic.registerPermissions(DynamicPanelPermission.RestartApplication);

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
            // `beforeSchema` runs it (Signum's separate `RegisterMixins` step).
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
     * Generate every contributor's modules, compile them, load them.
     *
     * Called by the APP's Starter between `DynamicLogic.start` and `schema.initialize()`: the generated
     * types must exist before the schema is built, because a schema is built once. That is why a new or
     * changed type needs a RESTART to take part, and a `sync` before its table exists.
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

            // The starter is one more generated MODULE, whose exports are handed straight back (Signum
            // finds its CodeGenStarter by searching the assembly's types).
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

            if (result.errors.length > 0) {
                codeGenError = new Error("Dynamic code did not compile:\n"
                    + result.errors.map(e => `  ${e.fileName}(${e.line}): ${e.message}`).join("\n"));
                codeGenErrorKind = "compile";
            }
        } catch (e) {
            // A throw comes from GENERATING — i.e. from reading the definitions — because compiling
            // reports its diagnostics as data. See codeGenErrorKind.
            codeGenError = new Error("Could not read the dynamic definitions: "
                + (e instanceof Error ? e.message : String(e)));
            codeGenErrorKind = "read";
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
     * Run the generated starter, so each generated type is INCLUDED in the schema being built. The
     * module's exports are already in hand — see compileDynamicCode.
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
     * Say loudly that the server came up WITHOUT its dynamic types, log the failure once the Exception
     * table is reachable, and warn about what a `sync` would now do.
     *
     * That last warning is the important one: with the types missing from the schema, a synchronization
     * would see their tables as orphans and script them as DROPs.
     */
    export function registerExceptionIfAny(): void {
        const e = codeGenError;
        if (e == null)
            return;

        // Skipped for a READ failure: the
        // whole meaning of that case is that the schema TRAILS the code, so the exception table trails too
        // and the insert cannot succeed — it only adds a confusing second error line under the accurate
        // one. The console report above is the record until the schema is up.
        if (codeGenErrorKind !== "read")
            Schema.current.initializing.push(async () => {
                const t = Connector.current().schema.tryTable(ExceptionEntity);
                if (t != null && await Administrator.existsTable(t))
                    await ExceptionLogic.logException(e);
            });

        SafeConsole.writeLineColor(chalk.red, "IMPORTANT!: Starting without Dynamic Entities.");
        SafeConsole.writeLineColor(chalk.yellow, "   Error: " + e.message);

        if (codeGenErrorKind === "read")
            SafeConsole.writeLineColor(chalk.yellow,
                "   Nothing was generated, so no dynamic table is at risk: run 'sync', then restart.");
        else
            SafeConsole.writeLineColor(chalk.red,
                "Synchronizing will try to DROP dynamic types. Clean the script manually!");
    }
}
