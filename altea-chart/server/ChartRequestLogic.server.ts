import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { Column, Order, Pagination, QueryRequest, type Filter } from "@altea/altea/server/dynamicQuery/requests";
import type { ResultTable } from "@altea/altea/server/dynamicQuery/resultTable";
import { SubTokensOptionsAll, type QueryToken } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { Enum } from "@altea/altea/data/enum";
import { OrderTypeEnum } from "@altea/altea/data/dynamicQueries";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { QueryFilterUtils } from "@altea/altea-user-assets/server/QueryFilterUtils.server";
import { ChartColumnEmbedded } from "../data/ChartColumn";
import { ChartParameterEmbedded } from "../data/ChartParameter";
import { ChartRequestModel } from "../data/ChartRequest";
import type { UserChartEntity } from "../data/UserChart";

// Port of Signum's `ChartLogic.ExecuteChartAsync` / `ChartRequestModel.ToQueryRequest` and
// `UserChartLogic.ToChartRequest` — running a chart on the SERVER.
//
// Why this exists: altea builds a chart request in the BROWSER (query tokens and filter values are resolved
// client-side — the "QueryDescription is gone" divergence in the repo's CLAUDE.md), so until now nothing
// could execute a stored UserChart without a browser in the loop. Anything headless needs it:
// @altea/altea-office-template binding a chart to `UserChart:<id>` alternative text, a scheduled report,
// a cached dashboard query.
//
// The key realisation: at EXECUTION time a chart is just a query. The script, the parameters and the column
// slots shape how the result is DRAWN, not how it is FETCHED — so `executeChartAsync` is exactly
// `executeQueryAsync(toQueryRequest(...))`, as it is in Signum.
//
// altea divergences:
//  - Signum's ChartRequestModel carries its filters in an `[InTypeScript(false)] List<Filter> Filters`
//    member — server-only, invisible to TS. altea's ChartRequestModel is ISOMORPHIC and has no such member
//    (the client sends filters alongside, in the request DTO). So the pair travels as an explicit
//    `ChartExecution` here rather than being smuggled onto the model.
//  - A stored `QueryTokenEmbedded` carries its `tokenString`; the resolved `token` is filled client-side.
//    Server-side every token is resolved through `QueryLogic.getToken`, as UserQueryRequest does.
//  - Signum's ChartRequestModel constructor runs `SynchronizeColumns`, creating one column per script slot
//    which the stored columns are then zipped into. altea has no such constructor (the editor calls
//    `ChartClient.synchronizeColumns`), and a STORED UserChart's columns are already slot-aligned — the
//    editor synchronized them at save time — so they are copied straight across, which is what the zip
//    amounts to.
//  - `ChartTimeSeries` -> `SystemTimeRequest` is NOT carried: altea's QueryRequest has no SystemTime
//    member. A chart with a time-series window throws rather than silently querying the present.

/**
 * A chart request together with its resolved filters — Signum's ChartRequestModel including the
 * server-only `Filters` member it hides from TypeScript.
 */
export interface ChartExecution {
    readonly model: ChartRequestModel;
    readonly filters: Filter[];
}

/** Signum's `ChartRequestModel.GetQueryColumns()`. */
export function getQueryColumns(model: ChartRequestModel, queryName: QueryName): Column[] {
    return model.columns
        .filter(c => c.token != null)
        .map(c => new Column(
            token(queryName, c.token!.tokenString),
            c.displayName != null && c.displayName !== "" ? c.displayName : undefined));
}

/**
 * Signum's `ChartRequestModel.GetQueryOrders()` — the columns the author marked as ordered.
 *
 * Signum sorts these by `OrderByType`, which groups every Ascending column before every Descending one
 * regardless of the author's numbering. altea sorts by `orderByIndex`, which is what that field exists for
 * and what the chart editor's UI implies. Flagged as a deliberate difference rather than a silent one.
 */
export function getQueryOrders(model: ChartRequestModel, queryName: QueryName): Order[] {
    return model.columns
        .filter(c => c.orderByIndex != null && c.token != null)
        .sort((a, b) => Number(a.orderByIndex) - Number(b.orderByIndex))
        .map(c => new Order(token(queryName, c.token!.tokenString), orderTypeOf(c.orderByType!)));
}

/**
 * Signum's `ChartRequestModel.HasAggregates()` — FILTERS count too, not just columns.
 *
 * The isomorphic `ChartRequestModel.hasAggregates()` inspects only the column tokens; its own header says
 * the filter side is detected "in the request-builder, where the filters live". This is that builder.
 */
export function hasAggregates(execution: ChartExecution, queryName: QueryName): boolean {
    const columnAggregate = execution.model.columns
        .some(c => c.token != null && token(queryName, c.token.tokenString).hasAggregate());

    return columnAggregate
        || execution.filters.some(f => f.getTokens().some(t => t.hasAggregate()));
}

/** Signum's `ChartRequestModel.ToQueryRequest()`. */
export function toQueryRequest(execution: ChartExecution): QueryRequest {
    const { model, filters } = execution;
    // The local guard first: it is cheap, independent of registration, and guards against SILENT
    // wrongness rather than a plain misconfiguration.
    assertNoTimeSeries(model.chartTimeSeries, model.queryKey);
    const queryName = queryNameOfKey(model.queryKey);

    return new QueryRequest(
        queryName,
        filters,
        getQueryOrders(model, queryName),
        getQueryColumns(model, queryName),
        // Signum asks for maxRows + 1 so the caller can tell "exactly maxRows" from "more were available".
        model.maxRows != null ? new Pagination.Firsts(Number(model.maxRows) + 1) : new Pagination.All(),
        hasAggregates(execution, queryName),
    );
}

/** Signum's `ChartLogic.ExecuteChartAsync`. */
export function executeChartAsync(execution: ChartExecution): Promise<ResultTable> {
    return QueryLogic.queries.executeQueryAsync(toQueryRequest(execution));
}

/** Signum's `UserChartLogic.ToChartRequest(userChart)` — the stored asset as an executable chart request. */
export function toChartRequest(userChart: UserChartEntity): ChartExecution {
    assertNoTimeSeries(userChart.chartTimeSeries, userChart.query.key);
    const queryName = queryNameOfUserChart(userChart);

    const model = ChartRequestModel.create({
        queryKey: userChart.query.key,
        chartScript: userChart.chartScript,
        maxRows: userChart.maxRows,
        chartTimeSeries: userChart.chartTimeSeries,
        columns: userChart.columns.map(c => cloneColumn(c.element)),
        parameters: userChart.parameters.map(p => cloneParameter(p.element)),
    });

    return { model, filters: QueryFilterUtils.toFilterList(queryName, userChart.filters) };
}

/** Run a stored UserChart end to end. */
export function executeUserChartAsync(userChart: UserChartEntity): Promise<ResultTable> {
    return executeChartAsync(toChartRequest(userChart));
}

// ---- helpers -------------------------------------------------------------------------------------------

function cloneColumn(c: ChartColumnEmbedded): ChartColumnEmbedded {
    return ChartColumnEmbedded.create({
        token: c.token == null ? null : QueryTokenEmbedded.create({ tokenString: c.token.tokenString }),
        displayName: c.displayName,
        format: c.format,
        orderByIndex: c.orderByIndex,
        orderByType: c.orderByType,
    });
}

function cloneParameter(p: ChartParameterEmbedded): ChartParameterEmbedded {
    return ChartParameterEmbedded.create({ name: p.name, value: p.value });
}

function queryNameOfKey(queryKey: string): QueryName {
    const queryName = QueryLogic.tryGetQueryNameByKey(queryKey);
    if (queryName == null)
        throw new Error(`The query '${queryKey}' is not registered in this database`);
    return queryName;
}

function queryNameOfUserChart(userChart: UserChartEntity): QueryName {
    const queryName = QueryLogic.tryGetQueryNameByKey(userChart.query.key);
    if (queryName == null)
        throw new Error(
            `The query '${userChart.query.key}' of UserChart '${userChart.displayName}' is not registered in this database`);
    return queryName;
}

function token(queryName: QueryName, tokenString: string): QueryToken {
    return QueryLogic.getToken(queryName, tokenString, SubTokensOptionsAll);
}

function orderTypeOf(orderType: NonNullable<ChartColumnEmbedded["orderByType"]>): Order["orderType"] {
    return (typeof orderType === "string" ? orderType : Enum.toName(OrderTypeEnum, orderType)) as Order["orderType"];
}

/**
 * A stored time-series window cannot be carried into altea's QueryRequest (it has no SystemTime member).
 * Executing such a chart at present time would silently return the WRONG rows, so refuse — the same call
 * UserQueryRequest makes for a stored SystemTime.
 */
function assertNoTimeSeries(chartTimeSeries: unknown, queryKey: string): void {
    if (chartTimeSeries != null)
        throw new Error(
            `The chart on query '${queryKey}' has a ChartTimeSeries window, which altea's QueryRequest ` +
            `cannot carry yet — executing it server-side would silently query the present instead.`);
}
