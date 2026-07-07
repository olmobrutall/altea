import { LiteralType, ArrayType, Type } from "../../../entities/types";
import { asStaticFunction, Query, sqlMethod, resultType } from "../../query";

// Port of Signum's Engine/Sync/Postgres/PostgresFunctions.cs — the "mini LINQ provider" of
// Postgres-only functions the catalog reader / SchemaAssets need to build DiffTable and read
// views/procedures entirely inside the query (mirroring the SQL Server reader). Each is a
// query-only marker: the body throws at runtime, and the QueryBinder recognises it by its
// brand and lowers it to the corresponding SQL. `@sqlMethod` / `__resultType` type + name the
// call; a scalar result type lowers to a `<name>(args)` SqlFunctionExpression, an array result
// type to a set-/table-returning source.

// A set-returning function: `generate_subscripts(arr, dim)` yields the 1-based subscripts of
// `arr`. Used as a collection in a projection (`.map(i => …)`), it becomes a
// CROSS JOIN LATERAL over the SRF, exactly like Signum's `generate_subscripts(...).Select(...)`.
export function generateSubscripts(_array: unknown[], _dim: number): Query<number> {
    throw new Error("generateSubscripts is a query-only Postgres function marker.");
}

// Array element access `arr[index]` (Postgres arrays are 1-based). Signum writes `conkey[i]`,
// but the quote-transformer has no computed-element-access node (ExProperty is a named `.prop`,
// ExArray is an array literal), so a subscript can't be quoted — this call stands in and lowers
// to a SqlArrayIndexExpression.
export function arrayGet<T>(_array: T[], _index: number): T {
    throw new Error("arrayGet is a query-only Postgres function marker.");
}

// Signum's `PostgresFunctions` static class: the scalar SQL functions the catalog reader /
// SchemaAssets call from inside a query (Signum's [SqlMethod]). @sqlMethod names the SQL
// function; @resultType types the scalar call node. The QueryBinder lowers each to a
// `<name>(args)` SqlFunctionExpression.
export class PostgresFunctions {
    // `pg_get_expr(pg_node_tree, relid)` — decompiles a stored expression (a column default's
    // adbin, or an index's indpred) to its SQL text.
    @sqlMethod("pg_get_expr")
    @resultType(() => LiteralType.string)
    static pg_get_expr(_node: unknown, _relid: number): string {
        throw new Error("PostgresFunctions.pg_get_expr is a query-only Postgres function marker.");
    }

    // `information_schema._pg_char_max_length(typid, typmod)` — the declared max length of a
    // char/varchar column (NULL for unbounded / non-character types). Signum uses it for Length.
    @sqlMethod("information_schema._pg_char_max_length")
    @resultType(() => LiteralType.number)
    static _pg_char_max_length(_typid: number, _typmod: number): number {
        throw new Error("PostgresFunctions._pg_char_max_length is a query-only Postgres function marker.");
    }

    // `pg_get_viewdef(oid)` — decompiles a view's stored query to its SQL text (SchemaAssets.SyncViews).
    @sqlMethod("pg_catalog.pg_get_viewdef")
    @resultType(() => LiteralType.string)
    static pg_get_viewdef(_oid: number): string {
        throw new Error("PostgresFunctions.pg_get_viewdef is a query-only Postgres function marker.");
    }

    // `pg_get_functiondef(oid)` — the full `CREATE OR REPLACE FUNCTION …` text of a function
    // (SchemaAssets.SyncProcedures).
    @sqlMethod("pg_catalog.pg_get_functiondef")
    @resultType(() => LiteralType.string)
    static pg_get_functiondef(_oid: number): string {
        throw new Error("PostgresFunctions.pg_get_functiondef is a query-only Postgres function marker.");
    }
}

// ---- brands the QueryBinder keys off (see visitCall) ----
// The scalar functions above are branded declaratively by @sqlMethod. The two free-function
// markers below carry their own brands: generate_subscripts is a set-returning source
// (__sqlMethod + an array result type), arrayGet is an array subscript.

interface Srf { __sqlMethod?: string }
interface ArrayIndexFn { __arrayIndex?: boolean }

(generateSubscripts as unknown as Srf).__sqlMethod = "generate_subscripts";
(arrayGet as unknown as ArrayIndexFn).__arrayIndex = true;

// fromQuoted types each free-function call via __resultType (the AST never carries a Promise).
asStaticFunction(generateSubscripts).__resultType = () => new ArrayType(LiteralType.number);
asStaticFunction(arrayGet).__resultType = (_thisType: Type, arrType: Type) =>
    arrType instanceof ArrayType && arrType.elementType != null ? arrType.elementType : LiteralType.number;
