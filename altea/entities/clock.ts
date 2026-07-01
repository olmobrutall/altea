import { Temporal } from "./basics";

// How the clock reads the wall time (Signum's TimeZoneMode). Apps that store UTC in the
// database use `Utc`; apps that store local time use `Local`.
export enum TimeZoneMode { Utc, Local }

// Server clock (Signum's Clock). An abstraction over "now" so an application can choose
// UTC vs. machine-local time (via `Clock.mode`) and tests can pin a fixed value (via
// `Clock.overrideNow` / `Clock.overridenNow`). Lives in entities/ so the entity model can
// reference it without depending on the logic layer.
//
// It works in queries too: a captured `Clock.now` inside a quoted lambda is folded by the
// ExpressionSimplifier to a constant (the value at query-build time), exactly like Signum
// partial-evaluates `Clock.Now` to a DateTime constant.
export const Clock = {
    // Whether `now`/`today` read UTC or the machine's local time. Global (per Signum).
    mode: TimeZoneMode.Utc as TimeZoneMode,

    // A pinned value that overrides the wall clock, for deterministic tests. Usually set
    // through `overrideNow` (scoped) but can be assigned/cleared directly.
    overridenNow: undefined as Temporal.PlainDateTime | undefined,

    get now(): Temporal.PlainDateTime {
        if (this.overridenNow != null)
            return this.overridenNow;
        return this.mode === TimeZoneMode.Local
            ? Temporal.Now.plainDateTimeISO()
            : Temporal.Now.plainDateTimeISO("UTC");
    },

    get today(): Temporal.PlainDate {
        return this.now.toPlainDate();
    },

    // Pin `now` to a fixed value until the returned handle is disposed (Signum's
    // Clock.OverrideNow) — designed for a `using` declaration:
    // `using _ = Clock.overrideNow(x); …` restores the previous value at scope exit.
    overrideNow(value: Temporal.PlainDateTime): Disposable {
        const old = this.overridenNow;
        this.overridenNow = value;
        return { [Symbol.dispose]: () => { this.overridenNow = old; } };
    },
};
