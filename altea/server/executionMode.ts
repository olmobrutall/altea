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
};
