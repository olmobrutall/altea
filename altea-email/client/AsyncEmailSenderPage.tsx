import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { useAPIWithReload, useInterval } from "@altea/altea/client/Hooks";
import { toAbsoluteUrl, useTitle } from "@altea/altea/client/AppContext";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import { EmailMessageEntity } from "../data/EmailMessage";
import { MailingClient } from "./MailingClient";

// Port of Signum.Mailing's AsyncEmailSenderPage.tsx — start/stop the async sender, what it is doing right
// now, and the latest messages.
//
// altea divergences: no `CopyHealthCheckButton` (not ported) — the health endpoint is a plain link; the
// relative "in 2 minutes" times used luxon, which altea drops, so the ISO instants are shown as they are.

export default function AsyncEmailSenderPage(): React.JSX.Element {

    useTitle("AsyncEmailSender");

    const [state, reloadState] = useAPIWithReload(() => MailingClient.API.view(), [], { avoidReset: true });

    // Poll twice a second while it is running, so a queue draining is visible.
    const tick = useInterval(state == null || state.running ? 500 : null, 0, n => n + 1);

    React.useEffect(() => {
        reloadState();
    }, [tick]);

    if (state == null)
        return <h1 className="display-6 h2">AsyncEmailSender state (loading…)</h1>;

    const s = state;

    return (
        <div>
            <h1 className="display-6 h2">
                <FontAwesomeIcon aria-hidden={true} icon="envelopes-bulk" className="me-2" />
                AsyncEmailSender
            </h1>

            <div className="btn-toolbar mt-3">
                <button type="button" className={classes("sf-button btn", s.running ? "btn-success disabled" : "btn-outline-success")}
                    onClick={s.running ? undefined : () => void MailingClient.API.start().then(() => reloadState())}>
                    <FontAwesomeIcon aria-hidden={true} icon="play" className="me-1" />Start
                </button>
                <button type="button" className={classes("sf-button btn", !s.running ? "btn-danger disabled" : "btn-outline-danger")}
                    onClick={!s.running ? undefined : () => void MailingClient.API.stop().then(() => reloadState())}>
                    <FontAwesomeIcon aria-hidden={true} icon="stop" className="me-1" />Stop
                </button>
            </div>

            <div className="mt-3">
                State: <strong>
                    {s.running
                        ? <span style={{ color: "green" }}> RUNNING </span>
                        : <span style={{ color: s.initialDelayMilliseconds == null ? "gray" : "red" }}> STOPPED </span>}
                </strong>
                <a className="ms-2" href={toAbsoluteUrl("/api/asyncEmailSender/healthCheck")} target="_blank" rel="noreferrer">HealthCheck</a>
                <br />
                InitialDelayMilliseconds: {s.initialDelayMilliseconds}
                <br />
                MachineName: {s.machineName}
                <br />
                CurrentProcessIdentifier: {s.currentProcessIdentifier}
                <br />
                AsyncSenderPeriod: {s.asyncSenderPeriod} sec
                <br />
                NextPlannedExecution: {s.nextPlannedExecution ?? "-None-"}
                <br />
                LastExecutionFinishedOn: {s.lastExecutionFinishedOn ?? "-None-"}
                <br />
                IsCancelationRequested: {String(s.isCancelationRequested)}
                <br />
                QueuedItems: {s.queuedItems}
            </div>

            <br />
            <h2 className="h4">{EmailMessageEntity.nicePluralName()}</h2>
            <SearchControl findOptions={EmailMessageEntity.findOptions(token => ({
                orderOptions: [{ token: token(e => e.creationDate), orderType: "Descending" }],
                pagination: { mode: "Firsts", elementsPerPage: 10 },
            }))} deps={[s.lastExecutionFinishedOn]} />
        </div>
    );
}
