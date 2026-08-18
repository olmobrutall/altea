import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { Lite } from "@altea/altea/data/lite";
import { useAPIWithReload, useInterval } from "@altea/altea/client/Hooks";
import { toAbsoluteUrl, useTitle } from "@altea/altea/client/AppContext";
import { AccessibleTable } from "@altea/altea/client/Basics/AccessibleTable";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import { Operations } from "@altea/altea/client/Operations";
import { ScheduledTaskEntity, ScheduledTaskLogEntity, ScheduledTaskLogOperation, ScheduledTaskMessage } from "../data/Scheduler";
import type { SchedulerItemState, SchedulerRunningTaskState } from "../data/SchedulerState";
import { SchedulerClient } from "./SchedulerClient";

// Port of Signum.Scheduler's SchedulerPanelPage.tsx — start/stop, what the in-memory queue holds, what is
// running right now, and the two searches.
//
// altea divergences: no CopyHealthCheckButton (not ported) — the health endpoint is a plain link, as in
// Signum; the "available tasks" section (one SearchValueLine per implementation of ScheduledTask.task) is
// dropped, since the task implementations are an app-level @implementedBy override and the ScheduledTask
// search below already shows what is scheduled.

export default function SchedulerPanelPage(): React.JSX.Element {

    const [state, reloadState] = useAPIWithReload(() => SchedulerClient.API.view(), [], { avoidReset: true });

    // Poll twice a second while running, and let the spinning icon show it is live (Signum's rotation).
    const tick = useInterval(state == null || state.running ? 500 : null, 0, n => n + 1);
    const [rotation, setRotation] = React.useState(0);

    React.useEffect(() => {
        reloadState();
        setRotation(prev => prev + 45);
    }, [tick]);

    useTitle("Scheduler Task Runner");

    if (state == null)
        return <h1 className="display-6 h2">{ScheduledTaskMessage.SchedulePanel.niceToString()} (…)</h1>;

    const s = state;

    return (
        <div>
            <h1 className="display-6 h2">
                <FontAwesomeIcon aria-hidden={true} icon="clock" className="me-2" />
                {ScheduledTaskMessage.SchedulePanel.niceToString()}
                <FontAwesomeIcon aria-hidden={true} icon="sync" className="ms-2"
                    style={{ transform: `rotate(${rotation}deg)`, transition: "transform 0.5s ease-in-out", opacity: 0.5 }} />
            </h1>

            <div className="btn-toolbar">
                <button type="button" className={classes("sf-button btn", s.running ? "btn-success disabled" : "btn-outline-success")}
                    onClick={s.running ? undefined : () => void SchedulerClient.API.start().then(() => reloadState())}>
                    <FontAwesomeIcon aria-hidden={true} icon="play" className="me-1" />{ScheduledTaskMessage.Start.niceToString()}
                </button>
                <button type="button" className={classes("sf-button btn", !s.running ? "btn-danger disabled" : "btn-outline-danger")}
                    onClick={!s.running ? undefined : () => void SchedulerClient.API.stop().then(() => reloadState())}>
                    <FontAwesomeIcon aria-hidden={true} icon="stop" className="me-1" />{ScheduledTaskMessage.Stop.niceToString()}
                </button>
            </div>

            <div className="mt-3">
                {ScheduledTaskMessage.State.niceToString()}: <strong>
                    {s.running
                        ? <span style={{ color: "green" }}>{ScheduledTaskMessage.Running.niceToString()}</span>
                        : <span style={{ color: s.initialDelayMilliseconds == null ? "gray" : "red" }}>{ScheduledTaskMessage.Stopped.niceToString()}</span>}
                </strong>
                <a className="ms-2" href={toAbsoluteUrl("/api/scheduler/healthCheck")} target="_blank" rel="noreferrer">
                    {ScheduledTaskMessage.SimpleStatus.niceToString()}
                </a>
                <br />
                {ScheduledTaskMessage.InitialDelayMilliseconds.niceToString()}: {s.initialDelayMilliseconds}
                <br />
                {ScheduledTaskMessage.SchedulerMargin.niceToString()}: {s.schedulerMarginMilliseconds} ms
                <br />
                {ScheduledTaskMessage.MachineName.niceToString()}: {s.machineName}
                <br />
                {ScheduledTaskMessage.ApplicationName.niceToString()}: {s.applicationName}
                <br />
                {ScheduledTaskMessage.ServerTimeZone.niceToString()}: {s.serverTimeZone}
                <br />
                {ScheduledTaskMessage.ServerLocalTime.niceToString()}: {s.serverLocalTime}
                <br />
                {ScheduledTaskMessage.NextExecution.niceToString()}: {s.nextExecution ?? ScheduledTaskMessage.None.niceToString()}
            </div>

            <InMemoryQueue queue={s.queue} onReload={reloadState} />
            <RunningTasks runningTasks={s.runningTask} onReload={reloadState} />

            <h2 className="h4 mt-4">{ScheduledTaskEntity.niceName()}</h2>
            <SearchControl findOptions={{ queryName: ScheduledTaskEntity, pagination: { elementsPerPage: 10, mode: "Firsts" } }} />

            <h2 className="h4 mt-4">{ScheduledTaskLogEntity.niceName()}</h2>
            <SearchControl findOptions={{
                queryName: ScheduledTaskLogEntity,
                orderOptions: [{ token: ScheduledTaskLogEntity.token(l => l.startTime), orderType: "Descending" }],
                pagination: { elementsPerPage: 10, mode: "Firsts" },
            }} />
        </div>
    );
}

function InMemoryQueue(p: { queue: SchedulerItemState[]; onReload: () => void }): React.JSX.Element {
    return (
        <div className="mt-4">
            <h2 className="h4">{ScheduledTaskMessage.InMemoryQueue.niceToString()}</h2>
            {p.queue.length === 0
                ? <p> -- {ScheduledTaskMessage.ThereIsNoActiveScheduledTask.niceToString()} -- </p>
                : <AccessibleTable aria-label={ScheduledTaskMessage.InMemoryQueue.niceToString()}
                    className="sf-search-results sf-stats-table">
                    <thead>
                        <tr>
                            <th>{ScheduledTaskMessage.ScheduledTask.niceToString()}</th>
                            <th>{ScheduledTaskMessage.Rule.niceToString()}</th>
                            <th>{ScheduledTaskMessage.NextDate.niceToString()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {p.queue.map((item, i) =>
                            <tr key={i}>
                                <td><EntityLink lite={item.scheduledTask} inSearch="main" onNavigated={p.onReload} /></td>
                                <td>{item.rule}</td>
                                <td>{item.nextDate}</td>
                            </tr>)}
                    </tbody>
                </AccessibleTable>}
        </div>
    );
}

function RunningTasks(p: { runningTasks: SchedulerRunningTaskState[]; onReload: () => void }): React.JSX.Element {

    function handleCancel(e: React.MouseEvent<unknown>, taskLog: Lite<ScheduledTaskLogEntity>): void {
        e.preventDefault();
        void Operations.API.executeLite(taskLog, ScheduledTaskLogOperation.CancelRunningTask).then(() => p.onReload());
    }

    return (
        <div className="mt-4">
            <h2 className="h4">{ScheduledTaskMessage.RunningTasks.niceToString()}</h2>
            {p.runningTasks.length === 0
                ? <p> -- {ScheduledTaskMessage.ThereAreNoTasksRunning.niceToString()} -- </p>
                : <AccessibleTable aria-label={ScheduledTaskMessage.RunningTasks.niceToString()}
                    className="sf-search-results sf-stats-table">
                    <thead>
                        <tr>
                            <th>{ScheduledTaskMessage.SchedulerTaskLog.niceToString()}</th>
                            <th>{ScheduledTaskMessage.StartTime.niceToString()}</th>
                            <th>{ScheduledTaskMessage.Remarks.niceToString()}</th>
                            <th>{ScheduledTaskMessage.Cancel.niceToString()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {p.runningTasks.map((item, i) =>
                            <tr key={i}>
                                <td><EntityLink lite={item.schedulerTaskLog} inSearch="main" onNavigated={p.onReload} /></td>
                                <td>{item.startTime}</td>
                                <td><pre className="mb-0">{item.remarks}</pre></td>
                                <td>
                                    <button type="button" className="btn btn-xs btn-danger"
                                        onClick={e => handleCancel(e, item.schedulerTaskLog)}>
                                        {ScheduledTaskMessage.Cancel.niceToString()}
                                    </button>
                                </td>
                            </tr>)}
                    </tbody>
                </AccessibleTable>}
        </div>
    );
}
