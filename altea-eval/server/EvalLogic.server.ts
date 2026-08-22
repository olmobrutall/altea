import { FluentInclude } from "@altea/altea/server/schema/fluentInclude";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { forEachField } from "@altea/altea/data/changes";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { EvalEmbedded } from "../data/Eval";
import { EvalPanelPermission } from "../data/EvalPanelPermission";
import { EvalCompiler, type EvalCompilerOptions } from "./EvalCompiler.server";
import { EvalServer } from "./EvalServer.server";
import { frameworkModules, frameworkPreamble } from "./EvalFrameworkModules.server";

// Port of Signum.Eval's EvalLogic.cs — the module's registration plus the two registries a stored script
// depends on: what it may IMPORT (`registerModule`, Signum's AssemblyTypes/Namespaces) and what every
// generated wrapper gets for free (`addPreamble`, Signum's `GetUsingNamespaces()`).
//
// altea divergences:
//  - Signum's assembly/namespace lists become MODULE registrations, because a TypeScript import names a
//    module rather than a namespace, and because the same registration has to serve both the type check and
//    the runtime `require` (see EvalCompiler's header). Like Signum, the module SEEDS ITS OWN framework
//    surface (see EvalFrameworkModules) — an application registers only its entity domains, and a module
//    outside the framework registers its own from its own `Logic.start` (altea-workflow does).
//  - Signum's `[BindParent]` has no counterpart, so an eval's OWNER is bound by
//    `sb.include(Owner).withEvals()`, which hangs the binding off the two schema events altea already has:
//    `preSaving` (so validation and save can compile) and `retrieved` (so a read-back eval can). Signum gets
//    it for free from the field setter; altea's fields are plain properties with no setter to hook.
//  - `EvalLogic.OnInvalidated` is `EvalCompiler.invalidate()`, and `withEvals` also resets an eval's cached
//    compilation on retrieve — a row re-read after somebody else edited the script must not keep the old
//    algorithm.

export namespace EvalLogic {

    let started = false;

    /**
     * Signum's `EvalLogic.Start(sb)`: registers the ViewDynamicPanel permission and mounts the eval-errors
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

        // Reaching a PermissionSymbol declared with init() is enough — PermissionAuthLogic seeds the table
        // (Signum's explicit `PermissionLogic.RegisterPermissions`).
        void EvalPanelPermission.ViewDynamicPanel;

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

    /** Signum's `EvalLogic.GetUsingNamespaces()`: import lines prepended to every generated eval. */
    export function addPreamble(...importLines: string[]): void {
        EvalEmbedded.preamble = [...EvalEmbedded.preamble, ...importLines];
        EvalCompiler.invalidate();
    }

    export function preamble(): readonly string[] {
        return EvalEmbedded.preamble;
    }

    /** Signum's `EvalLogic.OnInvalidated` — drop every cached compilation. */
    export function invalidate(): void {
        EvalCompiler.invalidate();
    }

    // ---- The "check evals" registry ----------------------------------------------------------------------

    /**
     * Signum's `EvalClient.Options.checkEvalFindOptions`: what "check every stored script" walks.
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

// ---- The owner binding (Signum's [BindParent]) -----------------------------------------------------------

declare module "@altea/altea/server/schema/fluentInclude" {
    interface FluentInclude<T extends Entity> {
        /**
         * Binds every {@link EvalEmbedded} this entity owns to it, so an eval's `compile()` can read the
         * owner's fields (Signum's `[BindParent]` + `GetParentEntity<T>()`).
         *
         * Hangs off `preSaving` — which the validation pass runs, so a bad script is rejected on save — and
         * `retrieved`, so a row read back from the database can be compiled. The retrieve also RESETS the
         * cached compilation: the row may carry a script somebody else just changed.
         */
        withEvals(): this;
    }
}

FluentInclude.prototype.withEvals = function <T extends Entity>(this: FluentInclude<T>): FluentInclude<T> {
    const events = this.schemaBuilder.schema.entityEvents(this.type);

    events.preSaving.push(entity => bindEvals(entity, false));
    events.retrieved.push(entity => bindEvals(entity, true));

    return this;
};

/**
 * Binds (and optionally resets) every eval reachable from `entity`'s own fields — including the ones nested
 * inside its embeddeds, which is where Signum's `[BindParent]` chain would take it.
 */
function bindEvals(entity: Entity, reset: boolean): void {
    const visit = (owner: Entity, value: unknown): void => {
        if (value == null)
            return;

        if (Array.isArray(value)) {
            for (const el of value)
                visit(owner, el);
            return;
        }

        if (value instanceof EvalEmbedded) {
            EvalEmbedded.bindOwner(value as EvalEmbedded<unknown>, owner);
            if (reset)
                (value as EvalEmbedded<unknown>).reset();
            return;
        }

        // An embedded may hold the eval one level down (Signum's BindParent chains the same way). Entities
        // are NOT followed: another entity binds its own evals through its own `withEvals()`.
        if (value instanceof EmbeddedEntity)
            forEachField(value, (_fi: unknown, v: unknown) => visit(owner, v));
    };

    forEachField(entity, (_fi: unknown, value: unknown) => visit(entity, value));
}
