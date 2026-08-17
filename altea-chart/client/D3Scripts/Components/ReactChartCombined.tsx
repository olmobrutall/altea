import * as React from "react";
import { classes } from "@altea/altea/data/globals/index";
import { useSize, useThrottle } from "@altea/altea/client/Hooks";
import { ChartRequestModel } from "../../../data/ChartRequest";
import type { ChartRow, ChartTable } from "../../ChartClient";
import ReactChart, { MemoRepository } from "./ReactChart";
import { renderCombinedLinesAndColumns } from "../CombinedLinesAndColumns";

// Copy-and-fix of Signum.Chart/D3Scripts/Components/ReactChartCombined.tsx — the ReactChart twin that paints
// SEVERAL chart requests into ONE svg (a dashboard's CombinedUserChartPart). Fixes: @framework/* → altea
// paths, ../../Signum.Chart → ../../../data/ChartRequest, and the unused QueryDescription import dropped
// (altea has no such DTO).

export interface ReactChartCombinedInfo {
    chartRequest: ChartRequestModel;
    data?: ChartTable;
    parameters: { [parameter: string]: string };
    memo: MemoRepository;
    onDrillDown: (row: ChartRow, e: React.MouseEvent | MouseEvent) => void;
}

export function ReactChartCombined(p: {
    infos: ReactChartCombinedInfo[],
    useSameScale: boolean,
    minHeigh: number | null,
    sizeDeps?: React.DependencyList,
}): React.JSX.Element {

    const isSimple = p.infos.every(a => a.data == null || a.data.rows.length < ReactChart.Options.maxRowsForAnimation);
    const allData = p.infos.every(a => a.data != null);
    const oldAllData = useThrottle(allData, 200, { enabled: isSimple });
    const initialLoad = oldAllData == false && allData && isSimple;

    const { size, setContainer } = useSize({ deps: p.sizeDeps });

    return (
        <div className={classes("sf-chart-container", isSimple ? "sf-chart-animable" : "")}
            style={{ minHeight: (p.minHeigh ?? 400) + "px" }}
            ref={setContainer}>
            {size &&
                renderCombinedLinesAndColumns({
                    infos: p.infos,
                    width: size.width,
                    height: size.height,
                    initialLoad: initialLoad,
                    useSameScale: p.useSameScale,
                })
            }
        </div>
    );
}
