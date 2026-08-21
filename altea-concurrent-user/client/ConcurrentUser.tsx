import * as React from "react";
import { OverlayTrigger, Popover } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { classes } from "@altea/altea/data/globals";
import "@altea/altea/client/AppContext"; // installs String.prototype.formatHtml
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI, useForceUpdate, useVersion } from "@altea/altea/client/Hooks";
import { useWebSocketCallback, useWebSocketConnection, useWebSocketGroup } from "@altea/altea/client/useWebSocket";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { SmallProfilePhoto } from "@altea/altea-auth/client/public/ProfilePhoto";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { UserEntity } from "@altea/altea-auth/data/User";
import { ConcurrentUserMessage } from "../data/ConcurrentUser";
import { ConcurrentUserClient } from "./ConcurrentUserClient";
import "./ConcurrentUser.css";

// Port of Signum.ConcurrentUser's ConcurrentUser.tsx — the entity-frame widget: who else has this entity
// open, whether they are typing, and whether the copy on screen is already stale.
//
// altea divergences, documented inline:
//  - the three `useSignalR*` hooks → the three `useWebSocket*` hooks (altea/client/useWebSocket.tsx);
//    `HubConnectionState.Connected` → the string state `"Connected"`.
//  - `GraphExplorer.hasChangesNoClean(entity)` → `entity.isDirty()`. altea tracks modification against a
//    SNAPSHOT rather than per-field `modified` flags, so "has unsaved changes" is a method on the entity
//    and no graph walk (nor Signum's clean/no-clean distinction) exists.
//  - `luxon`'s `DateTime.fromISO(x).toRelative()` → `Intl.RelativeTimeFormat` over a Temporal difference
//    against `Clock.now` (see `toRelative` for why not the browser's own clock).
//  - `UserEntity.niceCount(n)` is not an altea API: the count is rendered with the plural nice name.
//  - `window.__disableSignalR` → `window.__disableWebSockets` (same escape hatch, renamed with the transport).
//  - the commented-out console.log / useUpdatedRef scaffolding Signum left in place is dropped.
export default function ConcurrentUser(p: { entity: Entity; isExecuting: boolean; onReload: () => void }): React.JSX.Element | null {

    const conn = useWebSocketConnection("/api/concurrentUserHub");

    const entityKey = p.entity.toLite().key();
    const currentUser = AuthClient.currentUser();
    const userKey = currentUser ? currentUser.toLite().key() : "";

    const [entityTicks, setEntityTicks] = React.useState<{ ticks: string; lite?: Lite<Entity> }>(
        () => ({ ticks: String(p.entity.ticks), lite: p.entity.isNew ? undefined : p.entity.toLite() }));
    const forceUpdate = useForceUpdate();

    React.useEffect(() => {
        setEntityTicks({ ticks: String(p.entity.ticks), lite: p.entity.isNew ? undefined : p.entity.toLite() });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entityKey]);

    useWebSocketGroup(conn, {
        enterGroup: co => co.send("EnterEntity", entityKey, userKey),
        exitGroup: co => co.send("ExitEntity", entityKey, userKey),
        deps: [entityKey],
    });

    const isModified = React.useRef(false);

    // Signum's 1s heartbeat: only a CHANGE of the modified flag is pushed, so an idle tab is silent.
    React.useEffect(() => {
        if (conn == undefined)
            return;

        function updateModified(): void {
            const modified = p.entity.isDirty();
            if (modified !== isModified.current && conn?.state === "Connected") {
                void conn.send("EntityModified", entityKey, userKey, modified);
                isModified.current = modified;
            }
        }

        updateModified();
        const handler = setInterval(updateModified, 1000);
        return () => clearInterval(handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conn, p.entity, entityTicks.ticks]);

    const [concurrentUserVersion, updateConcurrentUsers] = useVersion();

    const concurrentUsers = useAPI(() => ConcurrentUserClient.API.getUsers(entityKey),
        [concurrentUserVersion, isModified.current, entityKey]);

    useWebSocketCallback(conn, "EntitySaved", (liteK: string, newTicks: string) => {
        if (entityTicks.lite && liteK === entityTicks.lite.key())
            setEntityTicks({ lite: entityTicks.lite, ticks: newTicks });
    }, [entityTicks.lite?.key()]);

    useWebSocketCallback(conn, "ConcurrentUsersChanged", () => updateConcurrentUsers(), []);

    // Someone else saved while this tab was idle: offer a reload (and warn if it costs local edits).
    React.useEffect(() => {
        if (!p.isExecuting && entityTicks.lite && entityTicks.lite.is(p.entity) && entityTicks.ticks !== String(p.entity.ticks)) {
            void MessageModal.show({
                title: ConcurrentUserMessage.DatabaseChangesDetected.niceToString(),
                style: "warning",
                message:
                    <div>
                        <p>{ConcurrentUserMessage.LooksLikeSomeoneJustSaved0ToTheDatabase.niceToString().formatHtml(<strong>{p.entity.toString()}</strong>)}</p>
                        <p>{ConcurrentUserMessage.DoYouWantToReloadIt.niceToString()}</p>
                        {isModified.current &&
                            <>
                                <p className="text-danger">
                                    {ConcurrentUserMessage.WarningYouWillLostYourCurrentChanges.niceToString()}
                                </p>
                                <p>
                                    {ConcurrentUserMessage.ConsiderOpening0InANewTabAndApplyYourChangesManually.niceToString()
                                        .formatHtml(<a href={Navigator.navigateRoute(p.entity)} target="_blank" rel="noreferrer">{p.entity.toString()}</a>)}
                                </p>
                            </>
                        }
                    </div>,
                buttons: "yes_cancel",
            }).then(b => { if (b === "yes") p.onReload(); });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entityTicks, p.entity.ticks, p.isExecuting]);

    if (window.__disableWebSockets)
        return <FontAwesomeIcon icon="triangle-exclamation" color="#ddd" title={window.__disableWebSockets} />;

    const otherUsers = concurrentUsers?.filter(u => u.connectionID !== conn?.connectionId);

    if (otherUsers == undefined || otherUsers.length === 0)
        return null;

    if (p.entity.isNew || entityTicks.lite == undefined || !entityTicks.lite.is(p.entity))
        return null;

    const isStale = entityTicks.ticks !== String(p.entity.ticks);

    return (
        <OverlayTrigger
            trigger="click"
            onToggle={() => forceUpdate()}
            placement="bottom-end"
            overlay={
                <Popover>
                    <Popover.Header as="h3">{ConcurrentUserMessage.ConcurrentUsers.niceToString()}</Popover.Header>
                    <Popover.Body>

                        {otherUsers.map((a, i) =>
                            <div key={i} className="d-flex align-items-center">
                                <SmallProfilePhoto user={a.user} className="me-2" /> {a.user.toString()}
                                <small className="ms-1 text-muted">({toRelative(a.startTime)})</small>
                                {a.isModified && <FontAwesomeIcon role="img" icon="pen-to-square" color="#FFAA44"
                                    title={ConcurrentUserMessage.CurrentlyEditing.niceToString()} style={{ marginLeft: "10px" }} />}
                            </div>)}

                        {isModified.current
                            ? (isStale
                                ? <div className="mt-3">
                                    <small>
                                        {ConcurrentUserMessage.YouHaveLocalChangesBut0HasAlreadyBeenSavedInTheDatabaseYouWillNotBeAbleToSaveChanges
                                            .niceToString().formatHtml(<strong>{p.entity.toString()}</strong>)}
                                        {ConcurrentUserMessage.ConsiderOpening0InANewTabAndApplyYourChangesManually
                                            .niceToString().formatHtml(<a href={Navigator.navigateRoute(p.entity)} target="_blank" rel="noreferrer">{p.entity.toString()}</a>)}
                                    </small>
                                </div>
                                : otherUsers.some(u => u.isModified)
                                    ? <div className="mt-3">
                                        <small>{ConcurrentUserMessage.LooksLikeYouAreNotTheOnlyOneCurrentlyModifiying0OnlyTheFirstOneWillBeAbleToSaveChanges
                                            .niceToString().formatHtml(<strong>{p.entity.toString()}</strong>)}</small>
                                    </div>
                                    : <div className="mt-3">
                                        <small>{ConcurrentUserMessage.YouHaveLocalChangesIn0ThatIsCurrentlyOpenByOtherUsersSoFarNoOneElseHasMadeModifications
                                            .niceToString().formatHtml(<strong>{p.entity.toString()}</strong>)}</small>
                                    </div>)
                            : isStale
                                ? <div className="mt-3">
                                    <small>
                                        {ConcurrentUserMessage.ThisIsNotTheLatestVersionOf0.niceToString().formatHtml(<strong>{p.entity.toString()}</strong>)}
                                        <button type="button" className="btn btn-primary btn-sm" onClick={p.onReload}>
                                            {ConcurrentUserMessage.ReloadIt.niceToString()}
                                        </button>
                                    </small>
                                </div>
                                : null
                        }
                    </Popover.Body>
                </Popover>
            }>
            <div className={classes("sf-pointer", isModified.current ? "blinking" : undefined)}
                title={window.__disableWebSockets ?? undefined}>
                <FontAwesomeIcon icon={otherUsers.length === 1 ? "user" : otherUsers.length === 2 ? "user-group" : "users"}
                    color={isStale ? "#E4032E" : otherUsers.some(u => u.isModified) ? "#FFAA44" : "#6BB700"} />
                <strong className="ms-1 me-3" style={{ userSelect: "none" }}>
                    {otherUsers.length} {otherUsers.length === 1 ? UserEntity.niceName() : UserEntity.nicePluralName()}
                </strong>
            </div>
        </OverlayTrigger>
    );
}

/**
 * luxon's `DateTime.fromISO(x).toRelative()` ("3 minutes ago"), over the DTO's ISO string.
 *
 * "Now" comes from `Clock.now`, NOT `Temporal.Now.plainDateTimeISO()`: `startTime` is a wall clock with no
 * zone, written server-side by `Clock.now`, whose `TimeZoneMode` defaults to UTC. Comparing it against the
 * BROWSER's local wall clock offsets every duration by the browser's UTC offset — which read as "2 hours
 * ago" for a row created seconds earlier. `Clock` is isomorphic, so reading it here keeps both sides in the
 * same frame whichever mode the app picks.
 */
function toRelative(startTime: string): string {
    const seconds = Temporal.PlainDateTime.from(startTime)
        .until(Clock.now, { largestUnit: "second" }).seconds;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

    if (Math.abs(seconds) < 60) return rtf.format(-seconds, "second");
    if (Math.abs(seconds) < 3600) return rtf.format(-Math.round(seconds / 60), "minute");
    if (Math.abs(seconds) < 86400) return rtf.format(-Math.round(seconds / 3600), "hour");
    return rtf.format(-Math.round(seconds / 86400), "day");
}
