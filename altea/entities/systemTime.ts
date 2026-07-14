import { Statics } from './utils/context';
import { Temporal } from './basics';

// Port of Signum's SystemTime (Entities/SystemTime.cs) — the query-time scope that selects
// which row versions a query over a system-versioned table sees. Signum uses a thread
// variable + an IDisposable `Override`; altea uses an ambient context variable scoped by a
// callback (`SystemTime.override(st, () => …)`), plus a per-query `.overrideSystemTime(st)`.
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

export abstract class SystemTime {
    private static readonly variable = Statics.newContextVariable<SystemTime | undefined>();

    // The ambient SystemTime for the current scope (Signum's SystemTime.Current).
    static current(): SystemTime | undefined {
        return SystemTime.variable.getValue();
    }

    // Runs `fn` with this SystemTime in scope (Signum's `using (SystemTime.Override(st))`).
    // Every query executed inside sees the versioned rows the mode selects.
    static override<R>(systemTime: SystemTime | undefined, fn: () => R): R {
        return SystemTime.variable.withValue(systemTime, fn);
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

export class SystemTimeAsOf extends SystemTime {
    constructor(readonly dateTime: Temporal.Instant) { super(); }
    toString(): string { return `AS OF ${this.dateTime.toString()}`; }
}

// Shared base for the interval modes (Signum's SystemTime.Interval), carrying the join mode.
export abstract class SystemTimeInterval extends SystemTime {
    constructor(readonly joinMode: SystemTimeJoinMode) { super(); }
}

export class SystemTimeBetween extends SystemTimeInterval {
    constructor(readonly startDateTime: Temporal.Instant, readonly endDateTime: Temporal.Instant, joinMode: SystemTimeJoinMode) {
        super(joinMode);
    }
    toString(): string { return `BETWEEN ${this.startDateTime} AND ${this.endDateTime}`; }
}

export class SystemTimeContainedIn extends SystemTimeInterval {
    constructor(readonly startDateTime: Temporal.Instant, readonly endDateTime: Temporal.Instant, joinMode: SystemTimeJoinMode) {
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
    constructor(readonly min: Temporal.Instant | null, readonly max: Temporal.Instant | null) { }

    // True if this period and `other` share any instant (half-open [min, max) semantics).
    overlaps(other: NullableInterval): boolean {
        const aMin = this.min, aMax = this.max, bMin = other.min, bMax = other.max;
        const aBeforeB = aMax != null && bMin != null && Temporal.Instant.compare(aMax, bMin) <= 0;
        const bBeforeA = bMax != null && aMin != null && Temporal.Instant.compare(bMax, aMin) <= 0;
        return !aBeforeB && !bBeforeA;
    }

    // True if `instant` falls within [min, max).
    contains(instant: Temporal.Instant): boolean {
        return (this.min == null || Temporal.Instant.compare(this.min, instant) <= 0)
            && (this.max == null || Temporal.Instant.compare(instant, this.max) < 0);
    }

    toString(): string {
        return `[${this.min?.toString() ?? '-∞'}, ${this.max?.toString() ?? '∞'})`;
    }
}
