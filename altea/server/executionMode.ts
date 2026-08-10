import { AsyncLocalStorage } from "node:async_hooks";

// Port of Signum's ExecutionMode (Security/ExecutionMode.cs) — the "global" slice. A trusted framework
// scope that bypasses authorization: Signum's GlobalLazy wraps its factory in `ExecutionMode.Global()` so
// a cache load reads the whole database ungated, and every auth check gates on `!IsEnabled || InGlobal`.
// altea mirrors this — `SchemaBuilder.globalLazy` runs its factory inside `ExecutionMode.global`, and
// `AuthLogic.isEnabled()` folds `isInGlobal()` in (so the row filter / save gate suppress in global mode).
// Backed by an AsyncLocalStorage so the flag holds across the awaited work inside `fn` (altea's factories
// are async, unlike Signum's synchronous ones).
const inGlobalMode = new AsyncLocalStorage<boolean>();

export const ExecutionMode = {
    // Run `fn` (sync or async) with global mode ON for its whole async-propagated scope. Returns fn's
    // result (a Promise when fn is async — the scope holds across its awaits).
    global<R>(fn: () => R): R {
        return inGlobalMode.run(true, fn);
    },
    isInGlobal(): boolean {
        return inGlobalMode.getStore() === true;
    },
};
