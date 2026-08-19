import { tryGetTypeInfo } from "../reflection";
import { resolveCleanType } from "../registration";
import { getKey } from "./queryUtils";
import { SubTokensOptionsAll, type QueryToken } from "./tokens/queryToken";

// The default columns of a query, derived from REFLECTION alone — the isomorphic half of what used to live
// entirely in `Finder.getDefaultColumns`.
//
// It moved here because the SERVER needs it too: `UserQueriesLogic.toQueryRequest` has to resolve a stored
// UserQuery's ColumnsMode (Add / Remove / ReplaceOrAdd all reference "the query's default columns"), and
// Signum answers that from `QueryDescription.Columns` — a DTO altea does not have (see the repo CLAUDE.md).
//
// The CLIENT keeps its own wrapper, because a `Type.querySettings.defaultColumns` override is client-side
// configuration that the server cannot see; `Finder.getDefaultColumns` consults that first and falls back
// to this. A server caller therefore always gets the reflection-derived list.

/**
 * The entity's Id first, then the first 5 non-collection FIELDS of the entity — its own declared
 * properties, in declaration order — and NOT the system/meta tokens (ToString, HasValue, Count, …) that
 * also appear as subtokens.
 *
 * Signum showed the query's declared columns; altea keeps the grid tidy and lets
 * `Type.querySettings.defaultColumns` override it on the client.
 */
export function reflectionDefaultColumns(queryToken: QueryToken): QueryToken[] {
    const subTokens = queryToken.subTokens(SubTokensOptionsAll)
        .filter(a => !a.hasAggregate() && !a.hasTimeSeries() && a.type?.array !== true);

    const idToken = subTokens.find(t => t.key.toLowerCase() === "id");

    // The entity's declared field names, in declaration order (insertion order of the reflection dict).
    // A subtoken is one of the entity's own fields iff its key is in this set — this filters out the
    // system tokens (ToString/HasValue/…) which are not entity fields.
    // The query name is the entity CTOR for an entity query, and a registered key otherwise; both resolve
    // to the ctor the TypeInfo hangs off (the client layer does the same through its PseudoType helper).
    const ctor = typeof queryToken.queryName === "function"
        ? queryToken.queryName
        : resolveCleanType(getKey(queryToken.queryName));
    const ti = ctor == null ? undefined : tryGetTypeInfo(ctor);
    const fieldOrder = ti ? Object.keys(ti.fields).map(k => k.toLowerCase()) : [];
    const declIndex = (t: QueryToken): number => {
        const i = fieldOrder.indexOf(t.key.toLowerCase());
        return i < 0 ? Number.MAX_VALUE : i;
    };

    const fieldTokens = subTokens
        .filter(t => t !== idToken && declIndex(t) !== Number.MAX_VALUE)
        .sort((a, b) => declIndex(a) - declIndex(b))
        .slice(0, 5);

    return [idToken, ...fieldTokens].filter((t): t is QueryToken => t != null);
}
