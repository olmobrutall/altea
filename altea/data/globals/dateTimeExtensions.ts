import { Temporal } from "../basics";
import { registerEnum } from "../registration";

// Date/time helpers, ported from Signum's DateTimeExtensions. Inside a quoted query
// lambda they are translated to SQL by the LINQ provider (date-part extraction,
// truncation, diffs); outside a query the in-memory bodies below run instead.
//
// Native Temporal members (year/month/day/hour/minute/second/millisecond/dayOfYear/
// dayOfWeek, toPlainDate/toPlainDateTime, since/add) already exist and are translated
// directly by the binder/nominator — only the non-native helpers are declared here.

declare module "temporal-polyfill" {
    namespace Temporal {
        interface PlainDateTime {
            quarter(): number;
            /** ISO-8601 week of the year, 1..53 (the week Monday–Sunday that owns this date's Thursday). */
            weekNumber(): number;
            yearStart(): Temporal.PlainDateTime;
            quarterStart(): Temporal.PlainDateTime;
            monthStart(): Temporal.PlainDateTime;
            weekStart(): Temporal.PlainDateTime;
            /** Date part (time truncated to 00:00). */
            readonly date: Temporal.PlainDate;
            /** `step` buckets the part: `truncHours(6)` floors 13:45 to 12:00 (Signum's TruncHours(dt, step)). */
            truncHours(step?: number): Temporal.PlainDateTime;
            truncMinutes(step?: number): Temporal.PlainDateTime;
            truncSeconds(step?: number): Temporal.PlainDateTime;
            truncMilliseconds(step: number): Temporal.PlainDateTime;
            readonly timeOfDay: Temporal.PlainTime;
            daysTo(other: Temporal.PlainDateTime): number;
            monthsTo(other: Temporal.PlainDateTime): number;
            yearsTo(other: Temporal.PlainDateTime): number;
        }
        interface PlainDate {
            quarter(): number;
            /** ISO-8601 week of the year, 1..53 (the week Monday–Sunday that owns this date's Thursday). */
            weekNumber(): number;
            yearStart(): Temporal.PlainDate;
            quarterStart(): Temporal.PlainDate;
            monthStart(): Temporal.PlainDate;
            weekStart(): Temporal.PlainDate;
            /** Days since the epoch (Signum's DateOnly.DayNumber). */
            readonly dayNumber: number;
            daysTo(other: Temporal.PlainDate): number;
            monthsTo(other: Temporal.PlainDate): number;
            yearsTo(other: Temporal.PlainDate): number;
        }
    }
}

// DayOfWeek with the Temporal-ISO ordering (Monday = 1 … Sunday = 7), so the constants
// line up with the in-memory `Temporal.PlainDateTime.dayOfWeek` value and with the SQL the
// translator emits (Postgres `EXTRACT(isodow …)`, SQL Server `DATEPART(weekday …)`). This
// diverges from Signum/.NET (Sunday = 0); only Sunday differs — Mon–Sat are 1–6 in both.
export enum DayOfWeek {
    Monday = 1,
    Tuesday = 2,
    Wednesday = 3,
    Thursday = 4,
    Friday = 5,
    Saturday = 6,
    Sunday = 7,
}

// Signum's DateTimePrecision (this same file, Signum.Utilities/DateTimeExtensions.cs). The ORDER is the
// point: a member is greater when it carries more detail, so "is this value finer than the property
// allows" is the plain `>` that `@dateTimePrecisionValidator` writes.
export enum DateTimePrecision {
    Days,
    Hours,
    Minutes,
    Seconds,
    Milliseconds,
}
export type DateTimePrecisionKeys = keyof typeof DateTimePrecision;

// No entity FIELD is of this type — it is a modelling vocabulary, not a stored value — so nothing
// auto-registers it and it needs the hand-written call. Without a registered NAME the type has no
// translation key at all, so `Enum.niceName(DateTimePrecision, …)` (what the validator's help and error
// messages read) would fall back to the humanised English identifier in every culture. Registering
// creates no table: the schema builder only builds one when a FieldEnum actually references the type.
registerEnum(DateTimePrecision);

/**
 * Signum's `DateTimeExtensions.GetPrecision` — the FINEST unit a value actually uses, which is what a
 * precision validator compares against the maximum the property declares.
 *
 * Unlike everything below it this is an ordinary function, not a Temporal prototype member: there is no
 * SQL translation for it, so a `@quoted` body calling it would fail at bind time rather than here.
 *
 * A `PlainDate` carries no time at all, so it is always `Days`. DIVERGENCE from Signum, which tests
 * `Millisecond != 0` alone: Temporal counts down to the nanosecond, so a sub-millisecond remainder
 * answers `Milliseconds` too — otherwise 12:00:00.0000004 would report itself as `Days` and pass a
 * `Seconds` validator. (The .NET original has the same hole for its sub-millisecond ticks.)
 */
export function getPrecision(value: Temporal.PlainDateTime | Temporal.PlainDate): DateTimePrecision {
    if (!(value instanceof Temporal.PlainDateTime))
        return DateTimePrecision.Days;

    if (value.millisecond !== 0 || value.microsecond !== 0 || value.nanosecond !== 0)
        return DateTimePrecision.Milliseconds;
    if (value.second !== 0)
        return DateTimePrecision.Seconds;
    if (value.minute !== 0)
        return DateTimePrecision.Minutes;
    if (value.hour !== 0)
        return DateTimePrecision.Hours;
    return DateTimePrecision.Days;
}

/**
 * `getPrecision` for a TIME rather than a date — Signum's `TimeOnly.GetPrecision` and
 * `TimeSpan.GetPrecision`, which are the same function twice. Undefined means the value is exactly zero
 * and so uses no unit at all, which is what those return `null` for.
 *
 * `Days` is reachable only from a Duration, which measures ELAPSED time and may run past midnight. Its
 * fields are not balanced (`Duration.from({ seconds: 376 })` has 376 seconds and no minutes), so it is
 * rounded up to days before being read.
 *
 * DIVERGENCE: Signum's TimeOnly overload stops at `Seconds`, so a TimeOnly with milliseconds reports
 * itself as a whole minute and passes any validator. Both halves answer `Milliseconds` here, and sub-ms
 * Temporal remainders count towards it for the reason `getPrecision` gives.
 */
export function getTimePrecision(value: Temporal.PlainTime | Temporal.Duration): DateTimePrecision | undefined {
    // A Duration names its fields in the plural, so the two are read apart and then compared alike.
    let days = 0, hour: number, minute: number, second: number, sub: number;
    if (value instanceof Temporal.Duration) {
        const d = value.round({ largestUnit: "day" });
        [days, hour, minute, second] = [d.days, d.hours, d.minutes, d.seconds];
        sub = d.milliseconds || d.microseconds || d.nanoseconds;
    } else {
        [hour, minute, second] = [value.hour, value.minute, value.second];
        sub = value.millisecond || value.microsecond || value.nanosecond;
    }

    if (sub !== 0)
        return DateTimePrecision.Milliseconds;
    if (second !== 0)
        return DateTimePrecision.Seconds;
    if (minute !== 0)
        return DateTimePrecision.Minutes;
    if (hour !== 0)
        return DateTimePrecision.Hours;
    if (days !== 0)
        return DateTimePrecision.Days;
    return undefined;
}

// Fields that a "start of …" truncation zeroes out on a PlainDateTime.
const midnight = { hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 } as const;

// Signum's Quarter: 1..4 from the 1-based month (Jan–Mar = 1, …). Uses /3.
function quarterOf(month: number): number {
    return Math.floor((month - 1) / 3) + 1;
}

// Signum's QuarterStart: floors the month to the quarter's first month. Ported faithfully —
// Signum divides by 4 (not 3), so it yields months 1/1/1/1/5/5/5/5/9/9/9/9 across the year.
function quarterStartMonth(month: number): number {
    return Math.floor((month - 1) / 4) * 4 + 1;
}

// A DateOnly reference point for dayNumber: Signum's DateOnly.DayNumber counts whole days
// since 0001-01-01 in the proleptic Gregorian calendar (Temporal's ISO calendar).
const dayNumberEpoch = Temporal.PlainDate.from({ year: 1, month: 1, day: 1 });

// ISO-8601 week number: the week owning this date's THURSDAY, weeks running Monday–Sunday. DIVERGES from
// Signum, whose `WeekNumber()` asks the CURRENT CULTURE's calendar (`CalendarWeekRule`, `FirstDayOfWeek`)
// and so answers a different number per user — while its SQL asks `DATEPART(week)` (US: week 1 holds Jan 1)
// on SQL Server and `EXTRACT(week)` (ISO) on Postgres, three rules for one token. altea is ISO on all
// three: Postgres already is, SQL Server gets `iso_week`, and this is the Monday-first convention
// `weekStart` above already picked.
function isoWeekNumber(year: number, month: number, day: number, dayOfWeek: number): number {
    const thursday = Temporal.PlainDate.from({ year, month, day }).add({ days: 4 - dayOfWeek });
    return Math.floor((thursday.dayOfYear - 1) / 7) + 1;
}

// The step-bucketed truncation Signum's `TruncHours(dt, step)` does: floor the part to a multiple of
// `step`. `undefined` means plain truncation, which is the same expression with step 1.
function floorTo(value: number, step: number | undefined): number {
    return step == undefined ? value : value - (value % step);
}

const PlainDateTime = Temporal.PlainDateTime.prototype;
const PlainDate = Temporal.PlainDate.prototype;

PlainDateTime.quarter = function () { return quarterOf(this.month); };
PlainDateTime.weekNumber = function () { return isoWeekNumber(this.year, this.month, this.day, this.dayOfWeek); };
PlainDateTime.yearStart = function () { return this.with({ month: 1, day: 1, ...midnight }); };
PlainDateTime.quarterStart = function () { return this.with({ month: quarterStartMonth(this.month), day: 1, ...midnight }); };
PlainDateTime.monthStart = function () { return this.with({ day: 1, ...midnight }); };
// WeekStart with Monday as the first day of the week (matching the DayOfWeek/ISO ordering and
// the SQL translator's date_trunc('week', …)); diverges from Signum's culture-based default.
PlainDateTime.weekStart = function () { return this.subtract({ days: this.dayOfWeek - DayOfWeek.Monday }).with(midnight); };
PlainDateTime.truncHours = function (step) { return this.with({ hour: floorTo(this.hour, step), minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }); };
PlainDateTime.truncMinutes = function (step) { return this.with({ minute: floorTo(this.minute, step), second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }); };
PlainDateTime.truncSeconds = function (step) { return this.with({ second: floorTo(this.second, step), millisecond: 0, microsecond: 0, nanosecond: 0 }); };
PlainDateTime.truncMilliseconds = function (step) { return this.with({ millisecond: floorTo(this.millisecond, step), microsecond: 0, nanosecond: 0 }); };
PlainDateTime.daysTo = function (other) { return this.toPlainDate().until(other.toPlainDate(), { largestUnit: "day" }).days; };
PlainDateTime.monthsTo = function (other) {
    let result = other.month - this.month + (other.year - this.year) * 12;
    if (Temporal.PlainDateTime.compare(other, this.add({ months: result })) < 0)
        result--;
    return result;
};
PlainDateTime.yearsTo = function (other) {
    let result = other.year - this.year;
    if (Temporal.PlainDateTime.compare(other, this.add({ years: result })) < 0)
        result--;
    return result;
};

Object.defineProperty(PlainDateTime, "date", { get(this: Temporal.PlainDateTime) { return this.toPlainDate(); }, configurable: true });
Object.defineProperty(PlainDateTime, "timeOfDay", { get(this: Temporal.PlainDateTime) { return this.toPlainTime(); }, configurable: true });

PlainDate.quarter = function () { return quarterOf(this.month); };
PlainDate.weekNumber = function () { return isoWeekNumber(this.year, this.month, this.day, this.dayOfWeek); };
PlainDate.yearStart = function () { return this.with({ month: 1, day: 1 }); };
PlainDate.quarterStart = function () { return this.with({ month: quarterStartMonth(this.month), day: 1 }); };
PlainDate.monthStart = function () { return this.with({ day: 1 }); };
PlainDate.weekStart = function () { return this.subtract({ days: this.dayOfWeek - DayOfWeek.Monday }); };
PlainDate.daysTo = function (other) { return this.until(other, { largestUnit: "day" }).days; };
PlainDate.monthsTo = function (other) {
    let result = other.month - this.month + (other.year - this.year) * 12;
    if (Temporal.PlainDate.compare(other, this.add({ months: result })) < 0)
        result--;
    return result;
};
PlainDate.yearsTo = function (other) {
    let result = other.year - this.year;
    if (Temporal.PlainDate.compare(other, this.add({ years: result })) < 0)
        result--;
    return result;
};

Object.defineProperty(PlainDate, "dayNumber", { get(this: Temporal.PlainDate) { return dayNumberEpoch.until(this, { largestUnit: "day" }).days; }, configurable: true });
