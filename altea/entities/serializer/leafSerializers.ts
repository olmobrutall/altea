// Leaf (value-level) serializers: primitives, Temporal.*, Decimal, Date, enums, and the
// plain (non-part) array wrapper. None of these reach into the entity-graph factory — they
// map a single value (or, for ArraySerializer, delegate element-wise to another serializer).

import type { JsonSerializer, SerializationContext, DeserializationContext } from './types';
import { Decimal } from '../basics';
import { temporalFrom, enumMemberName, enumMemberValue } from './helpers';

export const ValueSerializer: JsonSerializer = {
    toJson: v => v,
    fromJson: j => j,
};

export class TemporalSerializer implements JsonSerializer {
    constructor(private readonly kind: string) { }
    toJson(v: unknown): unknown { return (v as { toString(): string }).toString(); }
    fromJson(j: unknown): unknown { return temporalFrom(this.kind, j as string); }
}

export const DecimalSerializer: JsonSerializer = {
    toJson: v => (v as Decimal).toString(),
    fromJson: j => new Decimal(j as Decimal.Value),
};

export const DateSerializer: JsonSerializer = {
    toJson: v => (v as Date).toISOString(),
    fromJson: j => new Date(j as string),
};

export class EnumSerializer implements JsonSerializer {
    constructor(private readonly enumObj: Record<string, unknown>) { }
    toJson(v: unknown): unknown { return enumMemberName(this.enumObj, v); }
    fromJson(j: unknown): unknown { return enumMemberValue(this.enumObj, j as string); }
}

// A plain (non-part) collection: `Lite<T>[]` or a value array. Maps element-wise; no
// identity reconciliation (that is PartCollectionSerializer's job for owned part entities).
export class ArraySerializer implements JsonSerializer {
    constructor(private readonly element: JsonSerializer) { }
    toJson(value: unknown, sc: SerializationContext, writeType: boolean): unknown {
        return (value as unknown[]).map(v => v == null ? null : this.element.toJson(v, sc, writeType));
    }
    fromJson(json: unknown, dc: DeserializationContext): unknown {
        return (json as unknown[]).map(v => v == null ? null : this.element.fromJson(v, dc, undefined));
    }
}
