// Query-only Postgres full-text-search value types (Signum's NpgsqlTsVector / NpgsqlTsQuery, used
// via TsVectorExtensions). They have NO runtime representation — they exist so full-text query
// expressions type-check. Every operation is meaningful ONLY inside a database query, where the
// LINQ provider translates it to tsvector / tsquery SQL (`@@`, `to_tsquery`, `ts_rank`); there is
// nothing to run in memory. The matching string builders (`"…".toTsQuery()` etc.) live on the
// String prototype — see data/globals/tsVectorExtensions.ts.

// A tsquery value — the right-hand side of the `@@` match operator and the argument to ts_rank.
export interface TsQuery {
    /** tsquery AND — Postgres `a && b` (Signum's TsQuery.And). */
    and(other: TsQuery): TsQuery;
    /** tsquery OR — Postgres `a || b` (Signum's TsQuery.Or). */
    or(other: TsQuery): TsQuery;
}

// A tsvector value — the result of `entity.getTsVectorColumn()`.
export interface TsVector {
    /** `tsvector @@ tsquery` — whether the document matches the query (Signum's Matches). */
    matches(query: TsQuery): boolean;
    /** `ts_rank(tsvector, tsquery)` — the relevance rank (Signum's Rank). */
    rank(query: TsQuery): number;
    /** `ts_rank_cd(tsvector, tsquery)` — cover-density rank (Signum's RankCoverDensity). */
    rankCoverDensity(query: TsQuery): number;
}
