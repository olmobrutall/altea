import { Temporal } from '../entities/basics';

// Normalise a scalar value into a dialect-portable form the DB drivers accept as a
// parameter. Primitives pass through; a JS Date is left as-is. Temporal values are
// formatted to strings: datetime/time are capped at millisecond precision (Temporal's
// native nanoseconds overflow SQL Server's datetime2(7)), and a Duration is rendered as
// a clock time HH:MM:SS — the literal both a SQL Server `time` and a Postgres `interval`
// accept ("PT4M54S" is rejected by SQL Server). Notably, a bare `Temporal.*` object cannot
// be handed to the mssql driver (it calls valueOf, which Temporal throws on).
//
// Shared by the save path (INSERT/UPDATE column values) and the query path (bound
// parameters, e.g. a folded `Clock.now` constant).
export function normalizeScalar(value: unknown): unknown {
    if (value == null) return null;
    if (value instanceof Date) return value;

    if (value instanceof Temporal.PlainDate) return value.toString();
    if (value instanceof Temporal.PlainDateTime) return value.toString({ fractionalSecondDigits: 3 });
    if (value instanceof Temporal.PlainTime) return value.toString({ fractionalSecondDigits: 3 });
    if (value instanceof Temporal.ZonedDateTime) return value.toString({ fractionalSecondDigits: 3 });
    if (value instanceof Temporal.Instant) return value.toString({ fractionalSecondDigits: 3 });
    if (value instanceof Temporal.Duration) {
        const total = Math.floor(Math.abs(value.total('seconds')));
        const hh = String(Math.floor(total / 3600)).padStart(2, '0');
        const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
        const ss = String(total % 60).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }

    if (typeof value === 'object') return String(value); // Decimal & friends
    return value;
}
