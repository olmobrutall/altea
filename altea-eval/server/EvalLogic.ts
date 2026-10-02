import type { SchemaBuilder } from "@altea/altea/server/schema";
import { Entity } from "@altea/altea/data/entity";
import { EvalImports } from "../data/EvalImports";
import { EvalPanelPermission } from "../data/EvalPanelPermission";
import { EvalCompiler, type EvalCompilerOptions } from "./EvalCompiler";
import { EvalServer } from "./EvalServer";
import { frameworkImports } from "./EvalFrameworkModules";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";

// The module's registration, plus the one registry a stored script depends on: WHAT IT MAY REACH
// (`configureImports`, over data/EvalImports).
//
// The module SEEDS ITS OWN framework surface (see EvalFrameworkModules); an application contributes only
// what only it can know, and a module outside the framework contributes its own from its own
// `Logic.start` (altea-workflow does). The order of those calls is the RESOLUTION order when two modules
// export the same name, so the framework's own names win by being first.
//
// A configuration change clears the code-keyed compilation cache: a module joining can change what an
// already-compiled — or already-failed — script means.
//
// Port of Signum.Eval's EvalLogic.cs — see port/Eval.md.

export namespace EvalLogic {

    let started = false;

    /**
     * Registers the ViewDynamicPanel permission and mounts the eval-errors endpoint.
     * `compilerOptions.baseDirectory` is the APP's directory — see EvalCompilerOptions.
     */
    export function start(sb: SchemaBuilder, compilerOptions: EvalCompilerOptions): void {
        if (started)
            return;
        started = true;

        EvalCompiler.configure(compilerOptions);
        EvalCompiler.install();

        configureImports(frameworkImports);

        PermissionLogic.registerPermissions(EvalPanelPermission.ViewDynamicPanel);

        if (sb.webBuilder)
            EvalServer.start(sb.webBuilder);
    }

    export function isStarted(): boolean {
        return started;
    }

    // ---- What a stored script may reach ------------------------------------------------------------------

    /**
     * Derive the configuration every eval gets:
     *
     * ```ts
     * EvalLogic.configureImports(i => i
     *     .eager("@altea/altea-auth/server/AuthLogic", ["AuthLogic"], { value: authLogic })
     *     .fromSchema({ packages: ["eastwind"] }));
     * ```
     *
     * A single eval KIND that needs something different does not come through here: it passes its own
     * `EvalImports` to `wrap({ evalImports })`, usually built as `EvalLogic.imports().extend(...)`.
     */
    export function configureImports(configure: (imports: EvalImports) => EvalImports): void {
        EvalCompiler.configureImports(configure);
    }

    /** The configuration as it currently stands — the base an eval kind derives its own from. */
    export function imports(): EvalImports {
        return EvalCompiler.imports();
    }

    /** Drop every cached compilation. */
    export function invalidate(): void {
        EvalCompiler.invalidate();
    }

    // ---- The "check evals" registry ----------------------------------------------------------------------

    /**
     * What "check every stored script" walks.
     *
     * Each entry is a THUNK that loads the rows to check, so ONE call checks everything — and a narrowing
     * like "only lanes with an actors eval" is one `.filter(...)` rather than a stored filter.
     */
    export const evalSources: { name: string; load: () => Promise<Entity[]> }[] = [];

    export function registerEvalSource(name: string, load: () => Promise<Entity[]>): void {
        evalSources.push({ name, load });
    }
}
