import { FluentInclude } from "@altea/altea/server/schema/fluentInclude";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { forEachField } from "@altea/altea/data/changes";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { EvalEmbedded } from "../data/Eval";
import { EvalPanelPermission } from "../data/EvalPanelPermission";
import { EvalCompiler, type EvalCompilerOptions } from "./EvalCompiler";
import { EvalServer } from "./EvalServer";
import { frameworkModules, frameworkPreamble } from "./EvalFrameworkModules";
import { PermissionLogic } from "@altea/altea-auth/server/PermissionLogic";

// The module's registration plus the two registries a stored script depends on: what it may IMPORT
// (`registerModule`) and what every generated wrapper gets for free (`addPreamble`).
//
// The module SEEDS ITS OWN framework surface (see EvalFrameworkModules); an application registers only its
// entity domains, and a module outside the framework registers its own from its own `Logic.start`
// (altea-workflow does).
//
// `invalidate()` clears the code-keyed compilation cache: a registered module changing can change what an
// already-compiled script means.
//
// Port of Signum.Eval's EvalLogic.cs — see docs/port/Eval.md.

export namespace EvalLogic {

    let started = false;

    /**
     * Registers the ViewDynamicPanel permission and mounts the eval-errors
     * endpoint. `compilerOptions.baseDirectory` is the APP's directory — see EvalCompilerOptions.
     */
    export function start(sb: SchemaBuilder, compilerOptions: EvalCompilerOptions): void {
        if (started)
            return;
        started = true;

        EvalCompiler.configure(compilerOptions);
        EvalCompiler.install();

        // Signum's pre-seeded AssemblyTypes / Namespaces (see EvalFrameworkModules).
        registerModules(frameworkModules);
        addPreamble(...frameworkPreamble);

        // Signum's `PermissionLogic.RegisterPermissions(EvalPanelPermission.ViewDynamicPanel)`.
        PermissionLogic.registerPermissions(EvalPanelPermission.ViewDynamicPanel);

        if (sb.webBuilder)
            EvalServer.start(sb.webBuilder);
    }

    export function isStarted(): boolean {
        return started;
    }

    // ---- What a stored script may reach ------------------------------------------------------------------

    /**
     * Signum's `EvalLogic.AssemblyTypes.Add` / `AddFullAssembly`: allow `specifier` in stored scripts. The
     * `value` is the already-imported module — the app imports it normally and hands it over, which is what
     * makes the allow-list real (an unregistered import cannot be resolved at run time).
     *
     * `typesPath` is only needed when TypeScript cannot find the types on its own — in practice for the APP's
     * own modules, since an app is not installed as a package.
     */
    export function registerModule(specifier: string, value: unknown,
        options?: { typesPath?: string; typeNames?: string[] }): void {

        EvalCompiler.registerModule(specifier, value, options);
    }

    export function registerModules(entries: Record<string, unknown>): void {
        for (const [specifier, value] of Object.entries(entries))
            EvalCompiler.registerModule(specifier, value);
    }

    /** Import lines prepended to every generated eval. */
    export function addPreamble(...importLines: string[]): void {
        EvalEmbedded.preamble = [...EvalEmbedded.preamble, ...importLines];
        EvalCompiler.invalidate();
    }

    export function preamble(): readonly string[] {
        return EvalEmbedded.preamble;
    }

    /** Drop every cached compilation. */
    export function invalidate(): void {
        EvalCompiler.invalidate();
    }

    // ---- The "check evals" registry ----------------------------------------------------------------------

    /**
     * What "check every stored script" walks.
     *
     * altea divergence: Signum keeps a list of client FindOptions and the panel issues one query per entry,
     * because only the SERVER can compile and it needs the entities. altea keeps the registry on the SERVER
     * and each entry is simply a THUNK that loads the rows to check — which is both simpler (no
     * QueryRequest/filter plumbing) and more precise: Signum's WorkflowLane entry needs the filter
     * `actorsEval != null`, which is one `.filter(...)` here.
     */
    export const evalSources: { name: string; load: () => Promise<Entity[]> }[] = [];

    export function registerEvalSource(name: string, load: () => Promise<Entity[]>): void {
        evalSources.push({ name, load });
    }
}

