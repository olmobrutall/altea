import * as React from "react";
import { Tab, Tabs, Tooltip, OverlayTrigger } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals/helpers";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { Navigator } from "@altea/altea/client/Navigator";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import type { ResultRow } from "@altea/altea/data/dynamicQuery/queryRequest";
import { useAPI } from "@altea/altea/client/Hooks";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { WorkflowEntity, WorkflowPermission, type IWorkflowNodeEntity } from "../../data/Workflow";
import { WorkflowActivityMessage } from "../../data/WorkflowNodes";
import type { CaseEntity } from "../../data/Case";
import { CaseActivityEntity } from "../../data/CaseActivity";
import { WorkflowClient } from "../WorkflowClient";
import CaseFlowViewerComponent from "../Bpmn/CaseFlowViewerComponent";
import InlineCaseTags from "./InlineCaseTags";
import type { WorkflowEntitiesDictionary } from "../WorkflowEntitiesDictionary";

// Port of Signum.Workflow's Case/Case.tsx — the CaseEntity view: the header lines, the case-flow diagram and
// the case-activity list, whose two extra search-control buttons drive the diagram (show one activity's stats,
// or locate its node).
//
// altea divergences: the entities dictionary is built from a plain array (no MList wrapper), and the gate is
// AuthClient.isPermissionAuthorized (altea's core client has no permission channel — see altea-auth).

type CaseTab = "CaseFlow" | "CaseActivities" | "InprogressCaseActivities";

interface CaseComponentProps {
    ctx: TypeContext<CaseEntity>;
    workflowActivity?: IWorkflowNodeEntity;
}

export default function CaseComponent(p: CaseComponentProps): React.JSX.Element {

    const [activeEventKey, setActiveEventKey] = React.useState<CaseTab>("CaseFlow");

    const caseFlowViewerComponentRef = React.useRef<CaseFlowViewerComponent>(null);

    const canViewCaseFlow = AuthClient.isPermissionAuthorized(WorkflowPermission.ViewCaseFlow);

    const model = useAPI(() =>
        !canViewCaseFlow ? Promise.resolve(undefined) :
            WorkflowClient.API.getWorkflowModel(p.ctx.value.workflow.toLite()).then(pair => ({
                initialXmlDiagram: pair.model.diagramXml,
                entities: pair.model.entities.reduce<WorkflowEntitiesDictionary>((acc, e) => {
                    acc[e.bpmnElementId] = e.model!;
                    return acc;
                }, {}),
            })), [p.ctx.value.workflow]);

    const caseFlow = useAPI(() => !canViewCaseFlow
        ? Promise.resolve(undefined)
        : WorkflowClient.API.caseFlow(p.ctx.value.toLite()), [p.ctx.value]);

    function handleToggle(eventKey: unknown): void {
        if (activeEventKey !== eventKey)
            setActiveEventKey(eventKey as CaseTab);
    }

    function handleOnDiagramNodeLocated(): void {
        setActiveEventKey("CaseFlow");
    }

    const ctx = p.ctx.subCtx({ readOnly: true, labelColumns: 4 });
    return (
        <div>
            <div className="inline-tags"> <InlineCaseTags case={p.ctx.value.toLite()} /></div>
            <br />
            <div className="row">
                <div className="col-sm-6">
                    <EntityLine ctx={ctx.subCtx(a => a.workflow)} view={!Navigator.isReadOnly(WorkflowEntity)} />
                    <EntityLine ctx={ctx.subCtx(a => a.parentCase)} />
                    <AutoLine ctx={ctx.subCtx(a => a.startDate)} />
                </div>
                <div className="col-sm-6">
                    <EntityLine ctx={ctx.subCtx(a => a.mainEntity)} view={false} />
                    <AutoLine ctx={ctx.subCtx(a => a.description)} />
                    <AutoLine ctx={ctx.subCtx(a => a.finishDate)} />
                </div>
            </div>

            {canViewCaseFlow &&
                <Tabs id="caseTabs" unmountOnExit={false} activeKey={activeEventKey} onSelect={handleToggle}>
                    <Tab eventKey={"CaseFlow" as CaseTab} title={WorkflowActivityMessage.CaseFlow.niceToString()}>
                        {model && caseFlow
                            ? <div>
                                <CaseFlowViewerComponent ref={caseFlowViewerComponentRef}
                                    diagramXML={model.initialXmlDiagram}
                                    entities={model.entities}
                                    caseFlow={caseFlow}
                                    case={ctx.value}
                                    workflowActivity={p.workflowActivity}
                                /></div>
                            : <h3>{JavascriptMessage.loading.niceToString()}</h3>}
                    </Tab>
                    <Tab eventKey={"CaseActivities" as CaseTab} title={CaseActivityEntity.nicePluralName()}>
                        <SearchControl
                            view={false}
                            findOptions={CaseActivityEntity.findOptions(token => ({
                                filterOptions: [
                                    token(e => e.case).filter("EqualTo", ctx.value),
                                    token(e => e.doneDate).filter("EqualTo", null, {
                                        pinned: {
                                            active: "Checkbox_Unchecked",
                                            label: WorkflowActivityMessage.InprogressCaseActivities.niceToString(),
                                            column: 2,
                                        },
                                    }),
                                ],
                                columnOptionsMode: "ReplaceAll",
                                columnOptions: [
                                    token(e => e.id),
                                    token(e => e.workflowActivity),
                                    token(e => e.startDate),
                                    token(e => e.doneDate),
                                    token(e => e.doneBy),
                                    token(a => a.previous),
                                ],
                                orderOptions: [
                                    token(e => e.startDate).order("Ascending"),
                                ],
                            }))}
                            extraButtons={(sc: SearchControlLoaded) => [
                                {
                                    order: -1.1, button: <CaseActivityStatsButtonComponent sc={sc}
                                        caseFlowViewer={caseFlowViewerComponentRef.current!} />,
                                },
                                {
                                    order: -1.2, button: <WorkflowActivityLocateButtonComponent sc={sc}
                                        caseFlowViewer={caseFlowViewerComponentRef.current!}
                                        onLocated={handleOnDiagramNodeLocated} />,
                                },
                            ]}
                        />
                    </Tab>
                </Tabs>}
        </div>
    );
}

interface CaseActivityButtonBaseProps {
    sc: SearchControlLoaded;
    caseFlowViewer: CaseFlowViewerComponent;
}

function CaseActivityStatsButtonComponent(p: CaseActivityButtonBaseProps): React.JSX.Element {

    function handleOnClick(rr: ResultRow): void {
        if (rr.entity)
            void Navigator.API.fetch(rr.entity).then(caseActivity => {
                const bpmnElementId = (caseActivity as CaseActivityEntity).workflowActivity.bpmnElementId;
                p.caseFlowViewer.showCaseActivityStatsModal(bpmnElementId);
            });
    }
    const sc = p.sc;

    const enabled = sc.state.selectedRows && sc.state.selectedRows.length === 1;

    return (
        <OverlayTrigger overlay={<Tooltip placement="top" key="tooltip" id="caseStatsTooltip">
            {WorkflowActivityMessage.OpenCaseActivityStats.niceToString()}
        </Tooltip>}>
            <div>
                <a className={classes("sf-line-button btn btn-light", enabled ? undefined : "disabled")}
                    onClick={() => handleOnClick(sc.state.selectedRows![0])}>
                    <FontAwesomeIcon icon="list" />
                </a>
            </div>
        </OverlayTrigger>
    );
}

interface WorkflowActivityLocateButtonComponentProps extends CaseActivityButtonBaseProps {
    onLocated?: () => void;
}

function WorkflowActivityLocateButtonComponent(
    p: WorkflowActivityLocateButtonComponentProps): React.JSX.Element {

    function handleOnClick(rr: ResultRow): void {
        if (rr.entity) {
            void Navigator.API.fetch(rr.entity).then(caseActivity => {
                const bpmnElementId = (caseActivity as CaseActivityEntity).workflowActivity.bpmnElementId;
                p.caseFlowViewer.focusElement(bpmnElementId);

                if (p.onLocated)
                    p.onLocated();
            });
        }
    }
    const sc = p.sc;

    const enabled = sc.state.selectedRows && sc.state.selectedRows.length === 1;
    return (
        <OverlayTrigger overlay={<Tooltip placement="top" id="activityLocatorPopupt">
            {WorkflowActivityMessage.LocateWorkflowActivityInDiagram.niceToString()}
        </Tooltip>}>
            <div>
                <a className={classes("sf-line-button btn btn-light", enabled ? undefined : "disabled")}
                    onClick={() => handleOnClick(sc.state.selectedRows![0])}>
                    <FontAwesomeIcon icon="location-pin" />
                </a>
            </div>
        </OverlayTrigger>
    );
}
