import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import { TypeReference } from "../../reflection";
import { QueryTokenMessage } from "../../dynamicQueries";
import { QueryToken, SubTokensOptions } from "./queryToken";

// A distance is a SCORE, not a count. Signum types it `float?`; altea's nearest equivalent is a nullable
// fractional number, so the client renders and filters it as one (`0.####`, Signum's own format).
const TR_DISTANCE = new TypeReference({ typeName: "Number", subTypeName: "decimal", isNullable: true });

/**
 * Port of Signum's `VectorDistanceToken`: HOW FAR this row's embedding is from the one the search asked
 * for — the column a result list is ordered by when "most similar" is what the user meant.
 *
 * Signum reaches it through a synthetic `VectorColumnToken`, which it mints from the table's
 * `VectorTableIndex` entries (server-side, off `Schema.Current`). altea has no such token: its token tree
 * is built from ISOMORPHIC reflection with no Schema to consult, and the vector column already has a token
 * of its own — the ordinary `EntityPropertyToken` for the property. So `Distance` hangs off THAT, which is
 * also where altea puts the `SmartSearch` filter operation, exactly as `MatchRank` hangs off the
 * full-text-indexed string property rather than off a synthetic tsvector-column token.
 *
 * It is offered only for a column carrying a `@vectorIndex` — Signum's rule too, and not merely a
 * convention: the index is what names the distance METRIC, and a distance measured by the wrong metric is
 * a plausible-looking wrong answer rather than an error.
 *
 * The expression is in `server/dynamicQuery/tokenExpressions.ts`; BOTH providers are implemented there
 * (pgvector's `cosine_distance`/… and SQL Server's `VECTOR_DISTANCE`).
 */
export class VectorDistanceToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "Distance"; }
    override toString(): string { return QueryTokenMessage.VectorDistance.niceToString(); }
    niceName(): string { return QueryTokenMessage.VectorDistanceFor0.niceToString(this._parent.niceName()); }
    get type(): TypeReference { return TR_DISTANCE; }
    /** Signum's `Format => "0.####"` — a distance is only ever read to four decimals. */
    get format(): string | undefined { return "0.####"; }
    get unit(): string | undefined { return undefined; }
    // Signum returns null for both: the distance is a computed score against this search, not a stored
    // member, so it inherits neither a property route (and so no property-level auth of its own) nor
    // implementations. The parent's rule still governs it, via isAllowed.
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
