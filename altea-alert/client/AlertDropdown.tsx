import * as React from "react";
import { Link } from "react-router";
import { Toast } from "react-bootstrap";
import { useRootClose } from "@restart/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { Operations } from "@altea/altea/client/Operations";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { useAPIWithReload, useForceUpdate, useThrottle, useUpdatedRef } from "@altea/altea/client/Hooks";
import { useWebSocketConnection, useWebSocketGroup, useWebSocketCallback } from "@altea/altea/client/useWebSocket";
import { classes } from "@altea/altea/data/globals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { SmallProfilePhoto } from "@altea/altea-auth/client/public/ProfilePhoto";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { AlertEntity, AlertMessage, AlertOperation } from "../data/Alert";
import { AlertsClient } from "./AlertsClient";
import "./AlertDropdown.css";

// Port of Signum.Alerts' AlertDropdown.tsx — the navbar bell: a badge with the unattended count, and a panel
// of stacked toasts grouped by `groupTarget`, each closable (which ATTENDS the alert).
//
// altea divergences:
//  - SignalR → altea's WebSocket hub: `useSignalRConnection/Group/Callback` become
//    `useWebSocketConnection/Group/Callback`, and `Login` carries no token argument — the socket is already
//    authenticated (see AlertsServer.server.ts).
//  - luxon's `DateTime.fromISO(x).toRelative()` becomes `Intl.RelativeTimeFormat` over a Temporal difference
//    (no luxon in altea, and Intl is culture-aware for free).
//  - Signum's `window.__disableSignalR` escape hatch has no counterpart here; the hook simply reconnects.
const MaxNumberOfAlerts = 3;
const MaxNumberOfGroups = 3;

export default function AlertDropdown(props: { keepRingingFor?: number }): React.JSX.Element | null {
    if (!Navigator.isViewable(AlertEntity))
        return null;

    return <AlertDropdownImp keepRingingFor={props.keepRingingFor ?? 10 * 1000} />;
}

interface AlertGroupWithSize {
    groupTarget?: Lite<Entity>;
    alerts: AlertWithSize[];
    totalHeight?: number;
    maxDate: string;
    removing?: boolean;
}

interface AlertWithSize {
    alert: AlertEntity;
    height?: number;
    removing?: boolean;
}

function AlertDropdownImp(props: { keepRingingFor: number }): React.JSX.Element {

    const conn = useWebSocketConnection("/api/alertshub");

    useWebSocketGroup(conn, {
        enterGroup: c => Promise.resolve(c.send("Login")),
        exitGroup: c => Promise.resolve(c.send("Logout")),
        deps: [],
    });

    useWebSocketCallback(conn, "AlertsChanged", () => {
        if (!refIgnorePush.current)
            reloadAll();
    }, []);

    const refIgnorePush = React.useRef(false);
    const forceUpdate = useForceUpdate();
    const [isOpen, setIsOpen] = React.useState(false);
    const [ringing, setRinging] = React.useState(false);
    const ringingRef = useUpdatedRef(ringing);
    const [showGroups, setShowGroups] = React.useState(MaxNumberOfGroups);

    const [alertGroups, reloadAlerts] = useAPIWithReload<AlertGroupWithSize[] | null>(async (_signal, oldGroups) => {
        if (!isOpen)
            return null;

        const newAlerts = await AlertsClient.API.myAlerts();

        // Keep the measured heights of the alerts we already showed, so a reload does not re-animate.
        const heights = new Map<string, number | undefined>();
        oldGroups?.forEach(g => g.alerts.forEach(a => heights.set(a.alert.toLite().key(), a.height)));

        return newAlerts
            .orderByDescending(a => a.alertDate.toString())
            .groupBy(a => a.groupTarget ? a.groupTarget.key() : "null")
            .map(gr => ({
                groupTarget: gr.key !== "null" ? gr.elements[0]!.groupTarget! : undefined,
                alerts: gr.elements.map<AlertWithSize>(a => ({ alert: a, height: heights.get(a.toLite().key()) })),
                maxDate: gr.elements.orderByDescending(a => a.alertDate.toString())[0]!.alertDate.toString(),
                totalHeight: gr.elements.sum(a => heights.get(a.toLite().key()) ?? 0),
            }));
    }, [isOpen], { avoidReset: true });

    const [countResult, reloadCount] = useAPIWithReload<AlertsClient.NumAlerts>((_signal, oldResult) =>
        AlertsClient.API.myAlertsCount().then(res => {
            if (res.lastAlert != null) {
                if ((oldResult?.lastAlert ?? null) == null || oldResult!.lastAlert! < res.lastAlert)
                    if (!ringingRef.current)
                        setRinging(true);
            } else if (ringingRef.current) {
                setRinging(false);
            }
            return res;
        }), [], { avoidReset: true });

    React.useEffect(() => {
        if (!ringing)
            return;
        const handler = window.setTimeout(() => setRinging(false), props.keepRingingFor);
        return () => clearTimeout(handler);
    }, [ringing, props.keepRingingFor]);

    function reloadAll(): void {
        reloadAlerts();
        reloadCount();
    }

    function isSingleAlert(toRemove: AlertWithSize | AlertGroupWithSize): toRemove is AlertWithSize {
        return (toRemove as AlertWithSize).alert != null;
    }

    /** Closing the LAST alert of a group closes the group (Signum's fixToRemove). */
    function fixToRemove(toRemove: AlertWithSize | AlertGroupWithSize): AlertWithSize | AlertGroupWithSize {
        if (isSingleAlert(toRemove) && alertGroups) {
            const group = alertGroups.find(ag => ag.alerts.some(a => a.alert.is(toRemove.alert)));
            if (group != null && group.alerts.length === 1)
                return group;
        }
        return toRemove;
    }

    function handleOnCloseAlerts(toRemoveRaw: AlertWithSize | AlertGroupWithSize): void {
        // Optimistic: fade it out, then attend it on the server.
        const toRemove = fixToRemove(toRemoveRaw);
        toRemove.removing = true;
        forceUpdate();

        window.setTimeout(() => {
            if (alertGroups) {
                if (isSingleAlert(toRemove)) {
                    const group = alertGroups.find(ag => ag.alerts.some(a => a.alert.is(toRemove.alert)));
                    if (group != null) {
                        group.alerts = group.alerts.filter(a => !a.alert.is(toRemove.alert));
                        if (group.alerts.length === 0)
                            alertGroups.splice(alertGroups.indexOf(group), 1);
                    }
                } else {
                    const index = alertGroups.indexOf(toRemove);
                    if (index >= 0)
                        alertGroups.splice(index, 1);
                }

                if (alertGroups.length === 0)
                    setIsOpen(false);
            }

            const alertsToRemove = isSingleAlert(toRemove) ? [toRemove] : toRemove.alerts;
            if (countResult)
                countResult.numAlerts -= alertsToRemove.length;

            forceUpdate();

            refIgnorePush.current = true;
            Operations.API.executeMultiple(alertsToRemove.map(a => a.alert.toLite()), AlertOperation.Attend,
                { progressModal: false })
                .then(res => {
                    const errors = Object.values(res.errors).filter(Boolean);
                    if (errors.length > 0)
                        void MessageModal.showError(
                            <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>, "Errors attending alerts");
                    reloadAll();
                })
                .finally(() => { refIgnorePush.current = false; });
        }, 400);
    }

    const divRef = React.useRef<HTMLDivElement>(null);
    useRootClose(divRef as never, () => setIsOpen(false), { disabled: !isOpen });

    const visibleGroups = (alertGroups ?? []).orderByDescending(a => a.maxDate).filter((_gr, i) => i < showGroups);
    const stackedHeight = visibleGroups.sum(a => a.removing ? 0 : a.totalHeight ?? 0);

    return (
        <>
            <button className="nav-link sf-bell-container" onClick={() => setIsOpen(!isOpen)}
                style={{ border: 0, backgroundColor: "var(--alert-bg)" }}>
                <FontAwesomeIcon aria-hidden icon="bell"
                    title={(countResult ? String(countResult.numAlerts) : AlertEntity.nicePluralName())
                        + (ringing ? " " + AlertMessage.Ringing.niceToString() : "")}
                    className={classes("sf-bell", ringing && "ringing", isOpen && "open",
                        countResult != null && countResult.numAlerts > 0 && "active")} />
                {countResult != null && countResult.numAlerts > 0 &&
                    <span className="badge text-bg-danger badge-pill sf-alerts-badge">{countResult.numAlerts}</span>}
            </button>

            {isOpen && <div className="sf-alerts-toasts mt-2" ref={divRef} style={{
                backdropFilter: "blur(10px)",
                transition: "transform .4s ease",
                height: (stackedHeight + (showGroups < (alertGroups ?? []).length ? 60 : 0) + 60) + "px",
            }}>
                {alertGroups == null
                    ? <Toast><Toast.Body>{JavascriptMessage.loading.niceToString()}</Toast.Body></Toast>
                    : <>
                        {alertGroups.length === 0 &&
                            <Toast><Toast.Body>{AlertMessage.YouDoNotHaveAnyActiveAlert.niceToString()}</Toast.Body></Toast>}

                        <div style={{ position: "relative" }}>
                            {visibleGroups.map((gr, i) =>
                                <AlertGroupToast key={gr.groupTarget?.key() ?? "null"}
                                    group={gr}
                                    onClose={handleOnCloseAlerts}
                                    onRefresh={reloadAll}
                                    onSizeSet={forceUpdate}
                                    style={{
                                        width: "100%",
                                        position: "absolute",
                                        transform: `translateY(${visibleGroups.filter((_a, j) => j < i)
                                            .sum(a => a.removing ? 0 : a.totalHeight ?? 0)}px)`
                                            + (gr.removing ? " scale(0)" : ""),
                                        transition: "transform 0.4s ease",
                                    }} />)}
                        </div>

                        {showGroups < alertGroups.filter(a => !a.removing).length &&
                            <div style={{ transform: `translateY(${stackedHeight}px)`, transition: "transform 0.4s ease" }}>
                                <Toast className="w-100 my-2">
                                    <Toast.Body style={{ textAlign: "center" }}>
                                        <button type="button" className="btn btn-link btn-sm text-muted fw-bold"
                                            onClick={() => setShowGroups(showGroups + MaxNumberOfGroups)}>
                                            {AlertMessage.Show0GroupsMore1Remaining.niceToString(MaxNumberOfGroups,
                                                alertGroups.filter(a => !a.removing).length - showGroups)}
                                        </button>
                                    </Toast.Body>
                                </Toast>
                            </div>}

                        <div style={{ transform: `translateY(${stackedHeight}px)`, transition: "transform 0.4s ease" }}>
                            <Toast className="w-100 mt-2">
                                <Toast.Body style={{ textAlign: "center" }}>
                                    <Link onClick={() => setIsOpen(false)}
                                        to={Finder.findOptionsPath(AlertEntity.findOptions(token => ({
                                            filterOptions: [
                                                token(a => a.recipient).filter("EqualTo", AuthClient.currentUser()),
                                            ],
                                            orderOptions: [
                                                token(a => a.alertDate).order("Descending"),
                                            ],
                                        })))}>
                                        {AlertMessage.AllMyAlerts.niceToString()}
                                    </Link>
                                </Toast.Body>
                            </Toast>
                        </div>
                    </>}
            </div>}
        </>
    );
}

export function AlertGroupToast(p: {
    group: AlertGroupWithSize;
    onClose: (e: AlertWithSize | AlertGroupWithSize) => void;
    onRefresh: () => void;
    onSizeSet: () => void;
    style?: React.CSSProperties;
}): React.JSX.Element {

    const [showAlerts, setShowAlerts] = React.useState(1);
    const [sizeRefresh, setSizeRefresh] = React.useState(0);

    const alerts = p.group.alerts.filter((_a, i) => i < showAlerts + MaxNumberOfAlerts);
    const groupTarget = p.group.alerts[0]?.alert.groupTarget;

    const htmlRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        p.group.totalHeight = htmlRef.current?.getBoundingClientRect().height;
        p.onSizeSet();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [p.group, sizeRefresh]);

    const lastExpandedAlert = alerts.filter((_a, i) => i < showAlerts).lastOrNull();
    const totalExpandedHeight = alerts.filter((_a, i) => i < showAlerts).sum(a => a.height ?? 0);
    const textStyle: React.CSSProperties = { color: "var(--alert-muted)", fontSize: "0.8rem", fontWeight: "bold" };

    return (
        <div className="sf-alert-group pb-2" style={p.style} ref={htmlRef}>
            <div className="p-2 d-flex" style={{ position: "relative" }}>
                <span style={textStyle}>
                    {groupTarget
                        ? `${groupTarget.toString()} (${p.group.alerts.length})`
                        : `${AlertMessage.OtherNotifications.niceToString()} (${p.group.alerts.length})`}
                </span>

                {alerts.length > 1 && <>
                    <button type="button" className="ms-auto me-2 btn btn-link btn-sm" style={textStyle}
                        onClick={() => setShowAlerts(showAlerts === 1 ? 1 + MaxNumberOfAlerts : 1)}
                        aria-expanded={showAlerts !== 1}>
                        {showAlerts === 1 ? AlertMessage.Expand.niceToString() : AlertMessage.Collapse.niceToString()}
                    </button>
                    <button type="button" className="btn btn-link btn-sm" style={{ whiteSpace: "nowrap", ...textStyle }}
                        onClick={() => p.onClose(p.group)}>
                        {AlertMessage.CloseAll.niceToString()}
                    </button>
                </>}
            </div>

            <div style={{
                perspective: "1000px",
                position: "relative",
                marginBottom: (Math.max(0, alerts.length - showAlerts) * 8) + "px",
                height: alerts.filter((_a, i) => i < showAlerts).sum(a => (a.height ?? 0) + 2),
                transition: "transform .4s ease",
            }}>
                {alerts.map((a, i) => {
                    const expanded: boolean | "comming" = i < showAlerts ? true
                        : alerts.filter((x, j) => j < i && !x.removing).length < showAlerts ? "comming"
                            : false;
                    const hiddenIndex = i - (showAlerts - 1);

                    return <AlertToast key={String(a.alert.id)} alert={a} onClose={p.onClose} expanded={expanded}
                        onSizeSet={() => setSizeRefresh(x => x + 1)} refresh={p.onRefresh} className="mb-0 mt-0"
                        style={{
                            borderRadius: ".15em",
                            boxShadow: "var(--alert-shadow)",
                            width: "100%",
                            transformOrigin: "50% 0",
                            position: "absolute",
                            zIndex: -i,
                            maxHeight: expanded ? undefined : lastExpandedAlert?.height,
                            overflow: expanded ? undefined : "hidden",
                            transform: expanded
                                ? `translateY(${alerts.filter((_x, j) => j < i)
                                    .sum(x => (x.removing ? 0 : x.height ?? 0) + 2)}px)` + (a.removing ? " scale(0)" : "")
                                : `translate3d(0, ${totalExpandedHeight - (a.height ?? 0) + hiddenIndex * 8}px, ${-hiddenIndex * 32}px)`,
                            opacity: expanded ? undefined : Math.max(0, 1 - hiddenIndex * 0.2),
                            transition: "transform .4s ease",
                        }} />;
                })}
            </div>

            {showAlerts < p.group.alerts.filter(a => !a.removing).length && showAlerts > 1 &&
                <div style={{ position: "relative", textAlign: "center", marginTop: "-10px" }}>
                    <button type="button" className="btn btn-link btn-sm text-decoration-underline"
                        onClick={() => setShowAlerts(showAlerts + MaxNumberOfAlerts)}>
                        {AlertMessage.Show0AlertsMore.niceToString(MaxNumberOfAlerts)}
                    </button>
                </div>}
        </div>
    );
}

export function AlertToast(p: {
    alert: AlertWithSize;
    onSizeSet: () => void;
    expanded: boolean | "comming";
    onClose: (e: AlertWithSize) => void;
    refresh: () => void;
    className?: string;
    style?: React.CSSProperties;
}): React.JSX.Element {

    const alert = p.alert.alert;
    const icon = alert.alertType?.key != null ? AlertToast.icons[alert.alertType.key] : undefined;
    const wasExpanded = useThrottle(p.expanded, 0.4 * 1000);
    const htmlRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        p.alert.height = htmlRef.current?.getBoundingClientRect().height;
        p.onSizeSet();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [p.alert, p.expanded, wasExpanded]);

    return (
        <Toast ref={htmlRef} onClose={() => p.onClose(p.alert)} className={classes(p.className, "w-100")} style={p.style}>
            <Toast.Header>
                {icon && <span className="me-2">{icon}</span>}
                <strong className="me-auto">{AlertsClient.getTitle(alert.titleField, alert.alertType)}</strong>
                <small>{toRelative(alert.alertDate)}</small>
            </Toast.Header>
            <Toast.Body style={{
                whiteSpace: "pre-wrap",
                opacity: p.expanded ? undefined : 0,
                transition: "transform .4s ease",
                color: "var(--alert-text)",
            }}>
                <div className="row">
                    <div className="col-sm-1">
                        {alert.createdBy && <SmallProfilePhoto user={alert.createdBy as Lite<UserEntity>} />}
                    </div>
                    <div className="col-sm-11" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                        {AlertsClient.format(alert.textField || alert.textFromAlertType || "", alert, p.refresh)}
                    </div>
                </div>
            </Toast.Body>
        </Toast>
    );
}

export namespace AlertToast {
    /** Signum's `AlertToast.icons` — an app maps an alert-type KEY to the icon its toast shows. */
    export const icons: { [alertTypeKey: string]: React.ReactNode } = {};
}

/** luxon's `DateTime.toRelative()`, over Temporal + Intl (see the header). */
function toRelative(date: Temporal.PlainDateTime | null | undefined): string {
    if (date == null)
        return "";

    // `Clock.now`, not `Temporal.Now`: a stored PlainDateTime is in the CLOCK's frame (UTC by default,
    // Signum's TimeZoneMode), and Clock lives in the isomorphic data layer so both tiers read the same mode.
    const minutes = Math.round(date.since(Clock.now).total({ unit: "minutes" }));
    const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

    const abs = Math.abs(minutes);
    if (abs < 60) return format.format(minutes, "minute");
    if (abs < 60 * 24) return format.format(Math.round(minutes / 60), "hour");
    if (abs < 60 * 24 * 30) return format.format(Math.round(minutes / (60 * 24)), "day");
    if (abs < 60 * 24 * 365) return format.format(Math.round(minutes / (60 * 24 * 30)), "month");
    return format.format(Math.round(minutes / (60 * 24 * 365)), "year");
}
