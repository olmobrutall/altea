import "@altea/altea/data/globals/stringExtensions";
import * as React from "react";
import { Modal } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { openModal } from "@altea/altea/client/Modals";
import type { IModalProps } from "@altea/altea/client/Modals";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { FormControlReadonly } from "@altea/altea/client/Lines/FormControlReadonly";
import { StyleContext } from "@altea/altea/client/TypeContext";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import { ModalHeaderButtons } from "@altea/altea/client/Components/ModalHeaderButtons";
import { toAbsoluteUrl } from "@altea/altea/client/AppContext";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { ColumnOption } from "@altea/altea/client/FindOptions";
import { WorkflowActivityMonitorMessage } from "../../data/Workflow";
import { WorkflowActivityModel, WorkflowActivityType } from "../../data/WorkflowNodes";
import { CaseActivityEntity } from "../../data/CaseActivity";
import type { WorkflowActivityStats } from "../../data/WorkflowDtos";
import { WorkflowClient } from "../WorkflowClient";
import type { WorkflowActivityMonitorConfig } from "./WorkflowActivityMonitorConfig";

// Port of Signum.Workflow's ActivityMonitor/WorkflowActivityStatsModal.tsx — one activity's numbers, plus
// either its case activities (with the monitor's own filters applied) or a link into the sub-workflow's own
// monitor. Verbatim apart from the ordinal enum comparisons.

interface WorkflowActivityStatsModalProps extends IModalProps<undefined> {
    stats: WorkflowActivityStats;
    config: WorkflowActivityMonitorConfig;
    activity: WorkflowActivityModel;
}

function WorkflowActivityStatsModal(p: WorkflowActivityStatsModalProps): React.JSX.Element {

    const [show, setShow] = React.useState<boolean>(true);
    const ctx = new StyleContext(undefined, { labelColumns: 3 });
    const { stats, config, activity } = p;

    function renderTaskExtra(): React.ReactNode {
        return (
            <div>
                <h3>{CaseActivityEntity.nicePluralName()}</h3>
                <SearchControl
                    showGroupButton={true}
                    findOptions={CaseActivityEntity.findOptions(token => ({
                        filterOptions: [
                            token(e => e.workflowActivity).filter("EqualTo", stats.workflowActivity),
                            ...Finder.toFilterOptions(config.filters.filter(f => !Finder.isAggregate(f))),
                        ],
                        columnOptionsMode: "Add",
                        columnOptions: config.columns
                            .filter(c => c.token != null && c.token.fullKey().includes("."))
                            .map(c => ({ token: c.token!.fullKey().beforeLast(".") }) as ColumnOption),
                    }))} />
            </div>
        );
    }

    function renderSubWorkflowExtra(): React.ReactNode {
        return (
            <FormGroup ctx={ctx}>
                {() => <button className="btn btn-default" onClick={e => {
                    e.preventDefault();
                    void Navigator.API.fetch(stats.workflowActivity).then(wa =>
                        window.open(toAbsoluteUrl(WorkflowClient.workflowActivityMonitorUrl(
                            (wa as unknown as WorkflowActivityModel).subWorkflow!.workflow.toLite()))));
                }}>
                    <FontAwesomeIcon icon="gauge" color="green" />{" "}
                    {WorkflowActivityMonitorMessage.WorkflowActivityMonitor.niceToString()}
                </button>}
            </FormGroup>
        );
    }

    return (
        <Modal size="lg" onHide={() => setShow(false)} show={show} onExited={() => p.onExited!(undefined)}>
            <ModalHeaderButtons onClose={() => setShow(false)}>
                {stats.workflowActivity.toString()}
            </ModalHeaderButtons>
            <div className="modal-body">
                <div>
                    <FormGroup ctx={ctx} label={CaseActivityEntity.nicePluralName()}>
                        {inputId => <FormControlReadonly id={inputId} ctx={ctx}>{stats.caseActivityCount}</FormControlReadonly>}
                    </FormGroup>
                    {config.columns.map((col, i) =>
                        <FormGroup key={i} ctx={ctx} label={col.displayName ?? col.token?.niceName()}>
                            {inputId => <FormControlReadonly id={inputId} ctx={ctx}>
                                {String(stats.customValues[i] ?? "")}
                            </FormControlReadonly>}
                        </FormGroup>)}
                    {activity.type === WorkflowActivityType.CallWorkflow
                        || activity.type === WorkflowActivityType.DecompositionWorkflow
                        ? renderSubWorkflowExtra()
                        : renderTaskExtra()}
                </div>
            </div>
            <div className="modal-footer">
                <button className="btn btn-primary sf-entity-button sf-ok-button" onClick={() => setShow(false)}>
                    {JavascriptMessage.ok.niceToString()}
                </button>
            </div>
        </Modal>
    );
}

namespace WorkflowActivityStatsModal {
    export function show(stats: WorkflowActivityStats, config: WorkflowActivityMonitorConfig,
        activity: WorkflowActivityModel): Promise<unknown> {
        return openModal<unknown>(<WorkflowActivityStatsModal stats={stats} config={config} activity={activity} />);
    }
}

export default WorkflowActivityStatsModal;
