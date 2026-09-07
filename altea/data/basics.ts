// The NUMERIC widths, which JavaScript has one type for and a database has five. A bare `number`
// stores as the widest thing that always fits it (`float` / `float8`); these say narrower, so a
// column costs what the value needs and matches what a Signum model of the same shape declares
// (C#'s `short` / `int` / `long` / `float`). The brand is compile-time only — the runtime value is a
// plain number, and the transformer carries the ALIAS NAME through as the field's `subTypeName`,
// which is what `defaultDbType` maps.
export type short = number & { readonly __brand: 'short' };
export type int = number & { readonly __brand: 'int' };
export type long = number & { readonly __brand: 'long' };
/** Single-precision (C#'s `float` → `real` / `float4`). A bare `number` is DOUBLE precision. */
export type float = number & { readonly __brand: 'float' };

// Primary-key identifier types. `uuid7` is a time-ordered UUID (better index
// locality); both share the same column storage (uniqueidentifier / uuid) and
// differ only in how a new value is generated.
export type uuid = string & { readonly __brand: 'uuid' };
export type uuid7 = string & { readonly __brand: 'uuid7' };

export function toShort(n: number | boolean | string): short {
    return Math.trunc(Number(n)) as short;
}

export function toInt(n: number | boolean | string): int {
    return Math.trunc(Number(n)) as int;
}

export function toLong(n: number | boolean | string): long {
    return Math.trunc(Number(n)) as long;
}

/** A `float` from any number — no rounding: the brand records the COLUMN's precision, not the value's. */
export function toFloat(n: number | boolean | string): float {
    return Number(n) as float;
}

// Decimal values use the decimal.js `Decimal` class (exported below). Arithmetic inside a @quoted
// query body goes through the `Decimal.add/sub/mul/div/…` static methods, which are both exact
// in-memory and lowered to SQL numeric ops by the query engine (see server/decimalFunctions.ts).

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
