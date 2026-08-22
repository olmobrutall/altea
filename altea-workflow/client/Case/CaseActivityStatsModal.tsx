import * as React from "react";
import { Modal, Tab, Tabs } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { openModal } from "@altea/altea/client/Modals";
import type { IModalProps } from "@altea/altea/client/Modals";
import { toNumberFormat } from "@altea/altea/client/numberFormat";
import { getTypeInfo } from "@altea/altea/client/Reflection";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { StyleContext } from "@altea/altea/client/TypeContext";
import EntityLink from "@altea/altea/client/SearchControl/EntityLink";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Enum } from "@altea/altea/data/enum";
import { OperationLogEntity } from "@altea/altea/data/operationLog";
import { CaseActivityEntity, CaseActivityMessage, DoneType } from "../../data/CaseActivity";
import { CaseNotificationEntity } from "../../data/CaseNotification";
import { CaseEntity } from "../../data/Case";
import { WorkflowActivityEntity, WorkflowActivityMessage, WorkflowActivityType, WorkflowEventType } from "../../data/WorkflowNodes";
import type { CaseActivityStats } from "../../data/WorkflowDtos";

// Port of Signum.Workflow's Case/CaseActivityStatsModal.tsx — "what happened at this node?" for the case-flow
// diagram: one tab per pass through it, with its dates, durations and (per activity kind) its notifications,
// its operation log or a link into the subcase it spawned.
//
// altea divergences: the enum members are ORDINALS (`Enum.niceToString(DoneType, …)`), and luxon's relative /
// long date formatting becomes the stored instant's own string (as elsewhere in this port).

interface CaseActivityStatsModalProps extends IModalProps<undefined> {
    case: CaseEntity;
    caseActivityStats: CaseActivityStats[];
}

function CaseActivityStatsModal(p: CaseActivityStatsModalProps): React.JSX.Element {

    const [show, setShow] = React.useState<boolean>(true);
    const stats = p.caseActivityStats;

    return (
        <Modal size="lg" onHide={() => setShow(false)} show={show} onExited={() => p.onExited!(undefined)}>
            <div className="modal-header">
                <h5 className="modal-title">
                    {stats.first().workflowActivity.toString()} ({stats.length}{" "}
                    {stats.length === 1 ? CaseActivityEntity.niceName() : CaseActivityEntity.nicePluralName()})
                </h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setShow(false)} />
            </div>
            <div className="modal-body">
                {stats.length === 1
                    ? <CaseActivityStatsComponent stats={stats.first()} caseEntity={p.case} />
                    : <Tabs id="statsTabs">
                        {stats.map(a =>
                            <Tab key={String(a.caseActivity.id)} eventKey={String(a.caseActivity.id)}
                                title={a.doneDate == null
                                    ? CaseActivityMessage.Pending.niceToString()
                                    : <span>{a.doneBy?.toString()} {Enum.niceName(DoneType, a.doneType!)}{" "}
                                        <mark>({a.doneDate})</mark></span> as never}>
                                <CaseActivityStatsComponent stats={a} caseEntity={p.case} />
                            </Tab>)}
                    </Tabs>}
            </div>
            <div className="modal-footer">
                <button className="btn btn-primary sf-entity-button sf-ok-button" onClick={() => setShow(false)}>
                    {JavascriptMessage.ok.niceToString()}
                </button>
            </div>
        </Modal>
    );
}

namespace CaseActivityStatsModal {
    export function show(caseEntity: CaseEntity, caseActivityStats: CaseActivityStats[]): Promise<unknown> {
        return openModal<unknown>(<CaseActivityStatsModal case={caseEntity} caseActivityStats={caseActivityStats} />);
    }
}

export default CaseActivityStatsModal;

export function CaseActivityStatsComponent(p: { caseEntity: CaseEntity; stats: CaseActivityStats }): React.JSX.Element {

    const ctx = new StyleContext(undefined, { labelColumns: 3 });
    const stats = p.stats;

    function renderTaskExtra(): React.ReactNode {
        return (
            <div>
                <h3>{CaseNotificationEntity.nicePluralName()}</h3>
                <SearchControl findOptions={CaseNotificationEntity.findOptions(token => ({
                    filterOptions: [token(e => e.caseActivity).filter("EqualTo", stats.caseActivity)],
                }))} />
            </div>
        );
    }

    function renderScriptTaskExtra(): React.ReactNode {
        return (
            <div>
                <h3>{OperationLogEntity.nicePluralName()}</h3>
                <SearchControl findOptions={OperationLogEntity.findOptions(token => ({
                    filterOptions: [token(e => e.target).filter("EqualTo", stats.caseActivity)],
                }))} />
            </div>
        );
    }

    function renderSubWorkflowExtra(): React.ReactNode {
        return (
            <FormGroup ctx={ctx}>
                {() => <button className="btn btn-light" onClick={() => {
                    void Finder.find(CaseEntity.findOptions(token => ({
                        filterOptions: [
                            token(e => e.parentCase).filter("EqualTo", p.caseEntity, { frozen: true }),
                            token(e => e).expression<CaseActivityEntity>("DecompositionSurrogateActivity")
                                .filter("EqualTo", stats.caseActivity),
                        ],
                    })), { autoSelectIfOne: true }).then(c => c && Navigator.view(c));
                }}>
                    <FontAwesomeIcon icon="shuffle" color="green" /> {WorkflowActivityMessage.CaseFlow.niceToString()}
                </button>}
            </FormGroup>
        );
    }

    return (
        <div>
            <FormGroup ctx={ctx} label={CaseActivityEntity.niceName()}>
                {() => stats.caseActivity.toString()}
            </FormGroup>
            <FormGroup ctx={ctx} label={CaseActivityEntity.nicePropertyName(a => a.doneBy)}>
                {() => stats.doneBy && <EntityLink lite={stats.doneBy} />}
            </FormGroup>
            <FormGroup ctx={ctx} label={CaseActivityEntity.nicePropertyName(a => a.startDate)}>
                {() => stats.startDate}
            </FormGroup>
            <FormGroup ctx={ctx} label={CaseActivityEntity.nicePropertyName(a => a.doneDate)}>
                {() => stats.doneDate}
            </FormGroup>
            <FormGroup ctx={ctx} label={CaseActivityEntity.nicePropertyName(a => a.doneType)}>
                {() => stats.doneType != null && Enum.niceName(DoneType, stats.doneType)}
            </FormGroup>
            <FormGroup ctx={ctx} label={WorkflowActivityEntity.nicePropertyName(a => a.estimatedDuration)}>
                {() => formatMinutes(stats.estimatedDuration)}
            </FormGroup>
            <FormGroup ctx={ctx} label={WorkflowActivityMessage.AverageDuration.niceToString()}>
                {() => formatMinutes(stats.averageDuration)}
            </FormGroup>
            <FormGroup ctx={ctx} label={CaseActivityEntity.nicePropertyName(a => a.duration)}>
                {() => formatMinutes(stats.duration)}
            </FormGroup>
            {stats.workflowActivityType != null &&
                <FormGroup ctx={ctx} label={Enum.niceTypeName(WorkflowActivityType)}>
                    {() => Enum.niceName(WorkflowActivityType, stats.workflowActivityType!)}
                </FormGroup>}
            {stats.workflowEventType != null &&
                <FormGroup ctx={ctx} label={Enum.niceTypeName(WorkflowEventType)}>
                    {() => Enum.niceName(WorkflowEventType, stats.workflowEventType!)}
                </FormGroup>}
            {stats.workflowActivityType === WorkflowActivityType.Task
                || stats.workflowActivityType === WorkflowActivityType.Decision ? renderTaskExtra()
                : stats.workflowActivityType === WorkflowActivityType.Script ? renderScriptTaskExtra()
                    : stats.workflowActivityType === WorkflowActivityType.CallWorkflow
                        || stats.workflowActivityType === WorkflowActivityType.DecompositionWorkflow
                        ? renderSubWorkflowExtra()
                        : undefined}
        </div>
    );
}

function formatMinutes(duration: number | null): React.ReactNode {
    if (duration == null)
        return undefined;

    const unit = getTypeInfo(CaseActivityEntity).fields["duration"].unit;
    const formatNumber = toNumberFormat("0.00");

    return <span>{formatNumber.format(duration)} {unit}</span>;
}
