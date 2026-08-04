import type { Vector } from "../data/vector";
import { LiteralType, quotedFunction } from "./runtimeTypes";

// Query-only vector-search functions (Signum's PgVectorSearch / SqlVectorSearch). Usable only
// inside a database query, where the QueryBinder lowers them to the dialect's distance / norm /
// normalize SQL; the bodies throw. A Vector argument may be a column (`a.embedding`) or a constant.

// ---- Postgres (pgvector) --------------------------------------------------------------------

// pgvector distance metrics (Signum's PGVectorDistanceMetric). The runtime/wire value is the
// member NAME (a string), matching the vectorIndex decorator's metric option.
export type PGVectorDistanceMetric = "Cosine" | "L2" | "InnerProduct" | "L1";

// The pgvector distance FUNCTION for a metric (Signum's GetPgVectorDistanceFunction).
export function pgVectorDistanceFunction(metric: PGVectorDistanceMetric): string {
    switch (metric) {
        case "Cosine": return "cosine_distance";
        case "L2": return "l2_distance";
        case "InnerProduct": return "inner_product";
        case "L1": return "l1_distance";
    }
}

const onlyPg = (method: string): never => {
    throw new Error(`PgVectorSearch.${method} is only supported inside a Postgres database query`);
};

export const PgVectorSearch = {
    // The distance between two vectors under `metric` (cosine_distance / l2_distance / …). Returns a
    // float; order a query by it for nearest-neighbour search.
    distance(metric: PGVectorDistanceMetric, vector1: Vector, vector2: Vector): number { return onlyPg("distance"); },
    // The Euclidean (L2) norm of a vector — l2_norm(v).
    l2Norm(vector: Vector): number { return onlyPg("l2Norm"); },
    // The vector normalized to unit length — l2_normalize(v). Returns a Vector.
    normalize(vector: Vector): Vector { return onlyPg("normalize"); },
};

quotedFunction(PgVectorSearch.distance as unknown as Function).__resultType = () => LiteralType.number;
quotedFunction(PgVectorSearch.l2Norm as unknown as Function).__resultType = () => LiteralType.number;
// normalize returns a Vector — typed null (an opaque value); the DB returns the `[…]` literal.
quotedFunction(PgVectorSearch.normalize as unknown as Function).__resultType = () => LiteralType.null;

// [AvoidEagerEvaluation]: a call over two constant vectors is parameter-independent, so the
// partial-evaluator would otherwise FOLD it by executing the throwing body — mark them so it stays a
// quoted expression the QueryBinder lowers to SQL (Signum uses .InSql(); __avoidEager is altea's).
for (const f of [PgVectorSearch.distance, PgVectorSearch.l2Norm, PgVectorSearch.normalize] as unknown as { __avoidEager?: boolean }[])
    f.__avoidEager = true;

// ---- SQL Server (native VECTOR) -------------------------------------------------------------

export type SqlVectorDistanceMetric = "Cosine" | "Euclidean" | "DotProduct";
export type SqlVectorNormType = "Norm1" | "Norm2" | "NormInf";

// The VECTOR_DISTANCE metric keyword (Signum's GetSqlVectorDistanceMetric).
export function sqlVectorDistanceKeyword(metric: SqlVectorDistanceMetric): string {
    switch (metric) {
        case "Cosine": return "cosine";
        case "Euclidean": return "euclidean";
        case "DotProduct": return "dot";
    }
}

// The VECTOR_NORM norm-type keyword (Signum's GetSqlVectorNormType).
export function sqlVectorNormKeyword(normType: SqlVectorNormType): string {
    switch (normType) {
        case "Norm1": return "norm1";
        case "Norm2": return "norm2";
        case "NormInf": return "norminf";
    }
}

const onlySs = (method: string): never => {
    throw new Error(`SqlVectorSearch.${method} is only supported inside a SQL Server database query`);
};

export const SqlVectorSearch = {
    // VECTOR_DISTANCE('cosine'|'euclidean'|'dot', v1, v2) — a float.
    vectorDistance(metric: SqlVectorDistanceMetric, vector1: Vector, vector2: Vector): number { return onlySs("vectorDistance"); },
    // VECTOR_NORM(v, 'norm2') — a float.
    vectorNorm(vector: Vector, normType: SqlVectorNormType): number { return onlySs("vectorNorm"); },
    // VECTOR_NORMALIZE(v, 'norm2') — a Vector.
    vectorNormalize(vector: Vector, normType: SqlVectorNormType): Vector { return onlySs("vectorNormalize"); },
};

quotedFunction(SqlVectorSearch.vectorDistance as unknown as Function).__resultType = () => LiteralType.number;
quotedFunction(SqlVectorSearch.vectorNorm as unknown as Function).__resultType = () => LiteralType.number;
quotedFunction(SqlVectorSearch.vectorNormalize as unknown as Function).__resultType = () => LiteralType.null;

for (const f of [SqlVectorSearch.vectorDistance, SqlVectorSearch.vectorNorm, SqlVectorSearch.vectorNormalize] as unknown as { __avoidEager?: boolean }[])
    f.__avoidEager = true;
