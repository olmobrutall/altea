import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { parseQueryRequest } from "@altea/altea/server/queryServer";
import type { QueryRequest as EngineQueryRequest } from "@altea/altea/server/dynamicQuery/requests";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { getKey } from "@altea/altea/data/dynamicQuery/queryUtils";
import { resolveCleanType } from "@altea/altea/data/registration";
import { SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { reflectionDefaultColumns } from "@altea/altea/data/dynamicQuery/defaultColumns";
import type {
    ColumnRequest, FilterRequest, OrderRequest, QueryRequest as WireQueryRequest,
} from "@altea/altea/data/dynamicQuery/queryRequest";
import type { ColumnOptionsMode, FilterGroupOperation, FilterOperation, OrderType, PaginationMode } from "@altea/altea/data/dynamicQueries";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";

// Port of the bottom half of Signum.Agent's Skills/SearchSkill.cs — the `FindOptions` the model produces,
// its validation, its conversion into a query request, and its encoding into a `/find/...` URL. Split into
// its own file here because ChartSkill reuses the filter half (as Signum's ChartOptionsEncoder does).
//
// altea divergences, documented inline:
//  - `QueryDescription` is gone (see the repo CLAUDE.md): every `QueryUtils.Parse(token, qd, options)`
//    becomes `QueryLogic.getToken(queryName, token, options)`, and `qd.NextAlternatives(...)` — Signum's
//    "possible next tokens" hint on a parse failure — becomes `nextAlternatives` below, which walks the
//    dotted path down to its last VALID segment and lists that token's children. Same help, derived from
//    the token tree instead of from a DTO.
//  - the column merge (`ColumnOptionsMode`) resolves the query's defaults through
//    `reflectionDefaultColumns` — the isomorphic helper that exists precisely because altea has no
//    QueryDescription to read `.Columns` from. Signum's five modes are all supported (it implements four
//    server-side and a fifth, `InsertStart`, only on the client).
//  - the URL encoding matches altea's OWN `Finder.Encoder` (client/Finder.tsx), not Signum's: the two
//    formats differ in the tilde escape (`#|#`, not `~~`) and in the hidden-column marker. A URL the model
//    hands the user has to be one THIS client can parse back.
//  - tokens are ROOTLESS and camelCase in altea (`customer.name`, not `Entity.Customer.Name`), which is
//    what the instruction files describe.

export interface FilterOption {
    token?: string;
    operation?: FilterOperation;
    value?: unknown;
    groupOperation?: FilterGroupOperation;
    filters?: FilterOption[];
}

export interface OrderOption {
    token: string;
    orderType?: OrderType;
}

export interface ColumnOption {
    token: string;
    displayName?: string;
    summaryToken?: string;
    hiddenColumn?: boolean;
}

export interface PaginationOption {
    mode: PaginationMode;
    elementsPerPage?: number;
    currentPage?: number;
}

export interface FindOptions {
    queryName: string;
    groupResults?: boolean;
    includeDefaultFilters?: boolean;
    filterOptions?: FilterOption[];
    orderOptions?: OrderOption[];
    columnOptionsMode?: ColumnOptionsMode;
    columnOptions?: ColumnOption[];
    pagination?: PaginationOption;
}

/** A validation failure, carrying Signum's `e.Data["Hint"]` as a real field. */
export class FindOptionsValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FindOptionsValidationError";
    }
}

// ---- token parsing + the "possible next tokens" hint ------------------------------------------

/**
 * A query key → its QueryName. `QueryLogic.tryToQueryName` reads a name-only registry that nothing
 * populates, so it always misses: the registered queries live in the query CONTAINER (`withQuery` registers
 * there), reachable as `tryGetQueryNameByKey` — with `resolveCleanType` as the fallback for a type whose
 * query was never explicitly registered. Same resolution `queryServer` uses.
 */
export function resolveQueryName(queryKey: string): QueryName {
    const qn = QueryLogic.tryGetQueryNameByKey(queryKey) ?? resolveCleanType(queryKey);
    if (qn != undefined)
        return qn as QueryName;

    const similar = registeredQueryKeys()
        .filter(k => k.toLowerCase().includes(queryKey.toLowerCase()))
        .slice(0, 5);

    throw new FindOptionsValidationError(`Query '${queryKey}' not found.`
        + (similar.length > 0 ? ` Similar query names: ${similar.join(", ")}` : ""));
}

/** Every registered query's key (the query container's own list — see resolveQueryName). */
export function registeredQueryKeys(): string[] {
    return QueryLogic.queries.getQueryNames().map(qn => getKey(qn));
}

/** Signum's `QueryUtils.TryParse` + `qd.NextAlternatives(options, partial)`, in one. */
export function parseToken(queryName: QueryName, tokenString: string, options = SubTokensOptionsAll): QueryToken {
    try {
        return QueryLogic.getToken(queryName, tokenString, options);
    } catch (e) {
        throw new FindOptionsValidationError(
            `token '${tokenString}': ${e instanceof Error ? e.message : String(e)}\n`
            + ` Possible next tokens: ${nextAlternatives(queryName, tokenString, options)}`);
    }
}

/**
 * The children of the LONGEST valid prefix of a dotted token path — so the message says what could have
 * come next, which is what Signum's `NextAlternatives` does from its QueryDescription.
 */
export function nextAlternatives(queryName: QueryName, tokenString: string, options = SubTokensOptionsAll): string {
    const parts = tokenString.split(".");

    for (let take = parts.length - 1; take >= 0; take--) {
        const prefix = parts.slice(0, take).join(".");
        try {
            const token = QueryLogic.getToken(queryName, prefix, options);
            const keys = token.subTokens(options).map(t => t.key);
            return keys.length === 0 ? "(none)" : keys.join(", ");
        } catch {
            // keep shortening
        }
    }

    return "(none)";
}

// ---- FindOptions → a query request ----------------------------------------------------------

/** Signum's `FindOptions.Validate(qd)` — collect every problem, rather than failing on the first. */
export function validateFindOptions(fo: FindOptions): string | null {
    const queryName = resolveQueryName(fo.queryName);
    const problems: string[] = [];

    const check = (path: string, token: string, options = SubTokensOptionsAll): QueryToken | undefined => {
        try {
            return QueryLogic.getToken(queryName, token, options);
        } catch (e) {
            problems.push(`${path} (token '${token}'): ${e instanceof Error ? e.message : String(e)}`);
            problems.push(` Possible next tokens: ${nextAlternatives(queryName, token, options)}`);
            return undefined;
        }
    };

    const validateFilter = (f: FilterOption, path: string): void => {
        if (f.operation != undefined || (f.groupOperation == undefined && f.token != undefined)) {
            if (f.token == undefined) {
                problems.push(`${path}.token: is required for a filter condition`);
                return;
            }
            check(`${path}.token`, f.token);
        } else if (f.groupOperation != undefined) {
            if (f.token != undefined && f.token !== "")
                check(`${path}.token`, f.token);
            (f.filters ?? []).forEach((sub, i) => validateFilter(sub, `${path}.filters[${i}]`));
        } else {
            problems.push(`${path}: should be either a filter condition (token + operation) or a group (groupOperation + filters)`);
        }
    };

    (fo.filterOptions ?? []).forEach((f, i) => validateFilter(f, `filterOptions[${i}]`));

    (fo.orderOptions ?? []).forEach((o, i) => check(`orderOptions[${i}]`, o.token));

    (fo.columnOptions ?? []).forEach((c, i) => {
        check(`columnOptions[${i}]`, c.token);
        if (c.summaryToken != undefined && c.summaryToken !== "") {
            const summary = check(`columnOptions[${i}].summaryToken`, c.summaryToken);
            if (summary != undefined && !summary.hasAggregate())
                problems.push(`columnOptions[${i}].summaryToken ('${c.summaryToken}'): is not an aggregate`);
        }
    });

    if (fo.pagination != undefined) {
        const p = fo.pagination;
        if ((p.mode === "Firsts" || p.mode === "Paginate") && (p.elementsPerPage == undefined || p.elementsPerPage <= 0))
            problems.push(`pagination.elementsPerPage: should be a positive number when mode is '${p.mode}'`);
        if (p.mode === "Paginate" && (p.currentPage == undefined || p.currentPage < 0))
            problems.push("pagination.currentPage: should be a positive number when mode is 'Paginate'");
    }

    return problems.length === 0 ? null : problems.join("\n");
}

/** Throws a FindOptionsValidationError when the options are not runnable (Signum's ParseFindOptions). */
export function assertValidFindOptions(fo: FindOptions): QueryName {
    const error = validateFindOptions(fo);
    if (error != null)
        throw new FindOptionsValidationError(error);
    return resolveQueryName(fo.queryName);
}

/** Signum's `FindOptions.ToQueryRequest()`, via altea's own wire → engine parser. */
export function toQueryRequest(fo: FindOptions): EngineQueryRequest {
    const queryName = assertValidFindOptions(fo);

    const wire: WireQueryRequest = {
        queryKey: getKey(queryName),
        groupResults: fo.groupResults ?? false,
        filters: (fo.filterOptions ?? []).map(toFilterRequest),
        orders: (fo.orderOptions ?? []).map(o => ({ token: o.token, orderType: o.orderType ?? "Ascending" } satisfies OrderRequest)),
        columns: mergeColumns(queryName, fo),
        pagination: fo.pagination != undefined
            ? {
                mode: fo.pagination.mode,
                elementsPerPage: fo.pagination.elementsPerPage ?? 20,
                currentPage: fo.pagination.currentPage ?? 1,
            }
            // Signum's default: Firsts(20).
            : { mode: "Firsts", elementsPerPage: 20, currentPage: 1 },
    };

    return parseQueryRequest(wire);
}

function toFilterRequest(f: FilterOption): FilterRequest {
    if (f.groupOperation != undefined) {
        return {
            groupOperation: f.groupOperation,
            ...(f.token != undefined && f.token !== "" ? { token: f.token } : {}),
            filters: (f.filters ?? []).map(toFilterRequest),
        };
    }

    return {
        token: f.token!,
        operation: f.operation ?? "EqualTo",
        value: f.value ?? null,
    };
}

/** Signum's `MergeColumns(qd, aggregates)`, over altea's reflection-derived default columns. */
function mergeColumns(queryName: QueryName, fo: FindOptions): ColumnRequest[] {
    const requested = (fo.columnOptions ?? []).map(c => ({
        token: c.token,
        displayName: c.hiddenColumn ? HIDDEN : (c.displayName ?? ""),
    } satisfies ColumnRequest));

    const defaults = (): ColumnRequest[] =>
        reflectionDefaultColumns(QueryLogic.getRootToken(queryName)).map(t => ({ token: t.fullKey(), displayName: "" }));

    switch (fo.columnOptionsMode ?? "ReplaceAll") {
        case "Add": return [...defaults(), ...requested];
        case "InsertStart": return [...requested, ...defaults()];
        case "Remove": {
            const removed = new Set(requested.map(c => c.token));
            return defaults().filter(c => !removed.has(c.token));
        }
        case "ReplaceAll": return requested;
        case "ReplaceOrAdd": {
            const result = defaults();
            for (const c of requested) {
                const index = result.findIndex(o => o.token === c.token);
                if (index >= 0)
                    result[index] = c;
                else
                    result.push(c);
            }
            return result;
        }
        default: throw new FindOptionsValidationError(`'${fo.columnOptionsMode}' is not a valid columnOptionsMode`);
    }
}

// ---- URL encoding (matching altea's client Finder.Encoder) -----------------------------------

/** altea's hidden-column marker (client/Finder.tsx's `HIDDEN`). */
const HIDDEN = "__";

/** altea escapes a literal tilde as `#|#` (Signum doubles it). */
function scapeTilde(str: string): string {
    return str.replace(/~/g, "#|#");
}

function stringValue(value: unknown): string {
    if (value == undefined)
        return "";
    if (Array.isArray(value))
        return value.filter(a => a != null).map(stringValue).join("~");
    if (value instanceof Entity)
        return value.toLite().key();
    if (value instanceof Lite)
        return value.key();
    if (value instanceof Temporal.PlainDate || value instanceof Temporal.PlainDateTime || value instanceof Temporal.PlainTime)
        return value.toString();
    if (typeof value === "boolean")
        return value ? "true" : "false";
    return scapeTilde(String(value));
}

export function encodeFilters(query: Record<string, unknown>, filters: FilterOption[] | undefined, prefix = ""): void {
    if (filters == undefined)
        return;

    let i = 0;
    const encode = (f: FilterOption, indentation: number): void => {
        const identSuffix = indentation === 0 ? "" : `_${indentation}`;
        const index = i++;

        if (f.groupOperation != undefined) {
            query[`${prefix}filter${index}${identSuffix}`] = `${f.token ?? ""}~${f.groupOperation}~${stringValue(f.value)}`;
            for (const sub of f.filters ?? [])
                encode(sub, indentation + 1);
        } else {
            query[`${prefix}filter${index}${identSuffix}`] = `${f.token}~${f.operation ?? "EqualTo"}~${stringValue(f.value)}`;
        }
    };

    for (const f of filters)
        encode(f, 0);
}

export function encodeOrders(query: Record<string, unknown>, orders: OrderOption[] | undefined, prefix = ""): void {
    if (orders == undefined)
        return;
    orders.forEach((o, i) => query[`${prefix}order${i}`] = (o.orderType === "Descending" ? "-" : "") + o.token);
}

export function encodeColumns(query: Record<string, unknown>, columns: ColumnOption[] | undefined, prefix = ""): void {
    if (columns == undefined)
        return;

    columns.forEach((c, i) => {
        const displayName = c.hiddenColumn ? HIDDEN : c.displayName != undefined ? scapeTilde(c.displayName) : undefined;
        query[`${prefix}column${i}`] = c.token + (displayName ? `~${displayName}` : "");
        if (c.summaryToken != undefined && c.summaryToken !== "")
            query[`${prefix}summary${i}`] = c.summaryToken;
    });
}

export function toQueryString(query: Record<string, unknown>): string {
    return Object.entries(query)
        .filter(([, v]) => v != undefined && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
}

/** Signum's `FindOptionsEncoder.FindOptionsPath(fo)`, in altea's URL format. */
export function findOptionsPath(fo: FindOptions): string {
    const query: Record<string, unknown> = {
        groupResults: fo.groupResults === true ? "true" : undefined,
        idf: fo.includeDefaultFilters == undefined ? undefined : String(fo.includeDefaultFilters),
        columnMode: fo.columnOptionsMode != undefined && fo.columnOptionsMode !== "Add" ? fo.columnOptionsMode : undefined,
        paginationMode: fo.pagination?.mode,
        elementsPerPage: fo.pagination?.elementsPerPage,
        currentPage: fo.pagination?.currentPage,
    };

    encodeFilters(query, fo.filterOptions);
    encodeOrders(query, fo.orderOptions);
    encodeColumns(query, fo.columnOptions);

    const strQuery = toQueryString(query);
    return `/find/${fo.queryName}${strQuery === "" ? "" : `?${strQuery}`}`;
}
