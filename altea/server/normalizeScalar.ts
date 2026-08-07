import { Temporal, Decimal } from '../data/basics';
import { Vector } from '../data/vector';

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

// The read-side inverse of normalizeScalar: turn a driver's raw temporal value into the
// Temporal the field is typed as, so a materialised entity's `creationTime` etc. is a real
// `Temporal.PlainDateTime`/`PlainDate`/`Duration` (with `.year`, `.dayOfWeek`, …), not a JS
// Date. Postgres hands back ISO-ish strings (the pool's type parsers keep temporal OIDs as
// raw text to avoid node-postgres building local-time Dates); the mssql driver hands back
// UTC Date objects. Both are accepted. Idempotent: an already-Temporal value passes through.
export function denormalizeTemporal(value: unknown, kind: 'dateTime' | 'date' | 'duration'): unknown {
    if (value == null) return null;
    if (value instanceof Temporal.PlainDate || value instanceof Temporal.PlainDateTime
        || value instanceof Temporal.PlainTime || value instanceof Temporal.Duration
        || value instanceof Temporal.ZonedDateTime || value instanceof Temporal.Instant)
        return value;

    switch (kind) {
        case 'date': return toPlainDate(value);
        case 'dateTime': return toPlainDateTime(value);
        case 'duration': return toDuration(value);
    }
}

// Materialise a `numeric`/`decimal` column read into a decimal.js `Decimal` (the read-side inverse of
// normalizeScalar's `String(value)` write). Postgres hands numeric back as a string (kept unparsed by the
// pool so no float precision is lost); SQL Server as a JS number. `new Decimal(...)` accepts both, exactly.
// Idempotent: an already-Decimal value passes through.
export function denormalizeDecimal(value: unknown): Decimal | null {
    if (value == null)
        return null;
    if (value instanceof Decimal)
        return value;
    return new Decimal(value as Decimal.Value);
}

// Materialise a `vector(N)` column read into a Vector. Both pgvector and SQL Server's VECTOR return
// the `[1,2,3]` text literal (Postgres keeps it as text; SQL Server via the driver), which
// Vector.parse turns back into a Vector. Idempotent for an already-Vector value.
export function denormalizeVector(value: unknown): Vector | null {
    if (value == null)
        return null;
    if (value instanceof Vector)
        return value;
    return Vector.parse(String(value));
}

function toPlainDate(value: unknown): Temporal.PlainDate {
    if (value instanceof Date)
        return new Temporal.PlainDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
    const s = String(value);
    // Some drivers append a time part to a date; keep the leading YYYY-MM-DD.
    return Temporal.PlainDate.from(s.length > 10 ? s.slice(0, 10) : s);
}

function toPlainDateTime(value: unknown): Temporal.PlainDateTime {
    if (value instanceof Date)
        return new Temporal.PlainDateTime(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(),
            value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds());
    // Postgres `timestamp` text is "YYYY-MM-DD HH:MM:SS[.ffffff]"; ISO needs a 'T' separator.
    return Temporal.PlainDateTime.from(String(value).replace(' ', 'T'));
}

function toDuration(value: unknown): Temporal.Duration {
    if (value instanceof Date)
        return Temporal.Duration.from({
            hours: value.getUTCHours(), minutes: value.getUTCMinutes(),
            seconds: value.getUTCSeconds(), milliseconds: value.getUTCMilliseconds(),
        });
    const s = String(value).trim();
    if (s.startsWith('P')) return Temporal.Duration.from(s); // ISO 8601
    // Postgres interval text: "HH:MM:SS[.ffffff]", optionally with a leading "N day(s)".
    let rest = s, days = 0;
    const dayMatch = rest.match(/^(-?\d+)\s+days?\s*/);
    if (dayMatch != null) { days = parseInt(dayMatch[1], 10); rest = rest.slice(dayMatch[0].length); }
    const [hh = '0', mm = '0', ss = '0'] = rest.split(':');
    const secFloat = parseFloat(ss) || 0;
    const seconds = Math.trunc(secFloat);
    return Temporal.Duration.from({
        days, hours: parseInt(hh, 10) || 0, minutes: parseInt(mm, 10) || 0,
        seconds, milliseconds: Math.round((secFloat - seconds) * 1000),
    });
}
