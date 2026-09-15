import * as React from "react";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import * as AppContext from "@altea/altea/client/AppContext";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { SelectorMessage } from "@altea/altea/data/uiMessages";
import { DashboardClient } from "@altea/altea-dashboard/client/DashboardClient";
import { ChartClient } from "../ChartClient";
import { UserChartClient } from "../UserChart/UserChartClient";
import { CombinedUserChartPartEntity, UserChartPartEntity } from "../../data/DashboardParts";
import type { UserChartPartHandler } from "./View/UserChartPart";

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
            // Clicking the panel title opens the chart full screen in the chart page. It encodes the
            // HANDLER's chartRequest (what the cell is actually showing — dashboard cross-filters included),
            // not a fresh conversion of the UserChart, so the page opens on the same data.
            handleTitleClick: (c, _entity, cdRef, ev) => {
                const handler = cdRef.current as UserChartPartHandler;
                if (handler?.chartRequest == null)
                    return;

                ChartClient.Encoder.chartPathPromise(handler.chartRequest, c.userChart.toLite())
                    .then(path => AppContext.pushOrOpenInTab(path, ev));
            },
        });

        // No `waitForInvalidation` here — matching Signum (UserChartClient.start sets it on the single-chart
        // part only). The flag makes DashboardFilterController.isLoading wait until the part has called
        // registerInvalidations, and the combined view never does (it has no per-part refresh key), so
        // claiming it would leave EVERY part of a dashboard containing one stuck on "Loading…".
        DashboardClient.registerRenderer(CombinedUserChartPartEntity, {
            component: () => import("./View/CombinedUserChartPart").then(a => a.default),
            icon: () => ({ icon: "layer-group", iconColor: "darkviolet" }),
            getQueryNames: e => (e.userCharts ?? []).map(uc => uc.userChart.query.key),
            // A combined part draws SEVERAL charts in one panel, so there is no single chart to open: ask
            // which one first (the selector short-circuits when there is only one). Unlike the single-chart
            // part there is no per-chart handler to read, so the request is re-converted from the UserChart —
            // the combined view does not apply cross-filters of its own either.
            handleTitleClick: (c, entity, _cdRef, ev) => {
                SelectorModal.chooseElement(c.userCharts ?? [], {
                    buttonDisplay: a => a.userChart.displayName ?? "",
                    buttonName: a => a.userChart.toLite().key(),
                    title: SelectorMessage.ChooseAValue.niceToString(),
                    message: SelectorMessage.PleaseChooseAValueToContinue.niceToString(),
                }).then(cuc => cuc && UserChartClient.Converter.toChartRequest(cuc.userChart, entity)
                    .then(cr => ChartClient.Encoder.chartPathPromise(cr, cuc.userChart.toLite()))
                    .then(path => AppContext.pushOrOpenInTab(path, ev)));
            },
        });
    }
}
