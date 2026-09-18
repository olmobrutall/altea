import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import { TypeReference } from "../../reflection";
import { QueryTokenMessage } from "../../dynamicQueries";
import { QueryToken, SubTokensOptions, TR_STRING } from "./queryToken";

// A rank is a SCORE, not a count — `ts_rank` answers a float between 0 and 1. Signum types both its
// rank tokens `int?`, which is wrong for the Postgres one and would make the client render and filter
// the score as a whole number; altea types it a nullable fractional number.
const TR_RANK = new TypeReference({ typeName: "Number", subTypeName: "decimal", isNullable: true });

/**
 * Port of Signum's `FullTextRankToken` / `PgTsRankToken`: HOW WELL the row matched the full-text
 * filters placed on this same column — the column a search result is sorted by when "relevance" is
 * what the user asked for.
 *
 * Signum has two classes because its two providers reach the rank from different places: on Postgres
 * it hangs off a tsvector COLUMN token and lowers to `ts_rank(tsvector, tsquery)`; on SQL Server it
 * hangs off the indexed string property and is the `RANK` column of a `CONTAINSTABLE` / `FREETEXTTABLE`
 * that the query JOINs against. altea has ONE token, on the indexed string property — which is where
 * altea already puts the full-text FILTER operations — and only the Postgres half is implemented; see
 * `tokenExpressions.ts` for the SQL Server refusal and `port/TranslationGaps.md` for why.
 */
export class FullTextRankToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "Rank"; }
    override toString(): string { return QueryTokenMessage.MatchRank.niceToString(); }
    niceName(): string { return QueryTokenMessage.MatchRankFor0.niceToString(this._parent.niceName()); }
    get type(): TypeReference { return TR_RANK; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    // Signum returns null for both: the rank is a computed score, not a stored member, so it inherits
    // no route (and therefore no property-level auth of its own) and no implementations.
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}

/**
 * Port of Signum's `StringSnippetToken`: the few sentences of a long text that actually CONTAIN what
 * was searched for, so a search result shows the hit instead of the first 200 characters of the field.
 *
 * It is not a database expression in Signum either — the column selected is the text itself, and
 * `Highlighter.FindSnippet` runs in the application process over the fetched value. altea does the
 * same one stage later (see `server/dynamicQuery/snippet.ts`), which is why this token is provider-
 * independent where its sibling above is not.
 */
export class StringSnippetToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "Snippet"; }
    override toString(): string { return QueryTokenMessage.MatchSnippet.niceToString(); }
    // Signum's NiceName passes the parent's name to `MatchSnippet`, which has no placeholder — so the
    // argument is dropped and the long form reads exactly like the short one. `SnippetOf0` ("Snippet
    // for {0}") is declared for this and never used; altea uses it.
    niceName(): string { return QueryTokenMessage.SnippetOf0.niceToString(this._parent.niceName()); }
    get type(): TypeReference { return TR_STRING; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
