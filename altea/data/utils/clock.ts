import { Temporal } from "../basics";
import { Statics, type IContextVariable } from "./context";

// How the clock reads the wall time (Signum's TimeZoneMode). Apps that store UTC in the
// database use `Utc`; apps that store local time use `Local`.
//
// The mode is what gives a stored `Temporal.PlainDateTime` its meaning: every datetime field
// (`OperationLogEntity.start`, `ScheduledTaskLogEntity.endTime`, …) is a wall time in the CLOCK's frame —
// UTC under `Utc`, the server's zone under `Local`. It also decides the Postgres column type
// (`timestamptz` / `timestamp`, see dbType.ts) and, on the client, whether a value is shifted to the
// viewer's zone for display (`toUserInterface`).
export enum TimeZoneMode { Utc, Local }

// Signum's Clock.OverrideTimeZone: a SESSION variable, so each request can render server-side text
// (e-mails, Excel, templates) in its user's zone. Created on first use because the context storage is
// installed by the host's first import (context.node / context.browser), after this module loads.
let timeZoneOverrideVar: IContextVariable<string> | undefined;
function timeZoneOverride(): IContextVariable<string> {
    return timeZoneOverrideVar ??= Statics.newContextVariable<string>();
}

// Server clock (Signum's Clock). An abstraction over "now" so an application can choose
// UTC vs. machine-local time (via `Clock.mode`) and tests can pin a fixed value (via
// `Clock.overrideNow` / `Clock.overridenNow`). Lives in entities/ so the entity model can
// reference it without depending on the logic layer.
//
// It works in queries too: a captured `Clock.now` inside a quoted lambda is folded by the
// ExpressionSimplifier to a constant (the value at query-build time), exactly like Signum
// partial-evaluates `Clock.Now` to a DateTime constant.
export const Clock = {
    // Whether `now`/`today` read UTC or the machine's local time. Global (per Signum). The client receives
    // the server's value with the reflection metadata.
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

    /** The zone a UTC value is shown in: the scoped override, else this machine's (the browser's on the client). */
    get userTimeZone(): string {
        return timeZoneOverride().getValue() ?? Temporal.Now.timeZoneId();
    },

    /** Run `fn` rendering datetimes in `timeZone` (an IANA id, e.g. "Europe/Berlin") — Signum's OverrideTimeZone,
     *  scoped to the call on the server. */
    withTimeZone<R>(timeZone: string, fn: () => R): R {
        return timeZoneOverride().withValue(timeZone, fn);
    },

    /** A stored datetime as the user should SEE it (Signum's ToUserInterface): unchanged under `Local`,
     *  shifted from UTC to {@link userTimeZone} under `Utc`. */
    toUserInterface(dbDateTime: Temporal.PlainDateTime): Temporal.PlainDateTime {
        if (this.mode === TimeZoneMode.Local)
            return dbDateTime;
        return dbDateTime.toZonedDateTime("UTC").withTimeZone(this.userTimeZone).toPlainDateTime();
    },

    /** The inverse (Signum's FromUserInterface): what the user typed, back in the clock's frame. A wall time
     *  in a DST gap or overlap resolves with Temporal's default "compatible" disambiguation. */
    fromUserInterface(uiDateTime: Temporal.PlainDateTime): Temporal.PlainDateTime {
        if (this.mode === TimeZoneMode.Local)
            return uiDateTime;
        return uiDateTime.toZonedDateTime(this.userTimeZone).withTimeZone("UTC").toPlainDateTime();
    },
};
