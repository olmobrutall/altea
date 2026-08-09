// Temporal.* detection + reconstruction, shared by the entity-graph serializers (graphSerializers /
// leafSerializers). A `Temporal.*` field serializes as its ISO `toString()` and rebuilds via `.from()`.

import { Temporal } from '../basics';

export const TEMPORAL_TYPE_NAMES: ReadonlySet<string> = new Set([
    'PlainDate', 'PlainDateTime', 'PlainTime', 'Duration',
    'Instant', 'ZonedDateTime', 'PlainYearMonth', 'PlainMonthDay',
]);

const TEMPORAL_CTORS = [
    Temporal.PlainDate, Temporal.PlainDateTime, Temporal.PlainTime, Temporal.Duration,
    Temporal.Instant, Temporal.ZonedDateTime, Temporal.PlainYearMonth, Temporal.PlainMonthDay,
];

export function isTemporal(v: unknown): boolean {
    return TEMPORAL_CTORS.some(c => v instanceof (c as unknown as Function));
}

export function temporalFrom(name: string, s: string): unknown {
    switch (name) {
        case 'PlainDate': return Temporal.PlainDate.from(s);
        case 'PlainDateTime': return Temporal.PlainDateTime.from(s);
        case 'PlainTime': return Temporal.PlainTime.from(s);
        case 'Duration': return Temporal.Duration.from(s);
        case 'Instant': return Temporal.Instant.from(s);
        case 'ZonedDateTime': return Temporal.ZonedDateTime.from(s);
        case 'PlainYearMonth': return Temporal.PlainYearMonth.from(s);
        case 'PlainMonthDay': return Temporal.PlainMonthDay.from(s);
        default: return s;
    }
}
