// Leaf (value-level) serializers: primitives, Temporal.*, Decimal, Date, enums, and the
// plain (non-part) array wrapper. None of these reach into the entity-graph factory — they
// map a single value (or, for ArraySerializer, delegate element-wise to another serializer).

import type { JsonSerializer, SerializationContext, DeserializationContext } from './types';
import { Decimal } from '../basics';
import { Enum } from '../enum';
import { temporalFrom } from './temporalHelpers';

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

// A binary field (Signum's `byte[]`, altea's `Uint8Array` → typeName "Blob") travels as BASE64: JSON has no
// binary form, and the identity ValueSerializer would emit a Uint8Array as `{"0":31,"1":139,…}`. Signum's
// JSON converters do the same (byte[] ⇄ base64 string).
export const BlobSerializer: JsonSerializer = {
    toJson: v => toBase64(v as Uint8Array),
    fromJson: j => typeof j === 'string' ? fromBase64(j) : (j as Uint8Array),
};

// Base64 without a Buffer / atob dependency (the data layer is isomorphic: no node, no DOM globals).
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
        result += BASE64_CHARS[b0 >> 2];
        result += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
        result += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
        result += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
    }
    return result;
}

function fromBase64(text: string): Uint8Array {
    const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
    const bytes = new Uint8Array((clean.length * 3) >> 2);
    let b = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const c0 = BASE64_CHARS.indexOf(clean[i]);
        const c1 = BASE64_CHARS.indexOf(clean[i + 1]);
        const c2 = clean[i + 2] === undefined ? -1 : BASE64_CHARS.indexOf(clean[i + 2]);
        const c3 = clean[i + 3] === undefined ? -1 : BASE64_CHARS.indexOf(clean[i + 3]);
        bytes[b++] = (c0 << 2) | (c1 >> 4);
        if (c2 >= 0) bytes[b++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
        if (c3 >= 0) bytes[b++] = ((c2 & 0x03) << 6) | c3;
    }
    return b === bytes.length ? bytes : bytes.subarray(0, b);
}

export class EnumSerializer implements JsonSerializer {
    constructor(private readonly enumObj: Record<string, string | number>) { }
    // Wire = the member NAME; stored/runtime value = the numeric ordinal.
    toJson(v: unknown): unknown { return Enum.toName(this.enumObj, v as string | number); }
    fromJson(j: unknown): unknown { return Enum.toValue(this.enumObj, j as string); }
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
