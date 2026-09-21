import { Column, Order, Pagination, QueryRequest, Filter, FilterCondition, FilterGroup } from "@altea/altea/server/dynamicQuery/requests";
import { AggregateToken, AggregateFunction } from "@altea/altea/data/dynamicQuery/tokens/aggregateToken";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { getKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import { DashboardBehaviour } from "@altea/altea/data/dynamicQueries";
import type { QueryFilterPinnedBaseEntity } from "@altea/altea-user-assets/data/Queries";
import type { IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import type { Lite } from "@altea/altea/data/lite";
import type { DashboardEntity, DashboardEntity_Part, DashboardEntity_TokenEquivalenceGroup } from "../data/Dashboard";

// Port of the DEFINITION half of Signum.Dashboard/DashboardLogic.cs — deciding WHICH queries a dashboard's
// snapshot has to contain, and how few of them can cover every part.
//
// Two things drive it. A part that can WRITE filters (a user query, a chart you click to cross-filter)
// forces every other part in its interaction group to carry the columns those filters name, because the
// filtering happens in the BROWSER against the snapshot: a column that is not in the file cannot be
// filtered on. And a part whose filters are PINNED needs its pinned tokens as columns for the same reason.
// Then the requests that differ only by columns are merged, so ten parts over one query cost one file.
//
// altea divergences:
//  - Signum keys its equivalence dictionary by `QueryToken` (value-equal in C#); altea keys by
//    `fullKey()`, which is the same identity and is what the wire form carries anyway.
//  - `QueryUtils.CanColumn` has no counterpart, so an expansion into a grouping query is checked for
//    GROUPABILITY only (Signum checks both). A non-groupable token is the case that actually happens.
//  - Signum's CountNotNull is spelled with altea's AggregateToken options (`{ filterOperation: "DistinctTo",
//    value: null }`), whose `key` then reads "CountNotNull" — the name the client executor looks it up by.

/** Signum's CachedQueryDefinition — one part's query, and what it needs from the snapshot. */
export interface CachedQueryDefinition {
    queryRequest: QueryRequest;
    /** Signum's `PinnedFiltersTokens`: (token, promotedToDashboard) for every PINNED filter of the asset. */
    pinnedFiltersTokens: { token: QueryToken; promotedToDashboard: boolean }[];
    panelPart: DashboardEntity_Part;
    userAsset: Lite<IUserAssetEntity>;
    /** Signum's IsQueryCached — the part opted in to being served from the snapshot. */
    isQueryCached: boolean;
    /** Signum's CanWriteFilters — clicking this part cross-filters its interaction group. */
    canWriteFilters: boolean;
}

/**
 * Signum's `Filters.GetDashboardPinnedFilterTokens()` — the tokens of every PINNED filter of a user asset,
 * each flagged with whether it is promoted to the dashboard's own filter bar. Signum's stored filters are a
 * FLAT list with an `indentation` column standing in for nesting, so a group is "the following filters at
 * one more indent" — which is why this walks by indent rather than by structure.
 */
export function getDashboardPinnedFilterTokens(
    // PINNED rows specifically: only a user query / user chart reaches here, and only those can pin.
    filters: QueryFilterPinnedBaseEntity[],
    indent = 0,
): { token: QueryToken; promotedToDashboard: boolean }[] {
    const result: { token: QueryToken; promotedToDashboard: boolean }[] = [];

    for (const group of groupWhen(filters, f => (f.indentation as number) === indent)) {
        const head = group.key;
        if (head == null)
            continue;

        if (head.pinned != null) {
            const promotedToDashboard = head.dashboardBehaviour === DashboardBehaviour.PromoteToDasboardPinnedFilter;
            const tokens = [head, ...group.items].map(f => f.token?.token).filter((t): t is QueryToken => t != null);
            for (const token of distinctByKey(tokens))
                result.push({ token, promotedToDashboard });
        } else if (head.isGroup) {
            result.push(...getDashboardPinnedFilterTokens(group.items, indent + 1));
        }
    }

    return result;
}

/**
 * Signum's `GetCachedQueryDefinitions(db)` — every part's definition, EXPANDED so the snapshot carries
 * what the browser will need, then narrowed to the parts that asked to be cached.
 */
export function getCachedQueryDefinitions(
    db: DashboardEntity,
    definitionsOf: (part: DashboardEntity_Part) => CachedQueryDefinition[],
): CachedQueryDefinition[] {
    const definitions = (db.parts ?? []).flatMap(definitionsOf);

    // 1. Cross-filtering inside an INTERACTION GROUP: whatever a writer can filter by, every other part of
    //    the group must carry as a column — and must be paginated ALL, since a filter applied in the
    //    browser cannot be paged server-side.
    const byGroup = new Map<number, CachedQueryDefinition[]>();
    for (const d of definitions) {
        const g = d.panelPart.interactionGroup;
        if (g == null)
            continue;
        const list = byGroup.get(g as number) ?? [];
        list.push(d);
        byGroup.set(g as number, list);
    }

    for (const [group, defs] of byGroup) {
        const writers = defs.filter(d => d.canWriteFilters);
        if (writers.length === 0)
            continue;

        const groups = (db.tokenEquivalencesGroups ?? [])
            .filter(g => g.interactionGroup === group || g.interactionGroup == null);

        for (const writer of writers) {
            const keyColumns = distinctByKey(writer.queryRequest.columns
                .filter(c => !writer.queryRequest.groupResults || !c.token.isAggregate())
                .map(c => c.token));

            const equivalences = equivalenceDictionary(groups, writer.queryRequest.queryName);

            for (const other of defs.filter(d => d !== writer)) {
                const extra = extraColumns(keyColumns, other, equivalences);
                if (extra.length > 0)
                    expandColumns(other, extra, "Dashboard Filters from " + group);

                other.queryRequest.pagination = new Pagination.All();
            }
        }
    }

    // 2. PINNED filters: a part's own pinned tokens must be columns of its own request, and a token
    //    promoted to the DASHBOARD's filter bar must be a column of every part it can reach.
    for (const writer of definitions) {
        if (writer.pinnedFiltersTokens.length === 0)
            continue;

        const own = writer.pinnedFiltersTokens.filter(a => !a.promotedToDashboard).map(a => a.token);
        if (own.length > 0)
            expandColumns(writer, own, "Pinned Filters");

        const promoted = writer.pinnedFiltersTokens.filter(a => a.promotedToDashboard).map(a => a.token);
        if (promoted.length === 0)
            continue;

        const groups = (db.tokenEquivalencesGroups ?? []).filter(g => g.interactionGroup == null);
        const equivalences = equivalenceDictionary(groups, writer.queryRequest.queryName);

        for (const other of definitions.filter(d => d !== writer)) {
            const extra = extraColumns(promoted, other, equivalences);
            if (extra.length > 0)
                expandColumns(other, extra, "Dashboard Pinned Filters");
        }
    }

    return definitions.filter(d => d.isQueryCached);
}

/** Signum's `CombineCachedQueryDefinitions` — fold the definitions into as few requests as cover them. */
export function combineCachedQueryDefinitions(definitions: CachedQueryDefinition[]): CombinedCachedQueryDefinition[] {
    const result: CombinedCachedQueryDefinition[] = [];

    for (const d of definitions) {
        if (!result.some(r => r.combineIfPossible(d)))
            result.push(new CombinedCachedQueryDefinition(d));
    }

    return result;
}

/** Signum's CombinedCachedQueryDefinition — one request, and every user asset it answers for. */
export class CombinedCachedQueryDefinition {
    queryRequest: QueryRequest;
    readonly userAssets: Lite<IUserAssetEntity>[];

    constructor(definition: CachedQueryDefinition) {
        this.queryRequest = definition.queryRequest;
        this.userAssets = [definition.userAsset];
    }

    /**
     * Signum's `CombineIfPossible` — can this definition ride on the request already here? Only when the
     * two ask the same QUESTION and differ at most in which columns they select: same query, same
     * grouping (and, when grouping, the same key columns), no filter either side lacks, and a pagination
     * one of them subsumes.
     */
    combineIfPossible(definition: CachedQueryDefinition): boolean {
        const me = this.queryRequest;
        const other = definition.queryRequest;

        if (getKey(me.queryName) !== getKey(other.queryName))
            return false;

        if (me.groupResults !== other.groupResults)
            return false;

        if (me.groupResults) {
            const keys = (r: QueryRequest): Set<string> =>
                new Set(r.columns.filter(c => !c.token.isAggregate()).map(c => c.token.fullKey()));
            if (!setEquals(keys(me), keys(other)))
                return false;
        }

        // A filter either side does not have changes what the rows ARE, so the two cannot share a file.
        if (exceptFilters(me.filters, other.filters).length > 0 || exceptFilters(other.filters, me.filters).length > 0)
            return false;

        // Pagination All subsumes anything; otherwise the two must page and order identically.
        if (me.pagination instanceof Pagination.All)
            return this.take(withExtraColumns(me, other), definition);

        if (other.pagination instanceof Pagination.All)
            return this.take(withExtraColumns(other, me), definition);

        if (samePagination(me.pagination, other.pagination) && sameOrders(me.orders, other.orders))
            return this.take(withExtraColumns(me, other), definition);

        return false; // Signum's "More cases?"
    }

    private take(request: QueryRequest, definition: CachedQueryDefinition): boolean {
        this.queryRequest = request;
        this.userAssets.push(definition.userAsset);
        return true;
    }
}

// ---- expansion --------------------------------------------------------------------------------------

/**
 * Signum's `ExtraColumns` — of the tokens a writer can filter by, the ones this definition does not
 * already select, TRANSLATED into its own query's vocabulary through the equivalence groups.
 */
function extraColumns(
    requiredTokens: QueryToken[],
    definition: CachedQueryDefinition,
    equivalences: Map<string, Map<string, QueryToken[]>>,
): QueryToken[] {
    const result: QueryToken[] = [];

    for (const token of requiredTokens) {
        const translated = translatedToken(token, definition.queryRequest.queryName, equivalences);
        if (translated == null)
            continue;

        // Signum: "Doesn't really matter if we add Product or Entity.Product" — any of the equivalents
        // will do, so if none is selected yet take the first.
        const already = definition.queryRequest.columns.some(c => translated.some(t => t.fullKey() === c.token.fullKey()));
        if (!already)
            result.push(translated[0]);
    }

    return result;
}

/**
 * Signum's `ExpandColumns` — add the columns, and replace an AVERAGE with the Sum and Count it can be
 * recomputed from. An average cannot be averaged again across groups; a sum and a count can, which is what
 * lets the browser re-group a snapshot.
 */
function expandColumns(definition: CachedQueryDefinition, extra: QueryToken[], errorContext: string): void {
    const request = definition.queryRequest;

    if (request.groupResults) {
        const errors = extra.filter(t => !t.isGroupable);
        if (errors.length > 0)
            throw new Error(`Unable to expand columns in '${definition.userAsset.key()}' `
                + `(query ${getKey(request.queryName)}) requested by ${errorContext} because: \n`
                + errors.map(t => t.fullKey() + ": is not groupable").join("\n"));
    }

    request.columns = [...request.columns, ...extra.map(t => new Column(t))];

    const averages = request.columns.filter(c =>
        c.token instanceof AggregateToken && c.token.aggregateFunction === AggregateFunction.Average);

    for (const avg of averages) {
        const parent = (avg.token as AggregateToken).parent!;
        request.columns = request.columns.filter(c => c !== avg);
        request.columns.push(new Column(new AggregateToken(AggregateFunction.Sum, parent)));
        // Signum's `new AggregateToken(Count, parent, FilterOperation.DistinctTo, null)` — a count of the
        // rows whose value is NOT NULL, which is the denominator an average needs. Its key comes out
        // "CountNotNull", and that is the name the client executor looks the column up by, so a plain
        // Count (which counts ROWS) would both mis-divide and not be found.
        request.columns.push(new Column(new AggregateToken(AggregateFunction.Count, parent,
            { filterOperation: "DistinctTo", value: null })));
    }
}

/**
 * Signum's `GetEquivalenceDictionary` — from the dashboard's token-equivalence groups, a map from a token
 * of the SOURCE query to the equivalent tokens of every other query, so a filter written on one part can
 * be applied to a part over a different query.
 */
function equivalenceDictionary(
    groups: DashboardEntity_TokenEquivalenceGroup[],
    fromQuery: QueryName,
): Map<string, Map<string, QueryToken[]>> {
    const result = new Map<string, Map<string, QueryToken[]>>();

    for (const group of groups) {
        const equivalences = group.tokenEquivalences ?? [];
        for (const te of equivalences.filter(a => a.query.key === getKey(fromQuery))) {
            const token = te.token?.token;
            if (token == null)
                continue;

            const byQuery = new Map<string, QueryToken[]>();
            for (const other of equivalences) {
                const otherToken = other.token?.token;
                if (otherToken == null)
                    continue;
                const list = byQuery.get(other.query.key) ?? [];
                list.push(otherToken);
                byQuery.set(other.query.key, list);
            }

            result.set(token.fullKey(), byQuery);
        }
    }

    return result;
}

/**
 * Signum's `TranslatedToken` — the same token as seen by ANOTHER query, or null if it cannot be seen there.
 *
 * Walk up from the token; at each step ask whether a token equivalence maps it into the target query, and
 * if so re-descend the steps walked past from the equivalent's own root (a token belongs to one query, so
 * it cannot simply be reused). Three outcomes, in Signum's order:
 *
 *  1. an equivalence at some ancestor (or at the token itself) → the translated token;
 *  2. an equivalence declared at the ROOT — "these two queries are about the same entity";
 *  3. neither, but the two queries are THE SAME → the token unchanged. This is the ordinary case, and the
 *     only one that needs no configuration at all: a dashboard whose parts all query Order cross-filters
 *     with no token equivalence anywhere.
 *
 * altea divergence: Signum's root is `QueryUtils.Parse("Entity", …)`; altea's query tokens are ROOTLESS, so
 * the root entity token is the EMPTY key and "Entity" does not resolve at all.
 */
function translatedToken(
    original: QueryToken,
    targetQueryName: QueryName,
    equivalences: Map<string, Map<string, QueryToken[]>>,
): QueryToken[] | null {
    const targetKey = getKey(targetQueryName);
    const toAppend: QueryToken[] = [];

    const translate = (list: QueryToken[]): QueryToken[] | null => {
        const translated = list.map(base => appendTokens(base, toAppend)).filter((t): t is QueryToken => t != null);
        return translated.length > 0 ? translated : null;
    };

    for (let t: QueryToken | undefined = original; t != null; t = t.parent) {
        // 1. an equivalence AT this step. Asked before pushing it, so `toAppend` holds only what is BELOW.
        const list = equivalences.get(t.fullKey())?.get(targetKey);
        if (list != null && list.length > 0)
            return translate(list);

        toAppend.unshift(t);

        // 2. at the top, an equivalence declared at the root entity token.
        if (t.parent == null) {
            const root = tryRootToken(original.queryName);
            const rootList = root == null ? undefined : equivalences.get(root.fullKey())?.get(targetKey);
            if (rootList != null && rootList.length > 0)
                return translate(rootList);
        }
    }

    // 3. same query — the token is already the target's own.
    return getKey(original.queryName) === targetKey ? [original] : null;
}

/** The query's root entity token, or undefined if it cannot be resolved (never, in practice). */
function tryRootToken(queryName: QueryName): QueryToken | undefined {
    try {
        return QueryLogic.getToken(queryName, "", SubTokensOptionsAll);
    } catch {
        return undefined;
    }
}

/**
 * Re-apply the steps walked past in translatedToken, by KEY — a token belongs to ONE query, so the
 * equivalent has to be re-descended from the target query's own token rather than reused.
 *
 * Returns undefined when the target query has no such step, which is a real outcome rather than a fault:
 * two queries can be declared equivalent at one token and diverge below it, and the caller then simply
 * adds no column. (Signum THROWS a FormatException here. Refusing to build any snapshot because one
 * sibling's token does not exist in one other query is a harsher answer than the situation deserves —
 * that part just queries live.)
 */
function appendTokens(base: QueryToken, toAppend: QueryToken[]): QueryToken | undefined {
    let current: QueryToken | undefined = base;
    for (const step of toAppend) {
        current = current.subToken(step.key, SubTokensOptionsAll);
        if (current == null)
            return undefined;
    }
    return current;
}

// ---- small helpers ----------------------------------------------------------------------------------

/** Signum's `WithExtraColumns` — `me` plus whatever `other` selects that it does not. */
function withExtraColumns(me: QueryRequest, other: QueryRequest): QueryRequest {
    const extra = other.columns
        .filter(c => !me.groupResults || c.token.isAggregate())
        .filter(c => !me.columns.some(c2 => c.token.fullKey() === c2.token.fullKey()));

    if (extra.length === 0)
        return me;

    return new QueryRequest(me.queryName, me.filters, me.orders, [...me.columns, ...extra],
        me.pagination, me.groupResults, me.systemTime);
}

/** Signum's `FilterComparer` applied as a set difference: the filters of `a` that `b` does not have. */
function exceptFilters(a: Filter[], b: Filter[]): Filter[] {
    return a.filter(f => !b.some(g => filtersEqual(f, g)));
}

function filtersEqual(a: Filter, b: Filter): boolean {
    if (a instanceof FilterGroup) {
        if (!(b instanceof FilterGroup))
            return false;
        return a.token?.fullKey() === b.token?.fullKey()
            && a.groupOperation === b.groupOperation
            && a.filters.length === b.filters.length
            && a.filters.every(af => b.filters.some(bf => filtersEqual(af, bf)));
    }

    if (b instanceof FilterGroup)
        return false;

    const ac = a as FilterCondition;
    const bc = b as FilterCondition;
    return ac.token.fullKey() === bc.token.fullKey()
        && ac.operation === bc.operation
        && sameValue(ac.value, bc.value);
}

function sameValue(a: unknown, b: unknown): boolean {
    if (a === b)
        return true;
    // A lite / entity compares by key, not by identity: each request built its own instance.
    const key = (v: unknown): string | undefined =>
        v != null && typeof (v as { key?: () => string }).key === "function"
            ? (v as { key(): string }).key() : undefined;
    const ka = key(a);
    return ka != null && ka === key(b);
}

function samePagination(a: Pagination, b: Pagination): boolean {
    return a.getMode() === b.getMode()
        && a.getElementsPerPage() === b.getElementsPerPage()
        && (a instanceof Pagination.Paginate ? a.currentPage : undefined)
        === (b instanceof Pagination.Paginate ? b.currentPage : undefined);
}

function sameOrders(a: Order[], b: Order[]): boolean {
    return a.length === b.length
        && a.every((o, i) => o.token.fullKey() === b[i].token.fullKey() && o.orderType === b[i].orderType);
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
    return a.size === b.size && [...a].every(x => b.has(x));
}

function distinctByKey(tokens: QueryToken[]): QueryToken[] {
    const seen = new Set<string>();
    return tokens.filter(t => {
        const k = t.fullKey();
        if (seen.has(k))
            return false;
        seen.add(k);
        return true;
    });
}

/** Signum's `GroupWhen`: start a new group at each element matching the predicate. */
function groupWhen<T>(items: T[], isKey: (item: T) => boolean): { key: T | null; items: T[] }[] {
    const result: { key: T | null; items: T[] }[] = [];
    for (const item of items) {
        if (isKey(item) || result.length === 0)
            result.push({ key: isKey(item) ? item : null, items: [] });
        else
            result[result.length - 1].items.push(item);
    }
    return result;
}
