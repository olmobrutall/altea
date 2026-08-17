import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Link, useLocation, useParams } from "react-router";
import { OverlayTrigger, Popover } from "react-bootstrap";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Navigator } from "@altea/altea/client/Navigator";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import { useTitle } from "@altea/altea/client/AppContext";
import { useAPI, useAPIWithReload, useInterval } from "@altea/altea/client/Hooks";
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

    const [dashboard, reloadDashboard] = useAPIWithReload(
        () => DashboardClient.API.get(newLite(DashboardEntity, params.dashboardId) as Lite<DashboardEntity>),
        [params.dashboardId]);

    const entityKey = QueryString.parse(location.search).entity as string;

    const entity = useAPI(() => entityKey ? Navigator.API.fetch(Lite.parse(entityKey) as Lite<Entity>) : Promise.resolve(null), [entityKey]);

    const refreshCounter = useInterval(dashboard?.autoRefreshPeriod == null ? null : (dashboard.autoRefreshPeriod as number) * 1000, 0, old => old + 1);

    useTitle(entity ? entity.toString() : (dashboard?.toString() ?? ""));

    return (
        <div className="sf-dashboard-page">

            {!dashboard ? <h1 className="display-6 h2"><span>{JavascriptMessage.loading.niceToString()}</span></h1> :
                <div className="d-flex">
                    <div>
                        {entityKey ?
                            <div>
                                {!entity ? <h1 className="h3">{JavascriptMessage.loading.niceToString()}</h1> :
                                    dashboard.showTitleAsBreadcrumb ?
                                        <h4 className="sf-breadcrumb-title">
                                            <EntityLink lite={entity.toLite()} inPlaceNavigation />
                                            <FontAwesomeIcon aria-hidden={true} className="mx-2" icon="chevron-right" />
                                            {DashboardClient.Options.customTitle(dashboard)}
                                        </h4> :
                                        <>
                                            <h1 tabIndex={0} className="h3">
                                                <span className="display-6">{entity.toString()}</span>
                                                {Navigator.isViewable({ entity: entity, canExecute: {} }) &&
                                                    <Link className="display-6 ms-2" to={Navigator.navigateRoute(entity)}>
                                                        <FontAwesomeIcon aria-hidden={true} icon="up-right-from-square" />
                                                    </Link>
                                                }
                                            </h1>
                                            <h2 className="display-7 h4">{DashboardClient.Options.customTitle(dashboard)}</h2>
                                        </>
                                }
                            </div> :
                            <h1 className="display-6 h3">{DashboardClient.Options.customTitle(dashboard)}</h1>
                        }
                    </div>
                    <div className="ms-auto">
                        {(dashboard.parts ?? []).some(a => a.interactionGroup != null) && <HelpIcon />}
                        {!Navigator.isReadOnly(DashboardEntity) &&
                            <Link className="sf-hide" style={{ textDecoration: "none" }} to={Navigator.navigateRoute(dashboard)} title={DashboardMessage.Edit.niceToString()}>
                                <FontAwesomeIcon aria-hidden={true} icon="pen-to-square" />
                            </Link>
                        }
                        {DashboardClient.onDashboardPageActions.map((fn, i) => <React.Fragment key={i}>{fn(dashboard)}</React.Fragment>)}
                    </div>
                </div>}

            {dashboard && (!entityKey || entity) &&
                <DashboardView dashboard={dashboard} entity={entity || undefined} deps={[refreshCounter, entity]}
                    reload={reloadDashboard} hideEditButton={true} />}
        </div>
    );
}

export function HelpIcon(): React.JSX.Element {
    const popover = (
        <Popover id="popover-basic" style={{ "--bs-popover-max-width": "unset" } as React.CSSProperties}>
            <Popover.Header as="h3">{DashboardMessage.InteractiveDashboard.niceToString()}</Popover.Header>
            <Popover.Body>
                <ul className="ps-3">
                    <li style={{ whiteSpace: "nowrap" }}>{DashboardMessage.CLickInOneChartToFilterInTheOthers.niceToString()}</li>
                    <li style={{ whiteSpace: "nowrap" }}>{DashboardMessage.CtrlClickToFilterByMultipleElements.niceToString()}</li>
                    <li style={{ whiteSpace: "nowrap" }}>{DashboardMessage.AltClickToOpenResultsInAModalWindow.niceToString()}</li>
                </ul>
            </Popover.Body>
        </Popover>
    );

    return (
        <OverlayTrigger trigger={["hover", "focus"]} placement="bottom-start" overlay={popover}>
            <LinkButton className="mx-2" title={undefined}>
                <FontAwesomeIcon icon="gamepad" className="me-1" />{DashboardMessage.InteractiveDashboard.niceToString()}
            </LinkButton>
        </OverlayTrigger>
    );
}
