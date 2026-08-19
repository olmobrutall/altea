import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Column, Order, Pagination, QueryRequest } from "@altea/altea/server/dynamicQuery/requests";
import { reflectionDefaultColumns } from "@altea/altea/data/dynamicQuery/defaultColumns";
import { SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { Enum } from "@altea/altea/data/enum";
import { ColumnOptionsModeEnum, OrderTypeEnum, PaginationModeEnum } from "@altea/altea/data/dynamicQueries";
import { QueryFilterUtils } from "@altea/altea-user-assets/server/QueryFilterUtils.server";
import type { UserQueryEntity, UserQueryEntity_Column } from "../data/UserQuery";

// Port of Signum's `UserQueryLogic.ToQueryRequest` / `ToQueryRequestValue` / `MergeColumns` — turning a
// STORED user query into an executable request, on the SERVER.
//
// Why this exists at all: altea resolves a user asset into a request on the CLIENT (query tokens and
// filter values are resolved in the browser — the "QueryDescription is gone" divergence in the repo's
// CLAUDE.md), so until now the server only ever received an already-built QueryRequest. Anything that has
// to RUN a stored user query without a browser in the loop — @altea/altea-office-template binding a chart
// or table to `UserQuery:<id>` alternative text, a scheduled report, a health check — needs this.
//
// altea divergences:
//  - `QueryDescription.Columns` (the authority for a query's default columns in Signum) does not exist.
//    The ColumnsMode arithmetic instead resolves against `reflectionDefaultColumns` — the same list the
//    client's `Finder.getDefaultColumns` falls back to. A client-side `querySettings.defaultColumns`
//    override is NOT visible here (it is browser configuration), so a UserQuery whose ColumnsMode is
//    `ReplaceAll` — the usual case for a report source — is exact, while the other three modes compose
//    against the reflection defaults.
//  - `SystemTime` is not carried: altea's QueryRequest has no SystemTime member yet (the system-time
//    support is on the query side, not the request DTO). A UserQuery with a stored `systemTime` therefore
//    runs at present time; flagged rather than silently mis-executed — see assertNoSystemTime.
//  - The stored enum fields are ORDINALS in memory and member NAMES on the wire, so each is read through
//    `Enum.toName` (the boundary rule this repo follows everywhere).

/** Signum's `UserQueryEntity.GetPagination()`. */
export function getPagination(userQuery: UserQueryEntity): Pagination | undefined {
    const mode = userQuery.paginationMode == null ? undefined : Enum.toName(PaginationModeEnum, userQuery.paginationMode);
    switch (mode) {
        case "All": return new Pagination.All();
        case "Firsts": return new Pagination.Firsts(Number(userQuery.elementsPerPage!));
        case "Paginate": return new Pagination.Paginate(Number(userQuery.elementsPerPage!), 1);
        default: return undefined;
    }
}

/**
 * Signum's `ToQueryRequest(userQuery, ignoreHidden)` — the stored asset as an executable request.
 *
 * `ignoreHidden` drops the columns the author marked hidden (Signum uses it when the consumer renders the
 * columns itself, e.g. a chart).
 */
export function toQueryRequest(userQuery: UserQueryEntity, ignoreHidden = false): QueryRequest {
    const queryName = queryNameOf(userQuery);
    assertNoSystemTime(userQuery);

    return new QueryRequest(
        queryName,
        QueryFilterUtils.toFilterList(queryName, userQuery.filters),
        userQuery.orders.map(qo => new Order(token(queryName, qo.token.tokenString), orderTypeOf(qo.orderType))),
        mergeColumns(userQuery, queryName, ignoreHidden),
        getPagination(userQuery) ?? new Pagination.All(),
        userQuery.groupResults,
    );
}

/**
 * Signum's `ToQueryRequestValue` — the same request reduced to ONE value column (a `Count` by default),
 * for the "big value" consumers that only need the aggregate.
 */
export function toQueryRequestValue(userQuery: UserQueryEntity, valueToken?: QueryToken): QueryRequest {
    const queryName = queryNameOf(userQuery);
    assertNoSystemTime(userQuery);

    const vt = valueToken ?? token(queryName, "Count");
    const isAggregate = vt.hasAggregate();

    return new QueryRequest(
        queryName,
        QueryFilterUtils.toFilterList(queryName, userQuery.filters),
        isAggregate ? [] : userQuery.orders.map(qo => new Order(token(queryName, qo.token.tokenString), orderTypeOf(qo.orderType))),
        [new Column(vt)],
        getPagination(userQuery) ?? new Pagination.All(),
        userQuery.groupResults || isAggregate,
    );
}

/** Signum's MergeColumns — how the stored columns combine with the query's defaults. */
function mergeColumns(userQuery: UserQueryEntity, queryName: QueryName, ignoreHidden: boolean): Column[] {
    const mode = Enum.toName(ColumnOptionsModeEnum, userQuery.columnsMode);
    const stored = userQuery.columns
        .filter(c => !c.hiddenColumn || !ignoreHidden)
        .map(c => toColumn(queryName, c));

    // Signum takes `qd.Columns.Where(cd => !cd.IsEntity)`: the entity column itself is the row identity,
    // never a displayed default. altea's reflection defaults start with Id and carry no entity column.
    const defaults = (): Column[] => reflectionDefaultColumns(QueryLogic.queries.rootToken(queryName)).map(t => new Column(t));

    switch (mode) {
        case "Add":
            return [...defaults(), ...stored];

        case "Remove": {
            const removed = new Set(userQuery.columns.map(c => c.token.tokenString.toLowerCase()));
            return defaults().filter(c => !removed.has(c.token.fullKey().toLowerCase()));
        }

        case "ReplaceAll":
            return stored;

        case "ReplaceOrAdd": {
            const result = defaults();
            for (const item of stored) {
                const index = result.findIndex(o => o.token.fullKey() === item.token.fullKey());
                if (index !== -1)
                    result[index] = item;
                else
                    result.push(item);
            }
            return result;
        }

        default:
            throw new Error(`${String(mode)} is not a valid ColumnOptionsMode`);
    }
}

/** Signum's ToColumn — the stored display name wins, else the token's nice name. */
function toColumn(queryName: QueryName, co: UserQueryEntity_Column): Column {
    const t = token(queryName, co.token.tokenString);
    return new Column(t, co.displayName != null && co.displayName !== "" ? co.displayName : undefined);
}

function queryNameOf(userQuery: UserQueryEntity): QueryName {
    const queryName = QueryLogic.tryGetQueryNameByKey(userQuery.query.key);
    if (queryName == null)
        throw new Error(`The query '${userQuery.query.key}' of UserQuery '${userQuery.displayName}' is not registered in this database`);
    return queryName;
}

function token(queryName: QueryName, tokenString: string): QueryToken {
    return QueryLogic.getToken(queryName, tokenString, SubTokensOptionsAll);
}

function orderTypeOf(orderType: OrderTypeEnum): Order["orderType"] {
    return Enum.toName(OrderTypeEnum, orderType) as Order["orderType"];
}

/**
 * A stored system-time window cannot be carried into altea's QueryRequest (it has no SystemTime member).
 * Executing such a UserQuery at present time would silently return the WRONG rows, so refuse instead.
 */
function assertNoSystemTime(userQuery: UserQueryEntity): void {
    if (userQuery.systemTime != null)
        throw new Error(
            `UserQuery '${userQuery.displayName}' has a SystemTime window, which altea's QueryRequest ` +
            `cannot carry yet — executing it server-side would silently query the present instead.`);
}
