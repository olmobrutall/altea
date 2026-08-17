import * as React from "react";
import { ServiceError } from "@altea/altea/client/Services";
import { Finder } from "@altea/altea/client/Finder";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { QueryToken } from "@altea/altea/client/QueryToken";
import PinnedFilterBuilder from "@altea/altea/client/SearchControl/PinnedFilterBuilder";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { getTypeInfo } from "@altea/altea/data/reflection";
import type { PanelPartContentProps } from "@altea/altea-dashboard/client/DashboardClient";
import type { ChartRequestModel } from "../../../data/ChartRequest";
import type { UserChartEntity } from "../../../data/UserChart";
import { CombinedUserChartPartEntity } from "../../../data/DashboardParts";
import { ChartClient } from "../../ChartClient";
import { MemoRepository } from "../../D3Scripts/Components/ReactChart";
import ChartRendererCombined from "../../Templates/ChartRendererCombined";
import ChartTableComponent from "../../Templates/ChartTable";
import { UserChartClient } from "../../UserChart/UserChartClient";

// Port of Signum's Signum.Chart/Dashboard/View/CombinedUserChartPart.tsx — several saved charts painted over
// ONE shared axis inside a dashboard cell, each keeping its own filters (and re-querying when the dashboard's
// cross-filters change).
//
// altea divergences: no cached-query path (CachedQuery is deferred); `queryDescription` → the query ROOT token
// (`Finder.getQueryRoot`, what PinnedFilterBuilder takes); `nicePropertyName` → the TypeInfo field's
// niceToString; and the abort handling keeps Signum's shape.

export interface CombinedUserChartInfoTemp {
    userChart: UserChartEntity;
    chartScript?: ChartClient.ChartScript;
    chartRequest?: ChartRequestModel;
    queryToken?: QueryToken;
    memo: MemoRepository;
    result?: ChartClient.API.ExecuteChartResult;
    makeQuery?: () => Promise<void>;
    error?: unknown;
}

export default function CombinedUserChartPart(p: PanelPartContentProps<CombinedUserChartPartEntity>): React.JSX.Element {

    const forceUpdate = useForceUpdate();

    const infos = React.useMemo<CombinedUserChartInfoTemp[]>(
        () => (p.content.userCharts ?? []).map(uc => ({ userChart: uc.userChart } as CombinedUserChartInfoTemp)),
        [p.content]);

    const [showData, setShowData] = React.useState(p.content.showData);

    React.useEffect(() => {
        const abortController = new AbortController();
        const signal = abortController.signal;

        infos.forEach(c => {
            Promise.all([
                UserChartClient.Converter.toChartRequest(c.userChart, p.entity),
                Finder.getQueryRoot(c.userChart.query.key),
            ]).then(([chartRequest, queryToken]) => {
                c.chartRequest = chartRequest;
                c.queryToken = queryToken;
                const originalFilters = chartRequest.filterOptions.length;
                c.memo = new MemoRepository();
                forceUpdate();

                if (signal.aborted)
                    return undefined;

                return ChartClient.getChartScript(chartRequest.chartScript).then(cs => {
                    c.chartScript = cs;
                    forceUpdate();

                    c.makeQuery = () => {
                        // Re-apply THIS part's dashboard cross-filters on top of the chart's own filters.
                        chartRequest.filterOptions.splice(originalFilters);
                        chartRequest.filterOptions.push(
                            ...p.dashboardController.getFilterOptions(p.partEmbedded, chartRequest.queryKey));

                        return ChartClient.API.executeChart(chartRequest, cs)
                            .then(result => {
                                if (!signal.aborted) {
                                    c.result = result;
                                    forceUpdate();
                                }
                            })
                            .catch((error: unknown) => {
                                if (!signal.aborted) {
                                    c.error = error;
                                    forceUpdate();
                                }
                            });
                    };

                    return c.makeQuery();
                });
            }).catch((error: unknown) => {
                if (!signal.aborted) {
                    c.error = error;
                    forceUpdate();
                }
            });
        });

        return () => abortController.abort();

    }, [p.content, ...p.deps ?? []]);

    // Re-query when any of the charts' queries changed elsewhere on the dashboard (Signum's getLastChange).
    React.useEffect(() => {
        infos.forEach(inf => { inf.makeQuery?.(); });
    }, [p.content, ...p.deps ?? [], infos.max(e => p.dashboardController.getLastChange(e.userChart.query.key))]);

    function renderError(e: unknown, key: number): React.JSX.Element {
        if (e instanceof ServiceError)
            return <div key={key}>{e.httpError.exceptionMessage && <p className="text-danger">{e.httpError.exceptionMessage}</p>}</div>;

        return <p className="text-danger" key={key}>{(e as Error)?.message ?? String(e)}</p>;
    }

    if (infos.some(a => a.error != null)) {
        return (
            <div>
                <h1 className="h4">Error!</h1>
                {infos.filter(m => m.error != null).map((m, i) => renderError(m.error, i))}
            </div>
        );
    }

    if (infos.some(a => a.chartRequest == null || a.chartScript == null || a.queryToken == null))
        return <span>{JavascriptMessage.loading.niceToString()}</span>;

    return (
        <div>
            {infos.map((info, i) => <PinnedFilterBuilder key={i}
                queryToken={info.queryToken!}
                filterOptions={info.chartRequest!.filterOptions}
                pinnedFilterVisible={fop => fop.dashboardBehaviour == null}
                onFiltersChanged={(_fops, avoidSearch) => !avoidSearch && info.makeQuery!()} extraSmall={true} />
            )}
            {p.content.allowChangeShowData &&
                <label>
                    <input type="checkbox" className="form-check-input" checked={showData}
                        onChange={e => setShowData(e.currentTarget.checked)} />
                    {" "}{getTypeInfo(CombinedUserChartPartEntity)?.fields["showData"]?.niceToString()}
                </label>}
            {showData ?
                infos.map((c, i) => c.result == null ? <span key={i}>{JavascriptMessage.loading.niceToString()}</span> :
                    <ChartTableComponent key={i}
                        chartRequest={c.chartRequest!}
                        lastChartRequest={c.chartRequest!}
                        resultTable={c.result.resultTable}
                        onOrderChanged={() => c.makeQuery!()}
                        onReload={() => { c.makeQuery!(); }}
                    />) :
                <ChartRendererCombined
                    infos={infos.map(c => ({
                        userChart: c.userChart.toLite(true),
                        chartRequest: c.chartRequest!,
                        data: c.result?.chartTable,
                        chartScript: c.chartScript!,
                        memo: c.memo,
                    }))}
                    onReload={() => { infos.forEach(a => a.makeQuery!()); }}
                    useSameScale={p.content.useSameScale}
                    minHeigh={p.content.minHeight as number | null}
                />
            }
        </div>
    );
}
