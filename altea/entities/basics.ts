export type int = number & { readonly __brand: 'int' };
export type long = number & { readonly __brand: 'long' };

// Primary-key identifier types. `uuid7` is a time-ordered UUID (better index
// locality); both share the same column storage (uniqueidentifier / uuid) and
// differ only in how a new value is generated.
export type uuid = string & { readonly __brand: 'uuid' };
export type uuid7 = string & { readonly __brand: 'uuid7' };

export function toInt(n: number): int {
    return Math.trunc(n) as int;
}

export function toLong(n: number): long {
    return Math.trunc(n) as long;
}

export { Temporal } from 'temporal-polyfill';
export { Decimal } from 'decimal.js';
