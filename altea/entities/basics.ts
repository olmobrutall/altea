export type int = number & { readonly __brand: 'int' };
export type long = number & { readonly __brand: 'long' };
export type decimal = number & { readonly __brand: 'decimal' };

// Primary-key identifier types. `uuid7` is a time-ordered UUID (better index
// locality); both share the same column storage (uniqueidentifier / uuid) and
// differ only in how a new value is generated.
export type uuid = string & { readonly __brand: 'uuid' };
export type uuid7 = string & { readonly __brand: 'uuid7' };

export function toInt(n: number | boolean | string): int {
    return Math.trunc(Number(n)) as int;
}

export function toLong(n: number | boolean | string): long {
    return Math.trunc(Number(n)) as long;
}

// Signum's `(decimal)x` cast. Runtime identity (a JS number); inside a query the nominator
// lowers it to a SQL CAST to decimal/numeric, so subsequent arithmetic is decimal — e.g.
// `toDecimal(a.id) / 10` divides in decimal and keeps the fractional places (Signum's `10m`),
// rather than integer-dividing and truncating.
export function toDecimal(n: number | boolean | string): decimal {
    return Number(n) as decimal;
}

// Signum's LinqHints.InSql: a query hint that forces `value` to be evaluated in the
// database. Runtime identity (returns its argument unchanged); inside a query lambda the
// binder wraps it so the nominator keeps the whole subtree as one SQL column, overriding
// the lazy projector (which otherwise computes arithmetic/comparison/conditionals on the
// client). Use it when SQL evaluation semantics are required — e.g. to preserve a decimal
// CAST's precision, or to force a computation onto the server.
export function inSql<T>(value: T): T {
    return value;
}

export { Temporal } from 'temporal-polyfill';
export { Decimal } from 'decimal.js';
