import { AsyncLocalStorage } from "node:async_hooks";
import type { Lite } from "../data/lite";
import type { Entity } from "../data/entity";

// Port of Signum's ExecutionMode (Security/ExecutionMode.cs) — the "global" slice. A trusted framework
// scope that bypasses authorization: Signum's GlobalLazy wraps its factory in `ExecutionMode.Global()` so
// a cache load reads the whole database ungated, and every auth check gates on `!IsEnabled || InGlobal`.
// altea mirrors this — `SchemaBuilder.globalLazy` runs its factory inside `ExecutionMode.global`, and
// `AuthLogic.isEnabled()` folds `isInGlobal()` in (so the row filter / save gate suppress in global mode).
// Backed by an AsyncLocalStorage so the flag holds across the awaited work inside `fn` (altea's factories
// are async, unlike Signum's synchronous ones).
const inGlobalMode = new AsyncLocalStorage<boolean>();

/** One handler of {@link ExecutionMode.onApiRetrieved}; see there. */
export type ApiRetrievedAfter = () => void | Promise<void>;
export type ApiRetrievedHandler =
    (lite: Lite<Entity>, viewAction: string) => ApiRetrievedAfter | undefined | Promise<ApiRetrievedAfter | undefined>;

const apiRetrieved: ApiRetrievedHandler[] = [];

/** One handler of {@link ExecutionMode.onSetIsolation}; see there. */
export type SetIsolationHandler = (candidates: readonly Entity[], fn: () => unknown) => unknown;

const setIsolation: SetIsolationHandler[] = [];

export const ExecutionMode = {
    // Run `fn` (sync or async) with global mode ON for its whole async-propagated scope. Returns fn's
    // result (a Promise when fn is async — the scope holds across its awaits).
    global<R>(fn: () => R): R {
        return inGlobalMode.run(true, fn);
    },
    isInGlobal(): boolean {
        return inGlobalMode.getStore() === true;
    },

    /**
     * Signum's `ExecutionMode.OnApiRetrieved` — observe every entity the API hands to a client. A handler
     * may return an "after" callback that runs once the response is built (Signum returns an IDisposable
     * and the `using` scope runs the second half); the shape mirrors `OperationLogic.surroundOperation`.
     * The first and only consumer is @altea/altea-view-log.
     *
     * It lives on ExecutionMode rather than on the entities server for the reason Signum puts it here: the
     * DATA layer must not know about the HTTP layer, and other modules (altea-dashboard,
     * altea-user-queries, altea-chart) report their own "the client just looked at this" scopes through the
     * same seam without depending on the web builder.
     */
    onApiRetrieved: apiRetrieved as ApiRetrievedHandler[],

    /**
     * Signum's `ApiRetrievedScope`: run the handlers' before halves, and return the after halves to run
     * once the caller has finished building the response. `undefined` when nothing is registered, so the
     * fast path allocates nothing.
     *
     * A throwing handler is logged and skipped: an auditing concern must not break what it observes.
     */
    async apiRetrievedScope(lite: Lite<Entity>, viewAction: string): Promise<ApiRetrievedAfter | undefined> {
        if (apiRetrieved.length === 0)
            return undefined;

        const afters: ApiRetrievedAfter[] = [];
        for (const handler of apiRetrieved) {
            try {
                const after = await handler(lite, viewAction);
                if (after != undefined)
                    afters.push(after);
            } catch (e) {
                console.warn(`[api] an onApiRetrieved handler threw and was skipped: ${(e as Error)?.message ?? e}`);
            }
        }

        if (afters.length === 0)
            return undefined;

        return async () => {
            for (const after of afters) {
                try { await after(); } catch (e) {
                    console.warn(`[api] an onApiRetrieved after-handler threw and was skipped: ${(e as Error)?.message ?? e}`);
                }
            }
        };
    },

    /**
     * Signum's `ExecutionMode.OnSetIsolation` — "adopt this entity's own scoping for the work I am about to
     * do on it". A BACKGROUND runner has no request to inherit an ambient scope from, so it takes one from
     * the row it is processing: the four callers are the process runner, the scheduled-task runner and the
     * two model-template renderers, exactly as in Signum. Its only implementor is @altea/altea-isolation.
     *
     * It lives here, in core, for the reason Signum puts it here: those four callers must not depend on an
     * optional module, and with none installed {@link ExecutionMode.withIsolationOf} just calls `fn`.
     *
     * ALTEA, two shape changes and no semantic ones:
     *  - a handler WRAPS the work (`(candidates, fn) => …fn()…`) where Signum's returns an `IDisposable` a
     *    `using` block scopes. Same intent — Signum's call site IS a scope — and it is the shape every
     *    altea ambient already has (`ExecutionMode.global`, `UserHolder.withUser`,
     *    `CultureInfo.withCultures`), because an AsyncLocalStorage scope cannot be entered without a
     *    callback.
     *  - it takes CANDIDATES, and a handler adopts the first that yields a scope. Signum writes that as
     *    `SetIsolation(a) ?? SetIsolation(b)`, which reads "a's scope, else b's" only because a null
     *    IDisposable means "this entity had nothing"; a wrapping handler has no null to test.
     */
    onSetIsolation: setIsolation as SetIsolationHandler[],

    /**
     * Signum's `using (ExecutionMode.SetIsolation(a) ?? ExecutionMode.SetIsolation(b)) { … }`: run `fn` with
     * each handler's scope established around it, outermost first, each handler taking the FIRST candidate
     * that gives it something. Returns fn's result (a Promise when fn is async — the scopes hold across its
     * awaits). With nothing registered it calls `fn` directly.
     *
     * A throwing handler is NOT swallowed, unlike {@link ExecutionMode.apiRetrievedScope}: this seam decides
     * which rows the work may see, so failing to establish the scope must fail the work.
     */
    withIsolationOf<R>(candidates: Entity | readonly Entity[], fn: () => R): R {
        if (setIsolation.length === 0)
            return fn();

        const list = Array.isArray(candidates) ? candidates : [candidates as Entity];
        let composed = fn as () => unknown;
        for (const handler of [...setIsolation].reverse()) {
            const inner = composed;
            composed = () => handler(list, inner);
        }
        return composed() as R;
    },
};
