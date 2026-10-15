import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Link, useLocation, useParams } from "react-router";
import { Popover, PopoverContent, PopoverTrigger } from "@altea/altea/client/ui/Tooltip";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { EntityControlMessage, JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Navigator } from "@altea/altea/client/Navigator";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import { useTitle } from "@altea/altea/client/AppContext";
import { useAPI, useAPIWithReload, useInterval } from "@altea/altea/client/Hooks";
import { toRelativeTime } from "@altea/altea/client/Basics/RelativeTime";
import { QueryString } from "@altea/altea/client/QueryString";
import { newLite } from "@altea/altea/client/Reflection";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { DashboardEntity, DashboardMessage } from "../../data/Dashboard";
import { DashboardClient } from "../DashboardClient";
import DashboardView from "./DashboardView";
import "../Dashboard.css";

// Port of Signum's Signum.Dashboard/View/DashboardPage.tsx — the /dashboard/:dashboardId page: fetches the
// dashboard, optionally the `?entity=` it is scoped to, applies the auto-refresh period and renders the
// DashboardView.
//
// altea divergences: no cached-query freshness banner (CachedQuery is deferred), and the auto-refresh
// re-renders the view through `deps` instead of re-fetching the (uncached) dashboard.

export default function DashboardPage(): React.JSX.Element {
    const location = useLocation();
    const params = useParams() as { dashboardId: string };

    const [dashboardWithQueries, reloadDashboard] = useAPIWithReload(
        () => DashboardClient.API.get(newLite(DashboardEntity, params.dashboardId) as Lite<DashboardEntity>),
        [params.dashboardId]);

    const dashboard = dashboardWithQueries?.dashboard;

    const entityKey = QueryString.parse(location.search).entity as string;

    const entity = useAPI(() => entityKey ? Navigator.API.fetch(Lite.parse(entityKey) as Lite<Entity>) : Promise.resolve(null), [entityKey]);

    const refreshCounter = useInterval(dashboard?.autoRefreshPeriod == null ? null : (dashboard.autoRefreshPeriod as number) * 1000, 0, old => old + 1);

    // A CACHED dashboard has to be RE-FETCHED to refresh: its parts read files, and a new generation of
    // those is reachable only through new rows. An uncached one refreshes through `deps` alone (Signum's
    // same effect, and the reason the page threads `refreshCounter` both ways).
    React.useEffect(() => {
        if (dashboardWithQueries != null && dashboardWithQueries.cachedQueries.length > 0)
            reloadDashboard();
    }, [refreshCounter]);

    const cachedQueries = React.useMemo(
        () => DashboardClient.toCachedQueries(dashboardWithQueries), [dashboardWithQueries]);

    useTitle(entity ? entity.toString() : (dashboard?.toString() ?? ""));

    return (
        <div className="sf-dashboard-page">

            {!dashboard ? <h1 className="text-display-6 font-light"><span>{JavascriptMessage.loading.niceToString()}</span></h1> :
                <div className="flex">
                    <div>
                        {entityKey ?
                            <div>
                                {!entity ? <h1 className="text-h3 font-medium">{JavascriptMessage.loading.niceToString()}</h1> :
                                    dashboard.showTitleAsBreadcrumb ?
                                        <h4 className="sf-breadcrumb-title">
                                            <EntityLink lite={entity.toLite()} inPlaceNavigation />
                                            <FontAwesomeIcon aria-hidden={true} className="mx-2" icon="chevron-right" />
                                            {DashboardClient.Options.customTitle(dashboard)}
                                        </h4> :
                                        <>
                                            <h1 tabIndex={0} className="text-h3 font-medium">
                                                <span className="text-display-6 font-light">{entity.toString()}</span>
                                                {Navigator.isViewable({ entity: entity, canExecute: {} }) &&
                                                    // The icon is aria-hidden and there is no text, so
                                                    // this link had no accessible name at all and was
                                                    // announced as a bare "link".
                                                    <Link className="text-display-6 font-light ms-2" to={Navigator.navigateRoute(entity)}
                                                        aria-label={EntityControlMessage.Navigate.niceToString()}>
                                                        <FontAwesomeIcon aria-hidden={true} icon="up-right-from-square" />
                                                    </Link>
                                                }
                                            </h1>
                                            <h2 className="text-display-7 font-light">{DashboardClient.Options.customTitle(dashboard)}</h2>
                                        </>
                                }
                            </div> :
                            // customTitle answers undefined for a dashboard with hideDisplayName, which
                            // left an EMPTY <h1> at the top of the page: an unnamed entry in the heading
                            // list, and the anchor a skip link lands on. Dropping the heading is no better
                            // — the page would then have no level-1 heading to navigate to at all — so the
                            // name it is configured to hide is kept for assistive technology only.
                            dashboard.hideDisplayName ?
                                <h1 className="sr-only">{dashboard.displayName}</h1> :
                                <h1 className="text-display-6 font-light">{DashboardClient.Options.customTitle(dashboard)}</h1>
                        }
                    </div>
                    <div className="ms-auto">
                        {(dashboardWithQueries?.cachedQueries.length ?? 0) > 0 &&
                            <span className="mx-6" title={DashboardMessage.ForPerformanceReasonsThisDashboardMayShowOutdatedInformation.niceToString()
                                + "\n" + DashboardMessage.LasUpdateWasOn0.niceToString(
                                    dashboardWithQueries!.cachedQueries[0].creationDate.toLocaleString())}>
                                <FontAwesomeIcon aria-hidden={true} icon="clock-rotate-left" />
                                {" "}{toRelativeTime(dashboardWithQueries!.cachedQueries[0].creationDate)}
                            </span>}
                        {(dashboard.parts ?? []).some(a => a.interactionGroup != null) && <HelpIcon />}
                        {!Navigator.isReadOnly(DashboardEntity) &&
                            <Link className="sf-hide" style={{ textDecoration: "none" }} to={Navigator.navigateRoute(dashboard)} title={DashboardMessage.Edit.niceToString()}>
                                <FontAwesomeIcon aria-hidden={true} icon="pen-to-square" />
                            </Link>
                        }
                        {DashboardClient.onDashboardPageActions().map((fn, i) => <React.Fragment key={i}>{fn(dashboard)}</React.Fragment>)}
                    </div>
                </div>}

            {dashboard && (!entityKey || entity) &&
                <DashboardView dashboard={dashboard} cachedQueries={cachedQueries} entity={entity || undefined} deps={[refreshCounter, entity]}
                    reload={reloadDashboard} hideEditButton={true} />}
        </div>
    );
}

export function HelpIcon(): React.JSX.Element {
    return (
        <Popover>
            <PopoverTrigger asChild nativeButton={false} openOnHover delay={0}>
                <LinkButton className="mx-2" title={undefined}>
                    <FontAwesomeIcon icon="gamepad" className="me-1" />{DashboardMessage.InteractiveDashboard.niceToString()}
                </LinkButton>
            </PopoverTrigger>
            <PopoverContent id="popover-basic" side="bottom" align="start" autoFocus={false} className="max-w-none"
                title={DashboardMessage.InteractiveDashboard.niceToString()}>
                <ul className="ps-4">
                    <li style={{ whiteSpace: "nowrap" }}>{DashboardMessage.CLickInOneChartToFilterInTheOthers.niceToString()}</li>
                    <li style={{ whiteSpace: "nowrap" }}>{DashboardMessage.CtrlClickToFilterByMultipleElements.niceToString()}</li>
                    <li style={{ whiteSpace: "nowrap" }}>{DashboardMessage.AltClickToOpenResultsInAModalWindow.niceToString()}</li>
                </ul>
            </PopoverContent>
        </Popover>
    );
}
