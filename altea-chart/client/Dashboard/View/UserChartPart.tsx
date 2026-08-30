import * as React from "react";
import { ServiceError } from "@altea/altea/client/Services";
import { Finder } from "@altea/altea/client/Finder";
import { useAPI, useAPIWithReload } from "@altea/altea/client/Hooks";
import { isActive, isFilterGroup, type FilterOptionParsed } from "@altea/altea/client/FindOptions";
import { tokenStartsWith, type QueryToken } from "@altea/altea/client/QueryToken";
import PinnedFilterBuilder from "@altea/altea/client/SearchControl/PinnedFilterBuilder";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { getTypeInfo } from "@altea/altea/data/reflection";
import type { PanelPartContentProps } from "@altea/altea-dashboard/client/DashboardClient";
import {
    DashboardFilter, DashboardPinnedFilters, allTokens, equalsDFR, type DashboardFilterRow,
} from "@altea/altea-dashboard/client/View/DashboardFilterController";
import { ChartMessage } from "../../../data/ChartMessage";
import type { ChartRequestModel } from "../../../data/ChartRequest";
import { ChartClient, type ChartRow } from "../../ChartClient";
import ChartRenderer, { handleDrillDown } from "../../Templates/ChartRenderer";
import ChartTableComponent from "../../Templates/ChartTable";
import { UserChartClient } from "../../UserChart/UserChartClient";
import { UserChartPartEntity } from "../../../data/DashboardParts";

// Port of Signum's Signum.Chart/Dashboard/View/UserChartPart.tsx — runs the saved chart in a dashboard cell:
// it publishes the chart's dashboard-pinned filters and its "use as initial selection" filter, applies the
// cross-filters other parts of the interaction group published, and turns a click on a chart mark into either
// a drill-down (Alt / no interaction group) or a cross-filter (plain / Ctrl click to accumulate).
//
// altea divergences: no cached-query path (CachedQuery is deferred), and `Finder.getQueryDescription` →
// `Finder.getQueryRoot` (altea has no QueryDescription DTO; PinnedFilterBuilder takes the query root token).

export interface UserChartPartHandler {
    chartRequest: ChartRequestModel | undefined;
    reloadQuery: () => void;
}

export default function UserChartPart(p: PanelPartContentProps<UserChartPartEntity>): React.JSX.Element {

    const queryToken = useAPI(() => Finder.getQueryRoot(p.content.userChart.query.key), [p.content.userChart.query.key]);
    const chartRequest = useAPI(() => UserChartClient.Converter.toChartRequest(p.content.userChart, p.entity),
        [p.content.userChart, p.entity?.key(), ...p.deps ?? []]);

    const initialSelection = React.useMemo(() => chartRequest?.filterOptions.singleOrNull(a => a.dashboardBehaviour == "UseAsInitialSelection"), [chartRequest]);
    const dashboardPinnedFilters = React.useMemo(() => chartRequest?.filterOptions.filter(a => a.dashboardBehaviour == "PromoteToDasboardPinnedFilter"), [chartRequest]);
    const useWhenNoFilters = React.useMemo(() => chartRequest?.filterOptions.filter(a => a.dashboardBehaviour == "UseWhenNoFilters"), [chartRequest]);
    const simpleFilters = React.useMemo(() => chartRequest?.filterOptions.filter(a => a.dashboardBehaviour == null), [chartRequest]);
    const [refreshKey, setRefreshKey] = React.useState<number>(0);

    if (chartRequest != null) {
        const dashboardFilters = p.dashboardController.getFilterOptions(p.partEmbedded, chartRequest.queryKey);
        const tokens: QueryToken[] = allTokens(dashboardFilters.filter(df => isActive(df)));

        chartRequest.filterOptions = [
            ...simpleFilters!,
            ...useWhenNoFilters!.filter(a => !tokens.some(t => tokenStartsWith(a.token!, t))),
            ...dashboardFilters,
        ];
    }

    React.useEffect(() => {

        if (initialSelection) {

            if (isFilterGroup(initialSelection))
                throw new Error("UseAsInitialSelection is not compatible with filter groups");

            const dashboardFilter = new DashboardFilter(p.partEmbedded, chartRequest!.queryKey);
            if (initialSelection.operation == "EqualTo")
                dashboardFilter.rows.push({ filters: [{ token: initialSelection.token!, value: initialSelection.value }] });
            else if (initialSelection.operation == "IsIn")
                (initialSelection.value as unknown[]).forEach(val => dashboardFilter.rows.push({ filters: [{ token: initialSelection.token!, value: val }] }));
            else
                throw new Error("DashboardFilter is not compatible with filter operation " + initialSelection.operation);

            p.dashboardController.setFilter(dashboardFilter);
        } else {
            p.dashboardController.clearFilters(p.partEmbedded);
        }

        if (dashboardPinnedFilters?.length && queryToken)
            p.dashboardController.setPinnedFilter(new DashboardPinnedFilters(p.partEmbedded, chartRequest!.queryKey, queryToken, dashboardPinnedFilters));
        else
            p.dashboardController.clearPinnedFilter(p.partEmbedded);

        if (chartRequest)
            p.dashboardController.registerInvalidations(p.partEmbedded, () => setRefreshKey(a => a + 1));

    }, [chartRequest, queryToken]);

    // The reload dep is Signum's: the chart request ENCODED as its url. `chartRequest` itself is a stable
    // object that the block above MUTATES in place with the cross-filters other parts published, so depending
    // on it re-runs nothing — the encoded path is what actually changes when a sibling part publishes a
    // dashboard filter, and it is what makes the dashboard cross-filter at all.
    const [resultOrError, reloadQuery] = useAPIWithReload<undefined | { error?: unknown, result?: ChartClient.API.ExecuteChartResult }>(() => {
        if (chartRequest == null || p.dashboardController.isLoading)
            return Promise.resolve(undefined);

        return ChartClient.getChartScript(chartRequest.chartScript)
            .then(cs => ChartClient.API.executeChart(chartRequest, cs))
            .then(result => ({ result }), (error: unknown) => ({ error }));

    }, [
        chartRequest && ChartClient.Encoder.chartPath(ChartClient.Encoder.toChartOptions(chartRequest, null)),
        p.dashboardController.isLoading,
        refreshKey,
        ...p.deps ?? [],
    ], { avoidReset: true });

    p.customDataRef.current = {
        chartRequest,
        reloadQuery,
    } as UserChartPartHandler;

    // Signum's `useState(p.content.showData)` — the part's configured default, which the viewer may toggle
    // when `allowChangeShowData`.
    const [showData, setShowData] = React.useState(p.content.showData);

    function renderError(e: unknown): React.JSX.Element {
        if (e instanceof ServiceError)
            return <div>{e.httpError.exceptionMessage && <p className="text-danger">{e.httpError.exceptionMessage}</p>}</div>;

        return <p className="text-danger">{(e as Error)?.message ?? String(e)}</p>;
    }

    if (!chartRequest || !queryToken)
        return <span>{JavascriptMessage.loading.niceToString()}</span>;

    if (p.dashboardController.isLoading)
        return <span>{JavascriptMessage.loading.niceToString()}...</span>;

    if (resultOrError?.error) {
        return (
            <div>
                <h1 className="h4">Error!</h1>
                {renderError(resultOrError.error)}
            </div>
        );
    }

    function handleReload(): void {
        reloadQuery();
    }

    const result = resultOrError?.result;

    return (
        <div className="d-flex flex-column flex-grow-1">
            <PinnedFilterBuilder queryToken={queryToken} filterOptions={chartRequest.filterOptions}
                onFiltersChanged={(_fops, avoidSearch) => !avoidSearch && reloadQuery()}
                pinnedFilterVisible={fop => fop.dashboardBehaviour == null} extraSmall={true} />
            {p.content.allowChangeShowData &&
                <label>
                    <input type="checkbox" className="form-check-input" checked={showData}
                        onChange={e => setShowData(e.currentTarget.checked)} />
                    {/* Signum's `UserChartPartEntity.nicePropertyName(a => a.showData)`; altea reads the
                        localized field name off the TypeInfo (no such static). */}
                    {" "}{getTypeInfo(UserChartPartEntity)?.fields["showData"]?.niceToString()}
                </label>}
            {result != null && chartRequest.maxRows == result.resultTable.rows.length ?
                <p className="text-danger">{ChartMessage.QueryResultReachedMaxRows0.niceToString(result.resultTable.rows.length)}</p> : undefined}
            {showData ?
                (!result ? <span>{JavascriptMessage.loading.niceToString()}</span> :
                    <ChartTableComponent
                        chartRequest={chartRequest}
                        lastChartRequest={chartRequest}
                        resultTable={result.resultTable}
                        onOrderChanged={() => reloadQuery()}
                        onReload={handleReload}
                    />) :
                <ChartRenderer
                    chartRequest={chartRequest}
                    data={result?.chartTable}
                    minHeight={p.content.minHeight as number | null}
                    loading={result === undefined}
                    onBackgroundClick={e => {
                        if (!e.ctrlKey)
                            p.dashboardController.clearFilters(p.partEmbedded);
                    }}
                    dashboardFilter={p.dashboardController.filters.get(p.partEmbedded)}
                    onDrillDown={(row, e) => {
                        e.stopPropagation();
                        if (e.altKey || p.partEmbedded.interactionGroup == null) {
                            handleDrillDown(row, e, chartRequest, handleReload);
                            return;
                        }

                        const dashboardFilter = p.dashboardController.filters.get(p.partEmbedded);
                        const filterRow = toDashboardFilterRow(row, chartRequest);

                        if (e.ctrlKey) {
                            const already = dashboardFilter?.rows.firstOrNull(fr => equalsDFR(fr, filterRow));
                            if (already) {
                                dashboardFilter!.rows.remove(already);
                                if (dashboardFilter!.rows.length == 0)
                                    p.dashboardController.clearFilters(dashboardFilter!.partEmbedded);
                                else
                                    p.dashboardController.setFilter(dashboardFilter!);
                            } else {
                                const db = dashboardFilter ?? new DashboardFilter(p.partEmbedded, chartRequest.queryKey);
                                db.rows.push(filterRow);
                                p.dashboardController.setFilter(db);
                            }
                        } else {
                            const already = dashboardFilter?.rows.firstOrNull(fr => equalsDFR(fr, filterRow));
                            if (already && dashboardFilter?.rows.length == 1) {
                                p.dashboardController.clearFilters(dashboardFilter.partEmbedded);
                            } else {
                                const db = new DashboardFilter(p.partEmbedded, chartRequest.queryKey);
                                db.rows.push(filterRow);
                                p.dashboardController.setFilter(db);
                            }
                        }
                    }}
                    onReload={handleReload}
                />
            }
        </div>
    );
}

// Signum's toDashboardFilterRow: the clicked row's KEY columns (never aggregates) become the cross-filter.
function toDashboardFilterRow(row: ChartRow, chartRequest: ChartRequestModel): DashboardFilterRow {
    const filters = chartRequest.columns
        .map((c, i) => ({
            token: c.token?.token,
            value: (row as unknown as Record<string, unknown>)["c" + i],
        }))
        .filter(a => a.token != null && !a.token.isAggregate() && a.value !== undefined);

    return { filters } as DashboardFilterRow;
}
