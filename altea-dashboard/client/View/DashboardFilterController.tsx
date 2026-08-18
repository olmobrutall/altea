import type {
    FilterConditionOptionParsed, FilterGroupOptionParsed, FilterOption, FilterOptionParsed, FindOptions,
} from "@altea/altea/client/FindOptions";
import { isActive, isFilterGroup } from "@altea/altea/client/FindOptions";
import { Finder } from "@altea/altea/client/Finder";
import { getQueryKey } from "@altea/altea/client/Reflection";
import { QueryToken, SubTokensOptions, tokenStartsWith } from "@altea/altea/client/QueryToken";
import type { FilterGroupOperation } from "@altea/altea/data/dynamicQueries";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { DashboardEntity, InteractionGroupEnum, DashboardEntity_Part } from "../../data/Dashboard";
import { DashboardClient } from "../DashboardClient";

// Port of Signum's Signum.Dashboard/View/DashboardFilterController.tsx. The DashboardController is the
// per-dashboard interaction hub the part components share: it collects the CROSS-FILTERS a part publishes
// (clicking a chart slice), the PINNED filters promoted to the dashboard header, and the invalidation
// callbacks, then translates them into each part's FindOptions — travelling between different queries via
// the dashboard's token equivalences.
//
// altea divergences:
//  - `DashboardPinnedFilters` carries the query ROOT TOKEN instead of Signum's QueryDescription (altea has
//    no QueryDescription DTO — PinnedFilterBuilder takes a `queryToken`).
//  - `QueryToken` is a CLASS with methods (`fullKey()`, `parent`), so token translation rebuilds tokens by
//    walking `parent` and re-resolving the appended keys through Finder's token cache instead of spreading
//    plain objects as Signum did.
//  - Enum fields are int-FK ordinals in altea; `interactionGroup` is therefore compared by ordinal value
//    (never by member name).

export class DashboardController {

    forceUpdate: () => void;

    filters: Map<DashboardEntity_Part, DashboardFilter> = new Map();
    pinnedFilters: Map<DashboardEntity_Part, DashboardPinnedFilters> = new Map();
    lastChange: Map<string /*queryKey*/, number> = new Map();
    dashboard: DashboardEntity;
    queriesWithEquivalences: string /*queryKey*/[];

    invalidationMap: Map<DashboardEntity_Part, () => void> = new Map();

    isLoading: boolean;

    constructor(forceUpdate: () => void, dashboard: DashboardEntity) {
        this.forceUpdate = forceUpdate;
        this.dashboard = dashboard;

        this.queriesWithEquivalences = (dashboard.tokenEquivalencesGroups ?? [])
            .flatMap(gr => (gr.tokenEquivalences ?? []).map(te => te.query.key))
            .distinctBy(a => a);

        this.isLoading = true;
    }

    setIsLoading(): void {
        this.isLoading = !(this.dashboard.parts ?? [])
            .filter(p => p.content != null && DashboardClient.hasWaitForInvalidation(p.content))
            .every(p => this.invalidationMap.has(p));
    }

    registerInvalidations(part: DashboardEntity_Part, invalidation: () => void): void {
        this.invalidationMap.set(part, invalidation);
    }

    invalidate(source: DashboardEntity_Part, interactionGroup: InteractionGroupEnum | null | undefined): void {
        Array.from(this.invalidationMap.keys())
            .filter(p => p != source && (interactionGroup == null || p.interactionGroup === interactionGroup))
            .forEach(p => this.invalidationMap.get(p)!());
    }

    setFilter(filter: DashboardFilter): void {
        this.lastChange.set(filter.queryKey, new Date().getTime());
        this.filters.set(filter.partEmbedded, filter);
        this.forceUpdate();
    }

    clearFilters(partEmbedded: DashboardEntity_Part): void {
        const current = this.filters.get(partEmbedded);
        if (current)
            this.lastChange.set(current.queryKey, new Date().getTime());
        this.filters.delete(partEmbedded);
        this.forceUpdate();
    }

    setPinnedFilter(filter: DashboardPinnedFilters): void {
        this.lastChange.set(filter.queryKey, new Date().getTime());
        this.pinnedFilters.set(filter.partEmbedded, filter);
        this.forceUpdate();
    }

    clearPinnedFilter(partEmbedded: DashboardEntity_Part): void {
        const current = this.pinnedFilters.get(partEmbedded);
        if (current)
            this.lastChange.set(current.queryKey, new Date().getTime());

        this.pinnedFilters.delete(partEmbedded);
        this.forceUpdate();
    }

    getLastChange(queryKey: string): number | null | undefined {
        if (this.queriesWithEquivalences.includes(queryKey))
            return this.queriesWithEquivalences.max(qk => this.lastChange.get(qk));

        return this.lastChange.get(queryKey);
    }

    // Signum's getFilterOptions: the filters OTHER parts of the same interaction group have published (plus
    // the dashboard-level pinned filters), translated into `queryKey`'s own tokens.
    getFilterOptions(partEmbedded: DashboardEntity_Part, queryKey: string): FilterOptionParsed[] {

        const otherFilters = partEmbedded.interactionGroup == null ? [] :
            Array.from(this.filters.values()).filter(f => f.partEmbedded != partEmbedded
                && f.partEmbedded.interactionGroup === partEmbedded.interactionGroup
                && f.rows?.length);

        const pinnedFilters = Array.from(this.pinnedFilters.values()).filter(a => a.pinnedFilters.length > 0);
        if (otherFilters.length == 0 && pinnedFilters.length == 0)
            return [];

        const equivalences = (this.dashboard.tokenEquivalencesGroups ?? [])
            .filter(gr => gr.interactionGroup === partEmbedded.interactionGroup || gr.interactionGroup == null)
            .flatMap(gr => {
                const target = (gr.tokenEquivalences ?? []).filter(a => a.query.key == queryKey);

                return (gr.tokenEquivalences ?? []).flatMap(f => target.filter(t => t != f).map(t => ({
                    fromQueryKey: f.query.key,
                    fromToken: f.token.token!,
                    toQuery: t.query.key,
                    toToken: t.token.token!,
                } as TokenEquivalenceTuple)));
            })
            .groupToObject(a => a.fromQueryKey);

        const resultFilters = otherFilters.map(df => {

            const tokenEquivalences = equivalences[df.queryKey]?.groupToObject(a => a.fromToken.fullKey());

            if (df.queryKey != queryKey && tokenEquivalences == undefined)
                return null;

            return groupFilter("Or", df.rows.map(
                r => groupFilter("And", r.filters.map(f => {
                    const token = df.queryKey == queryKey ? f.token : translateToken(f.token, tokenEquivalences);
                    if (token == null)
                        return undefined;

                    return ({ token: token, operation: "EqualTo", value: f.value, frozen: false }) as FilterConditionOptionParsed;
                }).notNull())
            ).notNull());
        }).notNull();

        const resultPinnedFilters = pinnedFilters.flatMap(a => {
            if (a.queryKey == queryKey)
                return a.pinnedFilters;

            const tokenEquivalences = equivalences[a.queryKey]?.groupToObject(x => x.fromToken.fullKey());

            return a.pinnedFilters.map(fop => tokenEquivalences && translateFilterToken(fop, tokenEquivalences)).notNull();
        });

        return [...resultPinnedFilters, ...resultFilters];
    }

    // Signum's applyToFindOptions: overlay this part's dashboard filters on the FindOptions it would run,
    // honouring the `dashboardBehaviour` of the part's own (stored) filters.
    applyToFindOptions(partEmbedded: DashboardEntity_Part, fo: FindOptions): FindOptions {

        const dashboardFilters = this.getFilterOptions(partEmbedded, getQueryKey(fo.queryName));
        if (dashboardFilters.length == 0)
            return fo;

        const dashboardFOs = Finder.toFilterOptions(dashboardFilters);

        const simpleFilters = fo.filterOptions?.filter(a => a && a.dashboardBehaviour == null) ?? [];
        const useWhenNoFilters = (fo.filterOptions?.filter(a => a && a.dashboardBehaviour == "UseWhenNoFilters") ?? []) as FilterOption[];

        const tokens = allTokens(dashboardFilters.filter(df => isActive(df)));

        return {
            ...fo,
            filterOptions: [
                ...simpleFilters,
                ...useWhenNoFilters.filter(a => !tokens.some(t => tokenStartsWith(a.token!, t))),
                ...dashboardFOs,
            ],
        };
    }
}

/** Every token mentioned by a (possibly nested) parsed filter list — Signum's local `allTokens`. */
export function allTokens(fs: FilterOptionParsed[]): QueryToken[] {
    return fs.flatMap(f => isFilterGroup(f) ? [f.token, ...allTokens(f.filters)].notNull() : [f.token].notNull());
}

function translateFilterToken(fop: FilterOptionParsed, tokenEquivalences: { [token: string]: TokenEquivalenceTuple[] }): FilterOptionParsed | null {
    let newToken: QueryToken | null | undefined = fop.token;
    if (newToken != null) {
        newToken = translateToken(newToken, tokenEquivalences);
        if (newToken == null)
            return null;
    }

    if (isFilterGroup(fop))
        return ({ ...fop, token: newToken, filters: fop.filters.map(f => translateFilterToken(f, tokenEquivalences)).notNull() });

    return ({ ...fop, token: newToken });
}

// Signum's translateToken: walk UP from `token` collecting the steps we could not translate, until a
// PREFIX of it has an equivalence in the target query; then re-append the collected steps to the
// equivalent token. The query ROOT is the implicit fallback prefix (so a column like `Supplier` can be
// read as `Entity.Supplier`).
//
// altea divergences: a QueryToken is a CLASS, so the re-append resolves each step through `subToken`
// instead of spreading object literals (a step the target query cannot resolve yields null and the filter
// is dropped — Signum threw a FormatException there, but altea resolves tokens while RENDERING, so a
// non-fatal drop is the right behaviour). And altea's root token key is "" (the rootless convention), so
// the fallback looks up "" first and "Entity" second (the key a Signum-exported XML carries).
function translateToken(token: QueryToken, tokenEquivalences: { [token: string]: TokenEquivalenceTuple[] } | undefined): QueryToken | null {

    if (tokenEquivalences == null)
        return null;

    const toAppend: QueryToken[] = [];

    for (let t: QueryToken | undefined = token; t != null; t = t.parent) {

        const equivalence = tokenEquivalences[t.fullKey()];

        if (equivalence != null)
            return appendTokens(equivalence.first().toToken, toAppend);

        toAppend.insertAt(0, t);

        if (t.parent == null) { // A column like 'Supplier' — if the ROOT is mapped, read it as 'Entity.Supplier'.
            const rootEquivalence = tokenEquivalences[""] ?? tokenEquivalences["Entity"];

            if (rootEquivalence != null)
                return appendTokens(rootEquivalence.first().toToken, toAppend);
        }
    }

    return null;
}

const appendOptions = SubTokensOptions.CanElement | SubTokensOptions.CanAnyAll | SubTokensOptions.CanAggregate;

function appendTokens(target: QueryToken, toAppend: QueryToken[]): QueryToken | null {
    let result: QueryToken | undefined = target;
    for (const step of toAppend) {
        result = result.subToken(step.key, appendOptions);
        if (result == null)
            return null;
    }
    return result;
}

export function groupFilter(groupOperation: FilterGroupOperation, filters: FilterOptionParsed[]): FilterOptionParsed | undefined {

    if (filters.length == 0)
        return undefined;

    if (filters.length == 1)
        return filters[0];

    return ({
        groupOperation: groupOperation,
        filters: filters,
    }) as FilterGroupOptionParsed;
}

interface TokenEquivalenceTuple {
    fromQueryKey: string;
    fromToken: QueryToken;
    toQuery: string;
    toToken: QueryToken;
}

export class DashboardPinnedFilters {
    partEmbedded: DashboardEntity_Part;
    queryKey: string;
    /** altea divergence: Signum passed a QueryDescription; PinnedFilterBuilder here takes the query ROOT token. */
    queryToken: QueryToken;
    pinnedFilters: FilterOptionParsed[];

    constructor(partEmbedded: DashboardEntity_Part, queryKey: string, queryToken: QueryToken, pinnedFilters: FilterOptionParsed[]) {
        this.partEmbedded = partEmbedded;
        this.queryKey = queryKey;
        this.queryToken = queryToken;
        this.pinnedFilters = pinnedFilters;
    }
}

export class DashboardFilter {
    partEmbedded: DashboardEntity_Part;
    queryKey: string;
    rows: DashboardFilterRow[] = [];

    constructor(partEmbedded: DashboardEntity_Part, queryKey: string) {
        this.partEmbedded = partEmbedded;
        this.queryKey = queryKey;
    }
}

export interface DashboardFilterRow {
    filters: { token: QueryToken, value: unknown }[];
}

export function equalsDFR(row1: DashboardFilterRow, row2: DashboardFilterRow): boolean {
    if (row1.filters.length != row2.filters.length)
        return false;

    for (let i = 0; i < row1.filters.length; i++) {
        const f1 = row1.filters[i];
        const f2 = row2.filters[i];

        if (!(f1.token.fullKey() == f2.token.fullKey() && sameValue(f1.value, f2.value)))
            return false;
    }

    return true;
}

// Signum compared two filter values with `is(a, b, false, false)` (its free function over Lite|Entity).
// altea's `is` is an INSTANCE method on Lite, so compare identity first and fall back to lite identity.
function sameValue(v1: unknown, v2: unknown): boolean {
    if (v1 === v2)
        return true;
    if (v1 instanceof Lite)
        return v1.is(v2 as Lite<Entity>);
    return false;
}
