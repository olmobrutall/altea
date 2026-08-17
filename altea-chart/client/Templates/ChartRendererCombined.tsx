import * as React from "react";
import { ErrorBoundary } from "@altea/altea/client/Components";
import { Lite } from "@altea/altea/data/lite";
import { ChartRequestModel } from "../../data/ChartRequest";
import type { UserChartEntity } from "../../data/UserChart";
import { ChartClient, type ChartTable } from "../ChartClient";
import { MemoRepository } from "../D3Scripts/Components/ReactChart";
import { ReactChartCombined } from "../D3Scripts/Components/ReactChartCombined";
import { handleDrillDown } from "./ChartRenderer";
import "../Chart.css";

// Copy-and-fix of Signum.Chart/Templates/ChartRendererCombined.tsx — the ChartRenderer twin for a COMBINED
// chart (several UserCharts over one axis). altea divergences: no FullscreenComponent wrapper (not ported),
// and `handleDrillDown` takes no UserChart lite (altea-chart's drill-down has no per-UserChart cross-filter
// yet — see ChartRenderer's header), so `userChart` only identifies the info row.

export interface ChartRendererCombinedProps {
    infos: ChartRendererCombinedInfo[];
    onReload?: (e: React.MouseEvent<any>) => void;
    useSameScale: boolean;
    minHeigh: number | null;
}

export interface ChartRendererCombinedInfo {
    userChart: Lite<UserChartEntity>;
    chartRequest: ChartRequestModel;
    chartScript: ChartClient.ChartScript;
    data?: ChartTable;
    memo: MemoRepository;
}

export default function ChartRendererCombined(p: ChartRendererCombinedProps): React.JSX.Element {
    return (
        <ErrorBoundary deps={p.infos.map(a => a.data)}>
            <ReactChartCombined useSameScale={p.useSameScale} minHeigh={p.minHeigh} infos={p.infos.map(info => ({
                chartRequest: info.chartRequest,
                onDrillDown: (r, e) => handleDrillDown(r, e, info.chartRequest, p.onReload as (() => void) | undefined),
                parameters: ChartClient.API.getParameterWithDefault(info.chartRequest, info.chartScript),
                data: info.data,
                memo: info.memo,
            }))} />
        </ErrorBoundary>
    );
}
