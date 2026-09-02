import type {
    ColumnRequest, FilterRequest, OrderRequest, Pagination, QueryRequest, QueryValueRequest,
    ResultRow, ResultTable,
} from "@altea/altea/data/dynamicQuery/queryRequest";
import { isFilterGroup, type FilterOptionParsed, type FindOptionsParsed } from "@altea/altea/client/FindOptions";
import type { QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { Decimal } from "@altea/altea/data/basics";

// Port of Signum.Dashboard/CachedQueryExecutor.ts — the half of the cached-query feature that makes the
// whole thing worth doing: a part's query is answered from the SNAPSHOT, in the browser, with no request.
//
// That is what a "relatively stable data" dashboard buys — one file download instead of N queries, and
// cross-filtering that re-evaluates locally, so the calculation scales with the number of clients rather
// than with the server. The file can sit in object storage, which is why nothing here talks to the app.
//
// The snapshot is not required to be the same shape as the request: it may hold MORE rows (unfiltered),
// MORE columns (the expansion the server does for cross-filtering) and no grouping at all. So the work is
// filter → group → filter again (on aggregates) → order → select → paginate, and each step is skipped
// when the snapshot already did it. Where the snapshot CANNOT answer, a CachedQueryError is thrown and the
// caller falls back to querying the server — being wrong here would silently show wrong numbers.
//
// altea divergences:
//  - `queryTokenType != "Aggregate"` → `!token.isAggregate()`; `getToString(lite)` → `lite.toString()`;
//    `is(a, b)` → `a.is(b)`; `liteKey(l)` → `l.key()`.
//  - Signum's `Average` column key is `"Avg"` in one branch and `"Average"` in the other; altea's
//    AggregateFunction is `Average` throughout, and the non-null count is keyed `CountNotNull` (see
//    CachedQueryDefinitions' expandColumns, which produces exactly that name).
//  - the row key and the filter predicate are still built with `new Function`, as Signum does: a snapshot
//    can hold hundreds of thousands of rows and this runs on every re-filter, so the generated closure is
//    the point. Nothing user-authored reaches it — only column INDEXES and pre-bound value variables.

/** Signum's CachedQueryJS — re-exported from the data layer, which is where both ends name it. */
export type { CachedQueryJS } from "../data/CachedQuery";
import type { CachedQueryJS } from "../data/CachedQuery";

/** Thrown when the snapshot cannot answer the request; the caller queries the server instead. */
export class CachedQueryError {
    constructor(public readonly message: string) { }
    toString(): string { return this.message; }
}

/** Signum's `executeQueryCached` — answer a full query request from the snapshot. */
export function executeQueryCached(request: QueryRequest, fop: FindOptionsParsed, cachedQuery: CachedQueryJS): ResultTable {
    const tokens = tokensByKey([
        ...fop.columnOptions.map(a => a.token),
        ...fop.columnOptions.map(a => a.summaryToken),
        ...fop.orderOptions.map(a => a.token),
        ...getAllFilterTokens(fop.filterOptions),
    ]);

    return getCachedResultTable(cachedQuery, request, tokens);
}

/**
 * Signum's `executeQueryValueCached` — answer a single VALUE (or a list of them) from the snapshot, by
 * building the one-column request that value is, then running the ordinary path.
 */
export function executeQueryValueCached(
    request: QueryValueRequest,
    fop: FindOptionsParsed,
    token: QueryToken | null,
    cachedQuery: CachedQueryJS,
): unknown {
    if (token == null)
        throw new CachedQueryError("A cached query value needs its token; the implicit row Count is not resolvable here");

    const queryRequest: QueryRequest = {
        queryKey: request.queryKey,
        columns: [{ token: token.fullKey(), displayName: token.niceName() }],
        filters: request.filters,
        groupResults: token.isAggregate(),
        orders: [],
        pagination: request.multipleValues ? { mode: "All" } : { mode: "Firsts", elementsPerPage: 2 },
        systemTime: undefined,
    };

    const tokens = tokensByKey([token, ...getAllFilterTokens(fop.filterOptions)]);
    const resultTable = getCachedResultTable(cachedQuery, queryRequest, tokens);
    const values = resultTable.rows.map(r => r.columns[0]);

    return request.multipleValues ? values : (values.length === 1 ? values[0] : undefined);
}

/** Signum's `getAllFilterTokens` — every token a filter tree mentions, groups included. */
export function getAllFilterTokens(fos: FilterOptionParsed[]): (QueryToken | undefined)[] {
    return fos.flatMap(f => isFilterGroup(f) ? [f.token, ...getAllFilterTokens(f.filters)] : [f.token]);
}

function tokensByKey(tokens: (QueryToken | undefined)[]): { [token: string]: QueryToken } {
    const result: { [token: string]: QueryToken } = {};
    for (const t of tokens)
        if (t != null)
            result[t.fullKey()] = t;
    return result;
}

/**
 * Signum's `getCachedResultTable` — the core. Decide what the snapshot still owes the request, then do
 * exactly that much work.
 */
export function getCachedResultTable(
    cachedQuery: CachedQueryJS,
    request: QueryRequest,
    parsedTokens: { [token: string]: QueryToken },
): ResultTable {

    if (request.queryKey !== cachedQuery.queryRequest.queryKey)
        throw new CachedQueryError("Invalid queryKey");

    // A snapshot that is itself PAGED can only answer a request whose filters and orders are identical —
    // page 2 of a different filter is not a subset of page 2 of this one.
    const exactFiltersAndOrders = paginationRestriction(request.pagination, cachedQuery.queryRequest.pagination)
        === "ExactFiltersAndOrders";

    const sameOrders = ordersEqual(cachedQuery.queryRequest.orders, request.orders);
    if (!sameOrders && exactFiltersAndOrders)
        throw new CachedQueryError("Incompatible pagination if the orders are not identical");

    const extraFilters = extractRequestedFilters(cachedQuery.queryRequest.filters, request.filters);
    if (extraFilters.length > 0 && exactFiltersAndOrders)
        throw new CachedQueryError("Incompatible pagination if the filters are not identical");

    if (!request.groupResults) {
        if (cachedQuery.queryRequest.groupResults)
            throw new CachedQueryError("Cached query is grouping but request is not");

        const filtered = filterRows(cachedQuery.resultTable, extraFilters);
        const ordered = sameOrders ? filtered : orderRows(filtered, request.orders, parsedTokens);
        return paginateRows(selectRows(ordered, request.columns), request.pagination);
    }

    if (exactFiltersAndOrders) {
        if (!cachedQuery.queryRequest.groupResults)
            throw new CachedQueryError("Incompatible pagination if the request is grouping but the cached query is not");

        const keyOf = (cols: ColumnRequest[]): string[] =>
            cols.filter(c => !parsedTokens[c.token]?.isAggregate()).map(c => c.token);
        const requestKeys = keyOf(request.columns);
        const extraKeys = keyOf(cachedQuery.queryRequest.columns).filter(k => !requestKeys.includes(k));
        if (extraKeys.length > 0)
            throw new CachedQueryError("Incompatible pagination if the key columns are not identical");
    }

    // An AGGREGATE filter (Signum's HAVING) can only be applied after grouping, so it is held back.
    const aggregateFilters = extraFilters.filter(f => !isFilterGroupRequest(f) && parsedTokens[f.token]?.isAggregate());
    const rowFilters = extraFilters.filter(f => !aggregateFilters.includes(f));

    const filtered = filterRows(cachedQuery.resultTable, rowFilters);

    const allColumns = distinct([
        ...request.columns.map(a => a.token),
        ...aggregateFilters.map(a => (a as { token: string }).token),
        ...sameOrders ? [] : request.orders.map(a => a.token),
    ]);

    const grouped = groupByRows(filtered, cachedQuery.queryRequest.groupResults, allColumns, parsedTokens);
    const reFiltered = filterRows(grouped, aggregateFilters);
    const ordered = sameOrders ? reFiltered : orderRows(reFiltered, request.orders, parsedTokens);
    return paginateRows(selectRows(ordered, request.columns), request.pagination);
}

/**
 * Signum's `groupByRows` — group the rows by the non-aggregate tokens and compute each aggregate.
 *
 * `alreadyGrouped` is the subtle half: when the snapshot is ALREADY grouped (more finely than the request),
 * the aggregates have to be RE-aggregated rather than recomputed — a Count of counts is a Sum, and an
 * Average cannot be averaged again, which is why the server stored its Sum and its non-null Count instead.
 */
function groupByRows(
    rt: ResultTable,
    alreadyGrouped: boolean,
    tokens: string[],
    parsedTokens: { [token: string]: QueryToken },
): ResultTable {

    const keyColumns = tokens.filter(t => !parsedTokens[t]?.isAggregate());
    const rowKey = getRowKey(rt, keyColumns, parsedTokens);

    const groups = new Map<string, ResultRow[]>();
    for (const row of rt.rows) {
        const key = rowKey(row);
        let list = groups.get(key);
        if (list == null)
            groups.set(key, list = []);
        list.push(row);
    }

    const getters = tokens.map(token => getGetter(rt, token, alreadyGrouped, parsedTokens));

    const newRows: ResultRow[] = [];
    for (const rows of groups.values())
        newRows.push({ entity: undefined, columns: getters.map(g => g(rows)) });

    return {
        columns: tokens,
        pagination: { mode: "All" },
        rows: newRows,
        uniqueValues: rt.uniqueValues,
        totalElements: newRows.length,
    };
}

function getGetter(
    rt: ResultTable,
    token: string,
    alreadyGrouped: boolean,
    parsedTokens: { [token: string]: QueryToken },
): (rows: ResultRow[]) => unknown {

    const indexOf = (t: string): number => {
        const idx = rt.columns.indexOf(t);
        if (idx === -1)
            throw new CachedQueryError(`Column ${t} not found` + (t !== token ? ` (required for ${token})` : ""));
        return idx;
    };
    const tryIndexOf = (t: string): number | null => {
        const idx = rt.columns.indexOf(t);
        return idx === -1 ? null : idx;
    };

    const qt = parsedTokens[token];
    if (qt == null)
        throw new CachedQueryError(`Token ${token} was not parsed`);

    if (!qt.isAggregate()) {
        const index = indexOf(token);
        return rows => rows[0].columns[index];
    }

    const nums = (rows: ResultRow[], index: number): unknown[] => numericValues(rows, index);

    if (!alreadyGrouped) {
        if (qt.key === "Count")
            return rows => rows.length;

        const index = indexOf(qt.parent!.fullKey());
        switch (qt.key) {
            case "Min": return rows => min(nums(rows, index));
            case "Max": return rows => max(nums(rows, index));
            case "Sum": return rows => sum(nums(rows, index));
            case "Average": return rows => { const v = nums(rows, index); return divide(sum(v), v.length); };
        }
        throw new CachedQueryError(`Unexpected aggregate ${token}`);
    }

    // The snapshot is already grouped: re-aggregate.
    if (qt.key === "Count") {
        const index = indexOf(qt.fullKey());
        return rows => sum(nums(rows, index));
    }

    if (qt.key === "Average") {
        // No interaction group widened this query, so the average is already per-group and each request
        // group is exactly one snapshot row.
        const avg = tryIndexOf(qt.fullKey());
        if (avg != null)
            return rows => rows.length === 1 ? rows[0].columns[avg] : null;

        // Otherwise recompute it from the Sum and non-null Count the server stored for exactly this.
        const indexSum = indexOf(qt.parent!.fullKey() + ".Sum");
        const indexCount = indexOf(qt.parent!.fullKey() + ".CountNotNull");
        return rows => {
            const totalCount = Number(sum(nums(rows, indexCount)));
            return divide(sum(nums(rows, indexSum)), totalCount);
        };
    }

    const index = tryIndexOf(qt.fullKey()) ?? indexOf(qt.parent!.fullKey());
    switch (qt.key) {
        case "Min": return rows => min(nums(rows, index));
        case "Max": return rows => max(nums(rows, index));
        case "Sum": return rows => sum(nums(rows, index));
    }
    throw new CachedQueryError(`Unexpected aggregate ${token}`);
}

/**
 * Signum's `getRowKey` — a generated function producing the grouping key of a row.
 *
 * Generated rather than interpreted because it runs once per row per re-filter. A LITE is keyed by its
 * TYPE and id, which is why the snapshot has to carry the discriminator (`$lite`): two rows with id 1 of
 * different types are different groups.
 */
function getRowKey(
    rt: ResultTable,
    keyTokens: string[],
    parsedTokens: { [token: string]: QueryToken },
): (row: ResultRow) => string {

    if (keyTokens.length === 0)
        return () => "";

    const parts = keyTokens.map(token => {
        const index = rt.columns.indexOf(token);
        if (index === -1)
            throw new CachedQueryError("Token " + token + " not found for grouping");

        return parsedTokens[token]?.filterType === "Lite"
            ? `(rr.columns[${index}] == null ? "" : rr.columns[${index}].entityType.name + ";" + rr.columns[${index}].id)`
            : `rr.columns[${index}]`;
    });

    // eslint-disable-next-line no-new-func
    return new Function("rr", "return " + parts.join(' + "|" + ') + ";") as (row: ResultRow) => string;
}

/** Signum's `orderRows` — a stable multi-key sort, applied last key first. */
function orderRows(rt: ResultTable, orders: OrderRequest[], parsedTokens: { [token: string]: QueryToken }): ResultTable {
    const newRows = Array.from(rt.rows);

    for (let i = orders.length - 1; i >= 0; i--) {
        const o = orders[i];
        const index = rt.columns.indexOf(o.token);
        if (index === -1)
            throw new CachedQueryError("Unable to order by token " + o.token);

        const isLite = parsedTokens[o.token]?.filterType === "Lite";
        const key = (row: ResultRow): unknown => {
            const v = row.columns[index];
            return isLite && v != null ? String(v) : v;
        };
        const dir = o.orderType === "Ascending" ? 1 : -1;

        newRows.sort((ra, rb) => {
            const a = key(ra);
            const b = key(rb);
            if (a === b) return 0;
            if (a == null) return -dir;
            if (b == null) return dir;
            return (a > b ? 1 : -1) * dir;
        });
    }

    return { ...rt, rows: newRows };
}

/** Signum's `selectRows` — project the requested columns, in order. */
function selectRows(rt: ResultTable, columns: ColumnRequest[]): ResultTable {
    const indexes = columns.map(c => {
        const idx = rt.columns.indexOf(c.token);
        if (idx === -1)
            throw new CachedQueryError("Unable to select by token " + c.token);
        return idx;
    });

    return {
        ...rt,
        columns: columns.map(c => c.token),
        rows: rt.rows.map(r => ({ entity: r.entity, columns: indexes.map(i => r.columns[i]) })),
    };
}

/** Signum's `filterRows` — only possible over an unpaged snapshot: a page is not a population. */
function filterRows(rt: ResultTable, filters: FilterRequest[]): ResultTable {
    if (filters.length === 0)
        return rt;

    if (rt.pagination.mode !== "All")
        throw new CachedQueryError("Unable to filter " + rt.pagination.mode);

    const rows = createFilterer(rt, filters)(rt.rows);
    return { ...rt, rows, pagination: { mode: "All" }, totalElements: rows.length };
}

/**
 * Signum's `createFilterer` — compile the filter tree into one predicate over a row's column array.
 *
 * The values are BOUND as parameters rather than emitted into the source, so nothing but column indexes
 * and operators is ever generated: a filter value can be a lite, a date or an arbitrary string.
 */
function createFilterer(result: ResultTable, filters: FilterRequest[]): (rows: ResultRow[]) => ResultRow[] {
    const values: unknown[] = [];
    const bind = (v: unknown): string => { values.push(v); return "v" + (values.length - 1); };

    // A snapshot may INTERN its values (Signum's compression), in which case a filter value has to be
    // matched to the interned instance for `===` to hold.
    const interned = (v: unknown, token: string): unknown => {
        const uvs = result.uniqueValues?.[token];
        if (uvs == null)
            return v;
        return uvs.find(uv => uv === v || liteEquals(uv, v)) ?? v;
    };

    const expression = (f: FilterRequest): string => {
        if (isFilterGroupRequest(f)) {
            const parts = f.filters.map(expression);
            if (parts.length === 0)
                return "true";
            return f.groupOperation === "Or" ? "(" + parts.join(" || ") + ")" : "(" + parts.join(" && ") + ")";
        }

        const index = result.columns.indexOf(f.token);
        if (index === -1)
            throw new CachedQueryError("Unable to filter " + f.token + ", column not found");

        const col = `cls[${index}]`;
        const cmp = `__eq(${col}, %)`; // a lite compares by key, not by identity

        if (f.operation === "IsIn" || f.operation === "IsNotIn") {
            const list = (f.value as unknown[]) ?? [];
            const any = list.length === 0 ? "false"
                : list.map(v => cmp.replace("%", bind(interned(v, f.token)))).join(" || ");
            return f.operation === "IsIn" ? "(" + any + ")" : "!(" + any + ")";
        }

        const v = bind(interned(f.value, f.token));
        switch (f.operation) {
            case "EqualTo": return `__eq(${col}, ${v})`;
            case "DistinctTo": return `!__eq(${col}, ${v})`;
            case "GreaterThan": return `${col} > ${v}`;
            case "GreaterThanOrEqual": return `${col} >= ${v}`;
            case "LessThan": return `${col} < ${v}`;
            case "LessThanOrEqual": return `${col} <= ${v}`;
            case "Contains": return `(${col} != null && String(${col}).includes(${v}))`;
            case "NotContains": return `!(${col} != null && String(${col}).includes(${v}))`;
            case "StartsWith": return `(${col} != null && String(${col}).startsWith(${v}))`;
            case "NotStartsWith": return `!(${col} != null && String(${col}).startsWith(${v}))`;
            case "EndsWith": return `(${col} != null && String(${col}).endsWith(${v}))`;
            case "NotEndsWith": return `!(${col} != null && String(${col}).endsWith(${v}))`;
            case "Like":
            case "NotLike": throw new CachedQueryError(f.operation + " not supported");
            default: throw new CachedQueryError("Unexpected " + f.operation);
        }
    };

    const body = filters.map(expression).join(" &&\n");

    // eslint-disable-next-line no-new-func
    const factory = new Function("__eq", ...values.map((_, i) => "v" + i), `return rows => {
    const result = [];
    for (let i = 0; i < rows.length; i++) {
        const cls = rows[i].columns;
        if (${body}) result.push(rows[i]);
    }
    return result;
};`);

    return factory(liteAwareEquals, ...values);
}

// ---- comparisons ------------------------------------------------------------------------------------

/** `===`, except that two lites are equal when their type and id are (each request builds its own). */
function liteAwareEquals(a: unknown, b: unknown): boolean {
    return a === b || liteEquals(a, b);
}

function liteEquals(a: unknown, b: unknown): boolean {
    const key = (v: unknown): string | undefined => {
        const k = (v as { key?: () => string } | null)?.key;
        return typeof k === "function" ? k.call(v) : undefined;
    };
    const ka = key(a);
    return ka != null && ka === key(b);
}

function isFilterGroupRequest(f: FilterRequest): f is FilterRequest & { groupOperation: string; filters: FilterRequest[] } {
    return (f as { groupOperation?: string }).groupOperation != null;
}

function ordersEqual(cached: OrderRequest[], requested: OrderRequest[]): boolean {
    return cached.length === requested.length
        && cached.every((c, i) => c.token === requested[i].token && c.orderType === requested[i].orderType);
}

/**
 * Signum's `extractRequestedFilters` — the request's filters MINUS the ones the snapshot already applied.
 * A snapshot filter the request does not repeat means the snapshot is narrower than what is being asked
 * for, so it cannot answer at all.
 */
function extractRequestedFilters(cached: FilterRequest[], request: FilterRequest[]): FilterRequest[] {
    const remaining = [...request];

    for (const c of cached) {
        const idx = remaining.findIndex(rf => filtersEqual(c, rf));
        if (idx === -1)
            throw new CachedQueryError("Cached filter not found in request");
        remaining.splice(idx, 1);
    }

    return remaining;
}

function filtersEqual(c: FilterRequest, r: FilterRequest): boolean {
    if (isFilterGroupRequest(c)) {
        if (!isFilterGroupRequest(r))
            return false;
        return c.groupOperation === r.groupOperation
            && (c as { token?: string }).token === (r as { token?: string }).token
            && c.filters.length === r.filters.length
            && c.filters.every((cf, i) => filtersEqual(cf, r.filters[i]));
    }

    if (isFilterGroupRequest(r))
        return false;

    const cc = c as { token: string; operation: string; value: unknown };
    const rc = r as { token: string; operation: string; value: unknown };
    return cc.token === rc.token && cc.operation === rc.operation && liteAwareEquals(cc.value, rc.value);
}

// ---- pagination -------------------------------------------------------------------------------------

/** Signum's `paginateRows` — take the requested slice out of what the snapshot holds. */
function paginateRows(rt: ResultTable, reqPag: Pagination): ResultTable {
    const slice = (from: number, count?: number): ResultTable =>
        ({ ...rt, rows: count == null ? rt.rows.slice(from) : rt.rows.slice(from, from + count), pagination: reqPag });

    switch (rt.pagination.mode) {
        case "All":
            switch (reqPag.mode) {
                case "All": return rt;
                case "Firsts": return slice(0, reqPag.elementsPerPage);
                case "Paginate": return slice(reqPag.elementsPerPage! * ((reqPag.currentPage ?? 1) - 1), reqPag.elementsPerPage!);
            }
            break;
        case "Paginate":
            switch (reqPag.mode) {
                case "All": throw new CachedQueryError(`Requesting ${reqPag.mode} but cached is ${rt.pagination.mode}`);
                case "Firsts":
                    if ((rt.pagination.currentPage ?? 1) === 1 && reqPag.elementsPerPage! <= rt.pagination.elementsPerPage!)
                        return slice(0, reqPag.elementsPerPage);
                    throw new CachedQueryError("Invalid first");
                case "Paginate":
                    if (samePage(reqPag, rt.pagination))
                        return slice(reqPag.elementsPerPage! * ((reqPag.currentPage ?? 1) - 1), reqPag.elementsPerPage!);
                    throw new CachedQueryError("Invalid paginate");
            }
            break;
        case "Firsts":
            if (reqPag.mode === "Firsts" && reqPag.elementsPerPage! <= rt.pagination.elementsPerPage!)
                return slice(0, reqPag.elementsPerPage);
            throw new CachedQueryError(`Requesting ${reqPag.mode} but cached is ${rt.pagination.mode}`);
    }

    throw new CachedQueryError(`Requesting ${reqPag.mode} but cached is ${rt.pagination.mode}`);
}

/**
 * Signum's `pagionationRestriction` (sic) — what a PAGED snapshot demands of the request. "All" demands
 * nothing; anything else can only serve a request whose filters and orders match exactly, because a page
 * of one population is not a page of another.
 */
function paginationRestriction(req: Pagination, cached: Pagination): null | "ExactFiltersAndOrders" {
    switch (cached.mode) {
        case "All":
            return null;
        case "Paginate":
            if (req.mode === "Firsts" && (cached.currentPage ?? 1) === 1 && req.elementsPerPage! <= cached.elementsPerPage!)
                return "ExactFiltersAndOrders";
            if (req.mode === "Paginate" && samePage(req, cached))
                return "ExactFiltersAndOrders";
            throw new CachedQueryError(`Requesting ${req.mode} but cached is ${cached.mode}`);
        case "Firsts":
            if (req.mode === "Firsts" && req.elementsPerPage! <= cached.elementsPerPage!)
                return "ExactFiltersAndOrders";
            throw new CachedQueryError(`Requesting ${req.mode} but cached is ${cached.mode}`);
    }
}

/** The same page, or a smaller first page of it — Signum's two accepted cases. */
function samePage(req: Pagination, cached: Pagination): boolean {
    return (req.elementsPerPage === cached.elementsPerPage && req.currentPage === cached.currentPage)
        || (req.elementsPerPage! <= cached.elementsPerPage! && (req.currentPage ?? 1) === 1 && (cached.currentPage ?? 1) === 1);
}

// ---- numeric helpers ---------------------------------------------------------------------------------
//
// A snapshot column is UNTYPED (`any[]`), so a DECIMAL arrives as a string: nothing in the file says which
// columns are decimals, and the Serializer only revives what carries a discriminator. Adding those with
// `+` concatenates — the probe caught sums coming out as "013338" — and reading them as floats would lose
// the exactness a money column is stored with. So the arithmetic is done with Decimal whenever a value is
// not already a number, and the result is handed back in the same shape the column holds.

function isNumeric(v: unknown): boolean {
    return typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))
        || v instanceof Decimal;
}

/** Every non-null value of a column, kept in whatever shape the snapshot holds. */
function numericValues(rows: ResultRow[], index: number): unknown[] {
    return rows.map(r => r.columns[index]).filter(v => v != null && isNumeric(v));
}

/** True when the column is NOT plain JS numbers, in which case exact Decimal arithmetic is required. */
function needsDecimal(values: unknown[]): boolean {
    return values.some(v => typeof v !== "number");
}

function sum(values: unknown[]): unknown {
    if (values.length === 0)
        return needsDecimal(values) ? new Decimal(0) : 0;

    if (!needsDecimal(values))
        return (values as number[]).reduce((a, b) => a + b, 0);

    return values.reduce<Decimal>((a, b) => a.plus(new Decimal(b as Decimal.Value)), new Decimal(0));
}

function divide(total: unknown, count: number): unknown {
    if (count === 0)
        return null;
    return typeof total === "number" ? total / count : new Decimal(total as Decimal.Value).dividedBy(count);
}

function compareNumeric(a: unknown, b: unknown): number {
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    return new Decimal(a as Decimal.Value).comparedTo(new Decimal(b as Decimal.Value));
}

function min(values: unknown[]): unknown {
    return values.length === 0 ? null : values.reduce((a, b) => compareNumeric(a, b) <= 0 ? a : b);
}
function max(values: unknown[]): unknown {
    return values.length === 0 ? null : values.reduce((a, b) => compareNumeric(a, b) >= 0 ? a : b);
}
function distinct(values: string[]): string[] { return [...new Set(values)]; }

export type { Lite, Entity };
