import * as React from "react";
import { Tab, Tabs } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as AppContext from "@altea/altea/client/AppContext";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import { useAPIWithReload, useInterval } from "@altea/altea/client/Hooks";
import { classes } from "@altea/altea/data/globals/helpers";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { OperationLogEntity } from "@altea/altea/data/operationLog";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { WorkflowPermission } from "../../data/Workflow";
import { WorkflowActivityEntity, WorkflowActivityType } from "../../data/WorkflowNodes";
import { CaseActivityEntity, CaseActivityOperation } from "../../data/CaseActivity";
import { WorkflowClient } from "../WorkflowClient";

// Port of Signum.Workflow's Workflow/WorkflowPanelPage.tsx — the script runner's control panel: its state,
// start / stop, what it is about to run and what it just ran.
//
// altea divergences: `luxon`'s `toRelative()` is dropped (the ISO string is shown as-is, as the altea process
// and scheduler panels do), and the health-check / SimpleStatus links go with the unported health endpoint.

export default function WorkflowPanelPage(): React.JSX.Element {
    return (
        <div>
            <h2 className="display-6"><FontAwesomeIcon icon={["fas", "shuffle"]} /> Workflow Panel</h2>

            <Tabs id="workflowTabs">
                <Tab title="Script Runner" eventKey="scriptRunner">
                    <WorkflowScriptRunnerTab />
                </Tab>
                <Tab title="Timers" eventKey="timers">
                    <LinkButton title={undefined} className="sf-button btn btn-link"
                        onClick={() => { window.open(AppContext.toAbsoluteUrl("/scheduler/view")); }}>
                        Open Scheduler Panel
                    </LinkButton>
                </Tab>
            </Tabs>
        </div>
    );
}

export function WorkflowScriptRunnerTab(): React.JSX.Element {

    const [state, reloadState] = useAPIWithReload(() => {
        AuthClient.assertPermissionAuthorized(WorkflowPermission.ViewWorkflowPanel);
        return WorkflowClient.API.view();
    }, [], { avoidReset: true });

    const tick = useInterval(state == null || state.running ? 500 : null, 0, n => n + 1);

    React.useEffect(() => {
        reloadState();
    }, [tick]);

    const title = "WorkflowScriptRunner State";

    if (state == undefined)
        return <h4>{title} (loading...) </h4>;

    return (
        <div>
            <h4>{title}</h4>
            <div className="btn-toolbar mt-3">
                <button className={classes("sf-button btn", state.running ? "btn-success disabled" : "btn-outline-success")}
                    onClick={!state.running ? () => void WorkflowClient.API.start().then(() => reloadState()) : undefined}>
                    <FontAwesomeIcon icon="play" /> Start
                </button>
                <button className={classes("sf-button btn", !state.running ? "btn-danger disabled" : "btn-outline-danger")}
                    onClick={state.running ? () => void WorkflowClient.API.stop().then(() => reloadState()) : undefined}>
                    <FontAwesomeIcon icon="stop" /> Stop
                </button>
            </div>

            <div>
                State: <strong>
                    {state.running
                        ? <span style={{ color: "green" }}> RUNNING </span>
                        : <span style={{ color: state.initialDelayMilliseconds == null ? "gray" : "red" }}> STOPPED </span>}
                </strong>
                <br />
                InitialDelayMilliseconds: {state.initialDelayMilliseconds}
                <br />
                CurrentProcessIdentifier: {state.currentProcessIdentifier}
                <br />
                ScriptRunnerPeriod: {state.scriptRunnerPeriod} sec
                <br />
                NextPlannedExecution: {state.nextPlannedExecution ?? "-None-"}
                <br />
                IsCancelationRequested: {String(state.isCancelationRequested)}
                <br />
                QueuedItems: {state.queuedItems}
            </div>
            <br />
            <h4>Next activities to execute</h4>
            <SearchControl
                showContextMenu={() => "Basic"}
                view={false}
                findOptions={CaseActivityEntity.findOptions(token => ({
                    filterOptions: [
                        token(a => a.workflowActivity).cast(WorkflowActivityEntity).append(a => a.type)
                            .filter("EqualTo", WorkflowActivityType.Script),
                        token(e => e.doneDate).filter("EqualTo", null),
                    ],
                    columnOptionsMode: "ReplaceAll",
                    columnOptions: [
                        token(e => e.id),
                        token(e => e.startDate),
                        token(e => e.workflowActivity).cast(WorkflowActivityEntity).append(a => a.lane.pool.workflow),
                        token(e => e.workflowActivity),
                        token(e => e.case),
                        token(e => e.scriptExecution!.nextExecution),
                        token(e => e.scriptExecution!.retryCount),
                    ],
                    orderOptions: [
                        token(e => e.scriptExecution!.nextExecution).order("Ascending"),
                    ],
                    pagination: { elementsPerPage: 10, mode: "Firsts" },
                }))} />
            <Tabs id="workflowScriptTab">
                <Tab title="Last operation logs" eventKey="logs">
                    <SearchControl findOptions={OperationLogEntity.findOptions(token => ({
                        filterOptions: [
                            token(e => e.operation).filter("IsIn", [
                                CaseActivityOperation.ScriptExecute,
                                CaseActivityOperation.ScriptScheduleRetry,
                                CaseActivityOperation.ScriptFailureJump,
                            ]),
                        ],
                        pagination: { elementsPerPage: 10, mode: "Firsts" },
                    }))} />
                </Tab>
                <Tab title="Last executed activities" eventKey="lastActivities">
                    <SearchControl
                        showContextMenu={() => "Basic"}
                        view={false}
                        findOptions={CaseActivityEntity.findOptions(token => ({
                            filterOptions: [
                                token(e => e.workflowActivity).cast(WorkflowActivityEntity).append(a => a.type)
                                    .filter("EqualTo", WorkflowActivityType.Script),
                                token(e => e.doneDate).filter("DistinctTo", null),
                            ],
                            columnOptionsMode: "ReplaceAll",
                            columnOptions: [
                                token(a => a.id),
                                token(e => e.startDate),
                                token(a => a.workflowActivity).cast(WorkflowActivityEntity).append(a => a.lane.pool.workflow),
                                token(a => a.workflowActivity),
                                token(a => a.case),
                                token(e => e.doneDate),
                                token(e => e.doneType),
                                token(a => a.scriptExecution!.nextExecution),
                                token(a => a.scriptExecution!.retryCount),
                            ],
                            orderOptions: [
                                token(e => e.doneDate).order("Descending"),
                            ],
                            pagination: { elementsPerPage: 10, mode: "Firsts" },
                        }))} />
                </Tab>
            </Tabs>
        </div>
    );
}
