// Stateless helpers shared by the codec's serializers and factory: ctor-kind checks,
// Temporal.* detection/reconstruction, enum <-> member-name mapping, a guarded toString,
// and a reflection-driven field iterator.

import { Entity, EmbeddedEntity } from '../entity';
import type { Type, BaseEntity } from '../entity';
import { Temporal } from '../basics';
import { getTypeInfo } from '../reflection';
import type { FieldInfo } from '../reflection';
import { MixinDeclarations } from '../mixinDeclarations';

export function ctorIsEntity(ctor: Function): boolean {
    return ctor === Entity || ctor.prototype instanceof Entity;
}

export function ctorIsEmbedded(ctor: Function): boolean {
    return ctor === EmbeddedEntity || ctor.prototype instanceof EmbeddedEntity;
}

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

// Enum <-> member name. Works for numeric enums (reverse map built by TS) and string enums.
export function enumMemberName(enumObj: Record<string, unknown>, value: unknown): string {
    const reverse = enumObj[value as string];
    if (typeof reverse === 'string') return reverse;   // numeric enum: enumObj[0] === "Male"
    for (const k of Object.keys(enumObj))
        if (enumObj[k] === value) return k;
    return String(value);
}

export function enumMemberValue(enumObj: Record<string, unknown>, name: string): unknown {
    return enumObj[name];
}

export function safeToString(m: { toString(): string }): string | undefined {
    try { return m.toString(); } catch { return undefined; }
}

// A ctor-based iterator over a modifiable's reflected fields — own + inherited (the reflection
// metadata copies base fields into each subclass) + mixin. No instance needed, so the plan is
// precomputed per type. (Distinct from changes.forEachField, which needs an instance and skips
// @column(false)/reserved fields — the codec serializes @column(false) fields.)
export function eachFieldInfo(ctor: Function, cb: (fi: FieldInfo) => void): void {
    const visit = (owner: Function): void => {
        const ti = getTypeInfo(owner);
        if (ti == null) return;
        for (const fi of Object.values(ti.fields)) cb(fi);
    };
    visit(ctor);
    for (const mixin of MixinDeclarations.getMixins(ctor as Type<BaseEntity>))
        visit(mixin as unknown as Function);
}
