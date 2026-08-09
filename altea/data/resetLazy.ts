// Port of Signum's ResetLazy<T> (Signum.Utilities/Synchronization/ResetLazy.cs): a lazy
// whose computed value is cached until it is explicitly RESET, at which point the next read
// recomputes it. Signum uses it (via GlobalLazy) for every process-wide cache that a table's
// rows back — most relevantly TypeLogic's type↔id caches, which reset when the TypeEntity
// table is invalidated (a sync inserts/renames a type).
//
// Divergences from Signum:
//  - No LazyThreadSafetyMode / locking: JS is single-threaded, so the publication race the C#
//    class guards against cannot happen. The `box` sentinel (a distinct object wrapping the
//    value) is kept so a factory that legitimately returns `undefined` is still cached.
//  - The factory is SYNCHRONOUS. altea has no synchronous database API (executeQuery is async),
//    so — unlike Signum's factory, which does a blocking `Database.RetrieveAll` — a ResetLazy
//    factory here must not touch the DB. The async read happens out of band (e.g.
//    TypeLogic.load reads the rows into a snapshot, then calls reset()); the factory only
//    projects the already-fetched snapshot into its in-memory shape.
export interface IResetLazy {
    reset(): void;
    load(): void;
    readonly isValueCreated: boolean;
}

export class ResetLazy<T> implements IResetLazy {
    // A wrapper so that a legitimately-`undefined` value still counts as "loaded"
    // (Signum's `Box`); `box == null` means "not computed yet".
    private box: { value: T } | undefined;

    // Lightweight stats (Signum's Loads/Hits/Invalidations), handy when profiling caches.
    loads = 0;
    hits = 0;
    invalidations = 0;

    constructor(private readonly valueFactory: () => T) { }

    get value(): T {
        const b = this.box;
        if (b != null) {
            this.hits++;
            return b.value;
        }
        const value = this.valueFactory();
        this.loads++;
        return (this.box ??= { value }).value;
    }

    // Force the value to be computed now (Signum's Load()).
    load(): void {
        void this.value;
    }

    get isValueCreated(): boolean {
        return this.box != null;
    }

    // Drop the cached value so the next read recomputes it (Signum's Reset()).
    reset(): void {
        this.box = undefined;
        this.invalidations++;
        this.onReset?.();
    }

    // Fired after each reset (Signum's OnReset event) — lets a dependent cache invalidate too.
    onReset?: () => void;
}
