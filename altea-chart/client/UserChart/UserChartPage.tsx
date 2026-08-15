import * as React from "react";
import { useState } from "react";
import { useParams } from "react-router";
import { Navigator } from "@altea/altea/client/Navigator";
import ChartRequestView from "../Templates/ChartRequestView";
import { getQueryNiceName, newLite } from "@altea/altea/client/Reflection";
import { useAPI } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import { Lite } from "@altea/altea/data/lite";
import type { ChartRequestModel } from "../../data/ChartRequest";
import { UserChartEntity } from "../../data/UserChart";
import { UserChartClient } from "./UserChartClient";

// Port of Signum's Signum.Chart/UserChart/UserChartPage.tsx. Fetches the UserChart, builds its
// ChartRequestModel (Converter), and runs it in a ChartRequestView. altea divergence: Signum navigates to
// the chart page via the URL Encoder (chartPathPromise); altea has no chart-URL round-trip, so this page
// renders the built ChartRequestModel in a ChartRequestView directly (mirrors UserQueryPage running a
// SearchControl, and ChartRequestPage building its own model).
export default function UserChartPage(): React.JSX.Element | null {
    const params = useParams() as { userChartId: string; entity?: string };
    const { userChartId, entity } = params;

    const [currentUserChart, setCurrentUserChart] = useState<UserChartEntity | null>(null);

    const cr = useAPI<ChartRequestModel | undefined>(() =>
        Navigator.API.fetch(newLite(UserChartEntity, userChartId) as Lite<UserChartEntity>)
            .then(uc => {
                setCurrentUserChart(uc);
                const lite = entity == undefined ? undefined : Lite.parse(entity);
                return UserChartClient.Converter.toChartRequest(uc, lite);
            }),
        [userChartId, entity]);

    useTitle(cr == null ? "…"
        : getQueryNiceName(cr.queryKey) + (currentUserChart ? " - " + currentUserChart.displayName : ""));

    if (cr == undefined || currentUserChart == null)
        return null;

    return (
        <div className="m-3">
            <ChartRequestView chartRequest={cr} searchOnLoad />
        </div>
    );
}
