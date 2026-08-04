import type { TsQuery, TsVector } from "../tsVector";

export {}; // ensure this file is treated as a module (required for `declare global`)

// Postgres full-text query builders on `string` (Signum's TsVectorExtensions string helpers). Each
// lowers to the matching `*_tsquery` / `to_tsvector` SQL function inside a query; in memory there
// is nothing to compute, so the bodies throw. The optional `langConfig` selects the text-search
// configuration (defaults to the database's `default_text_search_config`).
declare global {
    interface String {
        /** `to_tsvector([langConfig,] value)` — a document vector from raw text. */
        toTsVector(this: string, langConfig?: string): TsVector;
        /** `to_tsquery([langConfig,] value)` — full tsquery syntax (`&`, `|`, `!`, `<->`, `:*`). */
        toTsQuery(this: string, langConfig?: string): TsQuery;
        /** `plainto_tsquery([langConfig,] value)` — plain text, terms AND-ed. */
        toTsQuery_Plain(this: string, langConfig?: string): TsQuery;
        /** `phraseto_tsquery([langConfig,] value)` — plain text, terms as an ordered phrase. */
        toTsQuery_Phrase(this: string, langConfig?: string): TsQuery;
        /** `websearch_to_tsquery([langConfig,] value)` — web-search syntax (quotes, OR, `-`). */
        toTsQuery_WebSearch(this: string, langConfig?: string): TsQuery;
    }
}

const onlyQueries = (method: string): never => {
    throw new Error(`String.${method} is only supported inside a database query`);
};

String.prototype.toTsVector = function (this: string): TsVector { return onlyQueries("toTsVector"); };
String.prototype.toTsQuery = function (this: string): TsQuery { return onlyQueries("toTsQuery"); };
String.prototype.toTsQuery_Plain = function (this: string): TsQuery { return onlyQueries("toTsQuery_Plain"); };
String.prototype.toTsQuery_Phrase = function (this: string): TsQuery { return onlyQueries("toTsQuery_Phrase"); };
String.prototype.toTsQuery_WebSearch = function (this: string): TsQuery { return onlyQueries("toTsQuery_WebSearch"); };

// Mark the builders with [AvoidEagerEvaluation] (altea's __avoidEager): a call like
// `"hello".toTsQuery()` is parameter-independent, so the partial-evaluator would otherwise FOLD it
// by executing the (throwing) body. __avoidEager makes isQueryMarker treat it as non-foldable, so
// it survives as a quoted expression the nominator lowers to the matching *_tsquery SQL. (Not
// __sqlMethod — that names a static SQL function and would drop the string receiver.)
for (const m of ["toTsVector", "toTsQuery", "toTsQuery_Plain", "toTsQuery_Phrase", "toTsQuery_WebSearch"] as const)
    (String.prototype[m] as unknown as { __avoidEager?: boolean }).__avoidEager = true;
