import { AsyncLocalStorage } from 'node:async_hooks';
import { Temporal } from '../entities/basics';

// Port of Signum's SystemTime (Entities/SystemTime.cs) — the query-time scope that selects
// which row versions a query over a system-versioned table sees. Unlike Clock (a static,
// test-only wall-clock override), SystemTime is a SERVER-ONLY, async-scoped feature: the
// active scope is an AsyncLocalStorage context variable, so concurrent requests each get their
// own (Signum uses a thread variable). Hence it lives in logic/, and its use inside a query is
// expressed callback-scoped (`SystemTime.override(st, () => query.toArray())`), the altea
// analogue of Signum's `using (SystemTime.Override(st))`.
//
// Modes (core set — the dynamic AsOfExpression / time-series path is not ported):
//   • AsOf(instant)              — the single version live at that instant
//   • All(joinMode)              — every version (main + history)
//   • Between(start,end,join)    — versions active within [start, end]
//   • ContainedIn(start,end,join)— versions whose period is contained in [start, end)
//   • HistoryTable               — the raw history table only
export enum SystemTimeJoinMode {
    Current = 'Current',
    FirstCompatible = 'FirstCompatible',
    AllCompatible = 'AllCompatible',
}

// Server-only, so the async scope is a Node AsyncLocalStorage directly (no browser/context
// abstraction). Safe to create at module load — an AsyncLocalStorage needs no registration,
// unlike Statics.newContextVariable() which threw before context.node had run.
const storage = new AsyncLocalStorage<SystemTime | undefined>();

export abstract class SystemTime {
    // The ambient SystemTime for the current async scope (Signum's SystemTime.Current).
    static current(): SystemTime | undefined {
        return storage.getStore();
    }

    // Runs `fn` with this SystemTime in scope (Signum's `using (SystemTime.Override(st))`).
    // Every query built inside sees the versioned rows the mode selects. Callback-scoped
    // because AsyncLocalStorage is scope-based (no imperative push/pop).
    static override<R>(systemTime: SystemTime | undefined, fn: () => R): R {
        return storage.run(systemTime, fn);
    }

    // Nested-class constructors (Signum's SystemTime.AsOf / .All / …), attached below so callers
    // write `new SystemTime.AsOf(instant)` exactly like the C#.
    static AsOf: typeof SystemTimeAsOf;
    static All: typeof SystemTimeAll;
    static Between: typeof SystemTimeBetween;
    static ContainedIn: typeof SystemTimeContainedIn;
    static HistoryTable: typeof SystemTimeHistoryTable;
}

export class SystemTimeHistoryTable extends SystemTime {
    toString(): string { return 'HistoryTable'; }
}

// A system-time bound. Ideally a UTC Temporal.Instant; a PlainDateTime is also accepted because
// altea currently materialises period bounds (systemPeriod().min/max) as tz-naive PlainDateTime
// (no Instant reader yet), and those bounds are commonly fed back into AsOf/Between/ContainedIn.
export type SystemTimeBound = Temporal.Instant | Temporal.PlainDateTime;

export class SystemTimeAsOf extends SystemTime {
    constructor(readonly dateTime: SystemTimeBound) { super(); }
    toString(): string { return `AS OF ${this.dateTime.toString()}`; }
}

// Shared base for the interval modes (Signum's SystemTime.Interval), carrying the join mode.
export abstract class SystemTimeInterval extends SystemTime {
    constructor(readonly joinMode: SystemTimeJoinMode) { super(); }
}

export class SystemTimeBetween extends SystemTimeInterval {
    constructor(readonly startDateTime: SystemTimeBound, readonly endDateTime: SystemTimeBound, joinMode: SystemTimeJoinMode) {
        super(joinMode);
    }
    toString(): string { return `BETWEEN ${this.startDateTime} AND ${this.endDateTime}`; }
}

export class SystemTimeContainedIn extends SystemTimeInterval {
    constructor(readonly startDateTime: SystemTimeBound, readonly endDateTime: SystemTimeBound, joinMode: SystemTimeJoinMode) {
        super(joinMode);
    }
    toString(): string { return `CONTAINED IN (${this.startDateTime}, ${this.endDateTime})`; }
}

export class SystemTimeAll extends SystemTimeInterval {
    toString(): string { return 'ALL'; }
}

SystemTime.AsOf = SystemTimeAsOf;
SystemTime.All = SystemTimeAll;
SystemTime.Between = SystemTimeBetween;
SystemTime.ContainedIn = SystemTimeContainedIn;
SystemTime.HistoryTable = SystemTimeHistoryTable;

// The materialised result of `entity.systemPeriod()` (Signum's NullableInterval<DateTime>): a
// half-open period [min, max). An open (still-current) version has max == null. `.min`/`.max`
// are also translatable to the period's start/end columns inside a query; `.overlaps`/`.contains`
// run in memory on the materialised value.
export class NullableInterval {
    constructor(readonly min: SystemTimeBound | null, readonly max: SystemTimeBound | null) { }

    // True if this period and `other` share any instant (half-open [min, max) semantics).
    overlaps(other: NullableInterval): boolean {
        const aMax = this.max, bMin = other.min, bMax = other.max, aMin = this.min;
        const aBeforeB = aMax != null && bMin != null && compareBounds(aMax, bMin) <= 0;
        const bBeforeA = bMax != null && aMin != null && compareBounds(bMax, aMin) <= 0;
        return !aBeforeB && !bBeforeA;
    }

    // True if `instant` falls within [min, max).
    contains(instant: SystemTimeBound): boolean {
        return (this.min == null || compareBounds(this.min, instant) <= 0)
            && (this.max == null || compareBounds(instant, this.max) < 0);
    }

    toString(): string {
        return `[${this.min?.toString() ?? '-∞'}, ${this.max?.toString() ?? '∞'})`;
    }
}

// Compare two bounds of the same Temporal kind (both Instant, or both PlainDateTime — altea reads
// period bounds as PlainDateTime today; user-supplied bounds may be Instant).
function compareBounds(a: SystemTimeBound, b: SystemTimeBound): number {
    return a instanceof Temporal.Instant
        ? Temporal.Instant.compare(a, b as Temporal.Instant)
        : Temporal.PlainDateTime.compare(a, b as Temporal.PlainDateTime);
}
