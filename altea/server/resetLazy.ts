// Port of Signum's ResetLazy<T> (Signum.Utilities/Synchronization/ResetLazy.cs): a lazy
// whose computed value is cached until it is explicitly RESET, at which point the next read
// recomputes it. Signum uses it (via GlobalLazy) for every process-wide cache that a table's
// rows back — TypeLogic's type↔id caches, the authorization rule caches, etc.
//
// Divergences from Signum:
//  - No LazyThreadSafetyMode / locking: JS is single-threaded. The `box` sentinel (a distinct
//    object wrapping the value) is kept so a factory that legitimately resolves to `undefined`
//    is still cached.
//  - **The factory is ASYNC.** altea has no synchronous database API (executeQuery is async),
//    so — unlike Signum's factory, which does a blocking `Database.RetrieveAll` — an altea
//    ResetLazy factory returns a `Promise<T>`. The RESOLVED value is stored in `box`, so the
//    lazy is typed `ResetLazy<Data>` (not `ResetLazy<Promise<Data>>`): callers await `value()`
//    to get `T`, and hot-path synchronous readers peek the already-resolved value via
//    `valueOrUndefined` (undefined until the first `value()` resolves, or during a reload after
//    `reset()`). Concurrent `value()` calls share ONE in-flight promise; a rejection self-evicts
//    so the next call retries (a transient DB error never poisons the cache permanently).
import { markStable, type StablePromise } from "./stablePromise";
import type { RuntimeType } from "./runtimeTypes";

export interface IResetLazy {
    reset(): void;
    load(): Promise<void>;
    readonly isValueCreated: boolean;
}

export class ResetLazy<T> implements IResetLazy {
    // A wrapper so that a legitimately-`undefined` resolved value still counts as "loaded"
    // (Signum's `Box`); `box == null` means "not computed yet".
    private box: { value: T } | undefined;
    // The in-flight load, so concurrent `value()` callers share one factory invocation. Cleared
    // when the load settles (or on `reset()`), guarded so a stale load can't populate a reset box.
    private loading: StablePromise<T> | undefined;
    // The promise handed out while the value is warm, so `value()` returns the SAME object every time. That
    // identity is what makes every ResetLazy a STABLE promise: synchronous code inside a re-runnable region
    // can demand it (a row filter asking for its caches mid-bind), and a query can fold it through `.$v`
    // when the lazy also declared a runtimeType. A fresh `Promise.resolve` per call would be a different
    // object every time and neither would converge (see server/stablePromise.ts). Dropped by `reset()`.
    private settled: StablePromise<T> | undefined;

    // Lightweight stats (Signum's Loads/Hits/Invalidations/SumLoadTime), handy when profiling caches —
    // and what altea-cache's statistics panel shows per global lazy. `sumLoadTime` is milliseconds.
    loads = 0;
    hits = 0;
    invalidations = 0;
    sumLoadTime = 0;

    // Signum's `ResetLazyStats.Type` — a label for the statistics panel (the cached type's name, or
    // whatever the registrar passes). Purely descriptive.
    name?: string;

    // `runtimeType` — the DECLARED type of the value — is what makes this cache readable from inside a QUERY
    // through `.$v`. It is not needed to be stable: every ResetLazy is (see `settled`), which is what lets
    // synchronous engine code demand one mid-bind. See server/stablePromise.ts.
    constructor(
        private readonly valueFactory: () => Promise<T>,
        private readonly runtimeType?: () => RuntimeType,
    ) { }

    // The cached value, resolved once and reused until `reset()`. Concurrent callers share the
    // in-flight promise; a rejection self-evicts (the next call retries) so a transient error —
    // e.g. a "Transaction not started" when the load runs outside a request's transaction — never
    // poisons the cache for the whole process.
    value(): StablePromise<T> {
        const b = this.box;
        if (b != null) {
            this.hits++;
            return this.settled ??= markStable(Promise.resolve(b.value), this.runtimeType, { value: b.value });
        }
        if (this.loading != null)
            return this.loading;
        this.loads++;
        const start = performance.now();
        // The in-flight promise is published BEFORE the factory is invoked. A factory runs synchronously up
        // to its first `await`, and it can reach `value()` again in that window — a query it issues reads
        // this very cache through `.$v`. Publishing afterwards would have that re-entrant call start a
        // SECOND load, and so on until the stack blew, instead of handing back this one (which is what lets
        // the query region report the cycle).
        let settle!: (value: T) => void;
        let fail!: (err: unknown) => void;
        // Stable while still LOADING too: a reader that meets the in-flight promise asks the region to await
        // THIS one rather than starting a second load.
        const p = markStable(new Promise<T>((res, rej) => { settle = res; fail = rej; }), this.runtimeType);
        this.loading = p;
        void (async () => {
            try {
                const v = await this.valueFactory();
                if (this.loading === p) { this.box = { value: v }; this.settled = p; this.loading = undefined; this.sumLoadTime += performance.now() - start; }
                // Stamp the value on the promise HERE rather than leaving it to markStable’s own `then`, so
                // it is there the instant this load settles — the query region that awaited this very promise
                // binds again immediately after, and a value one microtask late would look unloaded.
                markStable(p, this.runtimeType, { value: v });
                settle(v);
            } catch (err) {
                if (this.loading === p) this.loading = undefined;
                fail(err);
            }
        })();
        return p;
    }

    // Synchronous peek at the already-resolved value (Signum's factory is sync, so its readers
    // read directly; altea's async factory means this is `undefined` until the first `value()`
    // resolves and again during a reload after `reset()`). Hot-path callers that require the value
    // synchronously (e.g. TypeLogic.typeToId) read this after an async boundary has warmed it.
    get valueOrUndefined(): T | undefined {
        return this.box?.value;
    }

    // Force the value to be computed now (Signum's Load()).
    load(): Promise<void> {
        return this.value().then(() => undefined);
    }

    // Zero the statistics without touching the cached value (Signum's ResetAll(forceReset: true), which
    // clears all four counters — the cache panel's "Clear" button).
    resetStats(): void {
        this.loads = 0;
        this.hits = 0;
        this.invalidations = 0;
        this.sumLoadTime = 0;
    }

    // Install an already-known value synchronously, bypassing the (async) factory — so `valueOrUndefined`
    // returns it immediately. For callers that hold the value by other means: e.g. an offline test seeding
    // a deterministic type-cache into a schema that has no database to load from.
    preset(value: T): void {
        this.box = { value };
        this.settled = undefined;
        this.loading = undefined;
    }

    get isValueCreated(): boolean {
        return this.box != null;
    }

    // Drop the cached value so the next read recomputes it (Signum's Reset()). Also abandons any
    // in-flight load (its resolution is guarded, so it won't repopulate the box).
    reset(): void {
        this.box = undefined;
        this.settled = undefined;
        this.loading = undefined;
        this.invalidations++;
        this.onReset?.();
    }

    // Fired after each reset (Signum's OnReset event) — lets a dependent cache invalidate too.
    onReset?: () => void;
}
