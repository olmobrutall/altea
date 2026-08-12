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
    private loading: Promise<T> | undefined;

    // Lightweight stats (Signum's Loads/Hits/Invalidations), handy when profiling caches.
    loads = 0;
    hits = 0;
    invalidations = 0;

    constructor(private readonly valueFactory: () => Promise<T>) { }

    // The cached value, resolved once and reused until `reset()`. Concurrent callers share the
    // in-flight promise; a rejection self-evicts (the next call retries) so a transient error —
    // e.g. a "Transaction not started" when the load runs outside a request's transaction — never
    // poisons the cache for the whole process.
    value(): Promise<T> {
        const b = this.box;
        if (b != null) {
            this.hits++;
            return Promise.resolve(b.value);
        }
        if (this.loading != null)
            return this.loading;
        this.loads++;
        const p: Promise<T> = this.valueFactory().then(
            v => { if (this.loading === p) { this.box = { value: v }; this.loading = undefined; } return v; },
            err => { if (this.loading === p) this.loading = undefined; throw err; },
        );
        this.loading = p;
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

    // Install an already-known value synchronously, bypassing the (async) factory — so `valueOrUndefined`
    // returns it immediately. For callers that hold the value by other means: e.g. an offline test seeding
    // a deterministic type-cache into a schema that has no database to load from.
    preset(value: T): void {
        this.box = { value };
        this.loading = undefined;
    }

    get isValueCreated(): boolean {
        return this.box != null;
    }

    // Drop the cached value so the next read recomputes it (Signum's Reset()). Also abandons any
    // in-flight load (its resolution is guarded, so it won't repopulate the box).
    reset(): void {
        this.box = undefined;
        this.loading = undefined;
        this.invalidations++;
        this.onReset?.();
    }

    // Fired after each reset (Signum's OnReset event) — lets a dependent cache invalidate too.
    onReset?: () => void;
}
