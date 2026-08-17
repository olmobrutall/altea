import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as AppContext from "@altea/altea/client/AppContext";
import { Finder } from "@altea/altea/client/Finder";
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { ChartClient } from "./ChartClient";
import { ChartMessage } from "../data/ChartMessage";

// Port of Signum's Signum.Chart/ChartButton.tsx — the toolbar button on a SearchControl that opens the
// current query (+ its filters) as a chart. altea divergences: no Finder.getQueryDescription — altea's
// `Finder.toFindOptions` takes the SearchControl's already-resolved queryToken; no ViewCharting client
// permission check (altea gates charting server-side). The system-time → ChartTimeSeries mapping is
// dropped for now (the user re-adds a time window in the chart editor if needed).
export interface ChartButtonProps {
    searchControl: SearchControlLoaded;
}

export default function ChartButton(p: ChartButtonProps): React.JSX.Element {
    const sc = p.searchControl;

    function handleClick(e: React.MouseEvent<any>): void {
        if (e.button == 2)
            return;

        const fo = Finder.toFindOptions(sc.props.findOptions, sc.props.queryToken, false);
        const path = ChartClient.Encoder.chartPath({
            queryName: sc.props.findOptions.queryKey, // the string query key (fo.queryName is a PseudoType)
            orderOptions: [],
            filterOptions: fo.filterOptions,
        });

        if (sc.props.avoidChangeUrl)
            window.open(AppContext.toAbsoluteUrl(path));
        else
            AppContext.pushOrOpenInTab(path, e);
    }

    const label = sc.props.largeToolbarButtons == true
        ? <span className="d-none d-sm-inline">{" " + ChartMessage.Chart.niceToString()}</span>
        : undefined;

    return (
        <button className="btn btn-tertiary" onMouseDown={handleClick} title={ChartMessage.Chart.niceToString()}>
            <FontAwesomeIcon aria-hidden={true} icon="chart-bar" />&nbsp;{label}
        </button>
    );
}
