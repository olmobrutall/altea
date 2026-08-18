import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { useAPIWithReload, useInterval } from "@altea/altea/client/Hooks";
import { toAbsoluteUrl, useTitle } from "@altea/altea/client/AppContext";
import { AccessibleTable } from "@altea/altea/client/Basics/AccessibleTable";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import { ProcessEntity, ProcessMessage, ProcessStateEnum } from "../data/Processes";
import type { ExecutionState } from "../data/ProcessLogicState";
import { ProcessClient } from "./ProcessClient";

// Port of Signum.Processes' ProcessPanelPage.tsx — start/stop, what is executing right now with its live
// progress, and the latest processes.
//
// altea divergences: no CopyHealthCheckButton (not ported) — the health endpoint is a plain link, as in
// Signum. The runner's in-memory log is rendered when the server has it enabled.

export default function ProcessPanelPage(): React.JSX.Element {

    const [state, reloadState] = useAPIWithReload(() => ProcessClient.API.view(), [], { avoidReset: true });

    // Poll twice a second while running, so a process's progress bar actually moves.
    const tick = useInterval(state == null || state.running ? 500 : null, 0, n => n + 1);
    const [rotation, setRotation] = React.useState(0);

    React.useEffect(() => {
        reloadState();
        setRotation(prev => prev + 45);
    }, [tick]);

    useTitle("Process Runner");

    if (state == null)
        return <h1 className="display-6 h2">{ProcessMessage.ProcessLogicStateLoading.niceToString()}</h1>;

    const s = state;

    return (
        <div>
            <h1 className="display-6 h2">
                <FontAwesomeIcon aria-hidden={true} icon="gears" className="me-2" />
                {ProcessMessage.ProcessPanel.niceToString()}
                <FontAwesomeIcon aria-hidden={true} icon="sync" className="ms-2"
                    style={{ transform: `rotate(${rotation}deg)`, transition: "transform 0.5s ease-in-out", opacity: 0.5 }} />
            </h1>

            <div className="btn-toolbar">
                <button type="button" className={classes("sf-button btn", s.running ? "btn-success disabled" : "btn-outline-success")}
                    onClick={s.running ? undefined : () => void ProcessClient.API.start().then(() => reloadState())}>
                    <FontAwesomeIcon aria-hidden={true} icon="play" className="me-1" />{ProcessMessage.Start.niceToString()}
                </button>
                <button type="button" className={classes("sf-button btn", !s.running ? "btn-danger disabled" : "btn-outline-danger")}
                    onClick={!s.running ? undefined : () => void ProcessClient.API.stop().then(() => reloadState())}>
                    <FontAwesomeIcon aria-hidden={true} icon="stop" className="me-1" />{ProcessMessage.Stop.niceToString()}
                </button>
            </div>

            <div className="mt-3">
                {ProcessMessage.State.niceToString()}: <strong>
                    {s.running
                        ? <span style={{ color: "green" }}>{ProcessMessage.Running.niceToString()}</span>
                        : <span style={{ color: s.initialDelayMilliseconds == null ? "gray" : "red" }}>{ProcessMessage.Stopped.niceToString()}</span>}
                </strong>
                <a className="ms-2" href={toAbsoluteUrl("/api/processes/healthCheck")} target="_blank" rel="noreferrer">
                    {ProcessMessage.SimpleStatus.niceToString()}
                </a>
                <br />
                {ProcessMessage.InitialDelayMilliseconds.niceToString()}: {s.initialDelayMilliseconds}
                <br />
                {ProcessMessage.MaxDegreeOfParallelism.niceToString()}: {s.maxDegreeOfParallelism}
                <br />
                {ProcessMessage.JustMyProcesses.niceToString()}: {String(s.justMyProcesses)}
                <br />
                {ProcessMessage.MachineName.niceToString()}: {s.machineName}
                <br />
                {ProcessMessage.ApplicationName.niceToString()}: {s.applicationName}
                <br />
                {ProcessMessage.NextPlannedExecution.niceToString()}: {s.nextPlannedExecution ?? ProcessMessage.None.niceToString()}
            </div>

            <ExecutingProcesses executing={s.executing} total={s.maxDegreeOfParallelism}
                machineName={s.machineName} onReload={reloadState} />

            {s.log != null &&
                <div className="mt-4">
                    <h2 className="h4">Runner log</h2>
                    <pre className="small">{s.log}</pre>
                </div>}

            <h2 className="h4 mt-4">{ProcessMessage.LatestProcesses.niceToString()}</h2>
            <SearchControl findOptions={{
                queryName: ProcessEntity,
                orderOptions: [{ token: ProcessEntity.token(p => p.creationDate), orderType: "Descending" }],
                pagination: { elementsPerPage: 10, mode: "Firsts" },
            }} />
        </div>
    );
}

function ExecutingProcesses(p: {
    executing: ExecutionState[];
    total: number;
    machineName: string;
    onReload: () => void;
}): React.JSX.Element {
    return (
        <div className="mt-4">
            <h2 className="h4">
                {ProcessMessage._0ProcessesExcecutingIn1_2.niceToString(p.executing.length, p.machineName, p.total)}
            </h2>
            {p.executing.length === 0
                ? <p> -- {ProcessMessage.ExecutingProcesses.niceToString()}: 0 -- </p>
                : <AccessibleTable aria-label={ProcessMessage.ExecutingProcesses.niceToString()}
                    className="sf-search-results sf-stats-table">
                    <thead>
                        <tr>
                            <th>{ProcessMessage.Process.niceToString()}</th>
                            <th>{ProcessMessage.State.niceToString()}</th>
                            <th>{ProcessMessage.Progress.niceToString()}</th>
                            <th>{ProcessMessage.IsCancellationRequest.niceToString()}</th>
                            <th>{ProcessMessage.MachineName.niceToString()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {p.executing.map((item, i) =>
                            <tr key={i}>
                                <td><EntityLink lite={item.process} inSearch="main" onNavigated={p.onReload} /></td>
                                <td>{ProcessStateEnum[item.state]}</td>
                                <td style={{ minWidth: 140 }}><ProgressBar fraction={item.progress} /></td>
                                <td>{String(item.isCancellationRequested)}</td>
                                <td>{item.machineName}</td>
                            </tr>)}
                    </tbody>
                </AccessibleTable>}
        </div>
    );
}

function ProgressBar(p: { fraction: string | null }): React.JSX.Element {
    // The wire carries the decimal as a string so it survives unrounded; the bar only needs a percentage.
    const percent = p.fraction == null ? null : Math.round(Number(p.fraction) * 100);

    if (percent == null)
        return <span className="text-muted">—</span>;

    return (
        <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-bar" style={{ width: `${percent}%` }}>{percent}%</div>
        </div>
    );
}
