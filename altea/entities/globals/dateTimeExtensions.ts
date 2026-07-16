import { Temporal } from "../basics";

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
            yearStart(): Temporal.PlainDateTime;
            quarterStart(): Temporal.PlainDateTime;
            monthStart(): Temporal.PlainDateTime;
            weekStart(): Temporal.PlainDateTime;
            /** Date part (time truncated to 00:00). */
            readonly date: Temporal.PlainDate;
            truncHours(): Temporal.PlainDateTime;
            truncMinutes(): Temporal.PlainDateTime;
            truncSeconds(): Temporal.PlainDateTime;
            readonly timeOfDay: Temporal.PlainTime;
            daysTo(other: Temporal.PlainDateTime): number;
            monthsTo(other: Temporal.PlainDateTime): number;
            yearsTo(other: Temporal.PlainDateTime): number;
        }
        interface PlainDate {
            quarter(): number;
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

const PlainDateTime = Temporal.PlainDateTime.prototype;
const PlainDate = Temporal.PlainDate.prototype;

PlainDateTime.quarter = function () { return quarterOf(this.month); };
PlainDateTime.yearStart = function () { return this.with({ month: 1, day: 1, ...midnight }); };
PlainDateTime.quarterStart = function () { return this.with({ month: quarterStartMonth(this.month), day: 1, ...midnight }); };
PlainDateTime.monthStart = function () { return this.with({ day: 1, ...midnight }); };
// WeekStart with Monday as the first day of the week (matching the DayOfWeek/ISO ordering and
// the SQL translator's date_trunc('week', …)); diverges from Signum's culture-based default.
PlainDateTime.weekStart = function () { return this.subtract({ days: this.dayOfWeek - DayOfWeek.Monday }).with(midnight); };
PlainDateTime.truncHours = function () { return this.with({ minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }); };
PlainDateTime.truncMinutes = function () { return this.with({ second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }); };
PlainDateTime.truncSeconds = function () { return this.with({ millisecond: 0, microsecond: 0, nanosecond: 0 }); };
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
