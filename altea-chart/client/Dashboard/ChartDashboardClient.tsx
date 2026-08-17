import * as React from "react";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { DashboardClient } from "@altea/altea-dashboard/client/DashboardClient";
import { CombinedUserChartPartEntity, UserChartPartEntity } from "../../data/DashboardParts";

// altea's counterpart of the dashboard registrations Signum performs inside UserChartClient.start (its
// `Navigator.addSettings` + `DashboardClient.registerRenderer` for the chart parts). Kept in its own module so
// the @altea/altea-dashboard dependency of @altea/altea-chart is visible in ONE place.
//
// Called from UserChartClient.start.

export namespace ChartDashboardClient {
    export function start(cb: ClientBuilder): void {

        cb.configure(UserChartPartEntity).withView(() => import("./Admin/UserChartPart"));
        cb.configure(CombinedUserChartPartEntity).withView(() => import("./Admin/CombinedUserChartPart"));

        DashboardClient.registerRenderer(UserChartPartEntity, {
            component: () => import("./View/UserChartPart").then(a => a.default),
            icon: () => ({ icon: "chart-bar", iconColor: "darkviolet" }),
            defaultTitle: e => e.userChart?.displayName ?? "",
            getQueryNames: e => e.userChart == null ? [] : [e.userChart.query.key],
            waitForInvalidation: true,
        });

        DashboardClient.registerRenderer(CombinedUserChartPartEntity, {
            component: () => import("./View/CombinedUserChartPart").then(a => a.default),
            icon: () => ({ icon: "layer-group", iconColor: "darkviolet" }),
            getQueryNames: e => (e.userCharts ?? []).map(uc => uc.userChart.query.key),
            waitForInvalidation: true,
        });
    }
}
