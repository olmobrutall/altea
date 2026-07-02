import { Temporal } from "./basics";

// Query-only date/time helpers, ported from Signum's DateTimeExtensions. They are
// translated to SQL by the LINQ provider (date-part extraction, truncation, diffs);
// the in-memory bodies just throw, since they're only meaningful inside a query.
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

const queryOnly = (name: string) => function (): never {
    throw new Error(`Temporal.${name} is a query-only helper; it has no in-memory implementation`);
};

for (const m of ["quarter", "yearStart", "quarterStart", "monthStart", "weekStart", "truncHours", "truncMinutes", "truncSeconds", "daysTo", "monthsTo", "yearsTo"])
    (Temporal.PlainDateTime.prototype as any)[m] ??= queryOnly(`PlainDateTime.${m}`);
for (const m of ["quarter", "yearStart", "quarterStart", "monthStart", "weekStart", "daysTo", "monthsTo", "yearsTo"])
    (Temporal.PlainDate.prototype as any)[m] ??= queryOnly(`PlainDate.${m}`);
