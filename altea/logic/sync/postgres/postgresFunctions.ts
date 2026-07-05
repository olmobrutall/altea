import { LiteralType, ArrayType, Type } from "../../../entities/types";
import { asStaticFunction, Query } from "../../query";

// Port of Signum's Engine/Sync/Postgres/PostgresFunctions.cs — the "mini LINQ provider" of
// Postgres-only functions the catalog reader needs to build DiffTable entirely inside the
// query (mirroring the SQL Server reader). Each is a query-only marker: the body throws at
// runtime, and the QueryBinder recognises the function by the brand attached below and lowers
// it to the corresponding SQL (a scalar function, an array subscript, or a set-returning
// function source). `__resultType` lets fromQuoted type the call node.

// A set-returning function: `generate_subscripts(arr, dim)` yields the 1-based subscripts of
// `arr`. Used as a collection in a projection (`.map(i => …)`), it becomes a
// CROSS JOIN LATERAL over the SRF, exactly like Signum's `generate_subscripts(...).Select(...)`.
export function generateSubscripts(_array: unknown[], _dim: number): Query<number> {
    throw new Error("generateSubscripts is a query-only Postgres function marker.");
}

// Array element access `arr[index]` (Postgres arrays are 1-based). Signum writes `conkey[i]`;
// altea can't quote element access, so this call stands in and lowers to a SqlArrayIndexExpression.
export function arrayGet<T>(_array: T[], _index: number): T {
    throw new Error("arrayGet is a query-only Postgres function marker.");
}

// `pg_get_expr(pg_node_tree, relid)` — decompiles a stored expression (a column default's
// adbin, or an index's indpred) to its SQL text.
export function pg_get_expr(_node: unknown, _relid: number): string {
    throw new Error("pg_get_expr is a query-only Postgres function marker.");
}

// `information_schema._pg_char_max_length(typid, typmod)` — the declared max length of a
// char/varchar column (NULL for unbounded / non-character types). Signum uses it for Length.
export function _pg_char_max_length(_typid: number, _typmod: number): number {
    throw new Error("_pg_char_max_length is a query-only Postgres function marker.");
}

// ---- brands the QueryBinder keys off (see visitCall) ----

interface Srf { __srfName?: string }
interface ScalarSqlFn { __scalarSqlName?: string }
interface ArrayIndexFn { __arrayIndex?: boolean }

(generateSubscripts as unknown as Srf).__srfName = "generate_subscripts";
(arrayGet as unknown as ArrayIndexFn).__arrayIndex = true;
(pg_get_expr as unknown as ScalarSqlFn).__scalarSqlName = "pg_get_expr";
(_pg_char_max_length as unknown as ScalarSqlFn).__scalarSqlName = "information_schema._pg_char_max_length";

// fromQuoted types each call via __resultType (the AST never carries a Promise).
asStaticFunction(generateSubscripts).__resultType = () => new ArrayType(LiteralType.number);
asStaticFunction(arrayGet).__resultType = (_thisType: Type, arrType: Type) =>
    arrType instanceof ArrayType && arrType.elementType != null ? arrType.elementType : LiteralType.number;
asStaticFunction(pg_get_expr).__resultType = () => LiteralType.string;
asStaticFunction(_pg_char_max_length).__resultType = () => LiteralType.number;
