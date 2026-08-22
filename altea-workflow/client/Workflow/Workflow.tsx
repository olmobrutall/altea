import "@altea/altea/data/globals/arrayExtensions";
import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { LiteAutocompleteConfig } from "@altea/altea/client/Lines/AutoCompleteConfig";
import CollapsableCard from "@altea/altea/client/Components/CollapsableCard";
import type { BsColor } from "@altea/altea/client/Components";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { Enum } from "@altea/altea/data/enum";
import {
    WorkflowEntity, WorkflowEntity_MainEntityStrategy, WorkflowIssueType, WorkflowMainEntityStrategy,
    WorkflowMessage, WorkflowModel,
} from "../../data/Workflow";
import type { WorkflowIssue } from "../../data/WorkflowDtos";
import type { WorkflowEntitiesDictionary } from "../WorkflowEntitiesDictionary";
import { WorkflowClient } from "../WorkflowClient";
import BpmnModelerComponent from "../Bpmn/BpmnModelerComponent";

// Port of Signum.Workflow's Workflow/Workflow.tsx — the DESIGNER page: the workflow's own properties, the
// issue list the last validation produced (each clickable, focusing the offending shape), and the modeler.
//
// altea divergences: the issue type is an ORDINAL, `WorkflowModel.entities` is a plain array, and the initial
// diagram is imported with Vite's `?raw` (as in Signum). The main-entity strategies are a collection of @part
// ROWS carrying the enum (Signum: `MList<WorkflowMainEntityStrategy>`), which core's EnumCheckboxList cannot
// bind — it edits an array OF the enum — so this file has the four checkboxes over the rows.

interface WorkflowState {
    initialXmlDiagram: string;
    entities: WorkflowEntitiesDictionary;
}

/** What WorkflowClient.executeWorkflowSave reaches through the frame's entity component. */
export interface WorkflowHandle {
    workflowState: WorkflowState | undefined;
    setIssues: (value: WorkflowIssue[]) => void;
    getXml(): Promise<string>;
    getSvg(): Promise<string>;
}

interface WorkflowProps {
    ref?: React.Ref<WorkflowHandle>;
    ctx: TypeContext<WorkflowEntity>;
}

export function Workflow(p: WorkflowProps): React.JSX.Element {

    const bpmnModelerComponentRef = React.useRef<BpmnModelerComponent>(null);

    const [issues, setIssues] = React.useState<WorkflowIssue[] | undefined>(undefined);
    const [workflowState, setWorkflowState] = React.useState<WorkflowState | undefined>(undefined);

    function updateState(model: WorkflowModel): void {
        setWorkflowState({
            initialXmlDiagram: model.diagramXml,
            entities: model.entities.toObject(p2 => p2.bpmnElementId, p2 => p2.model),
        });
    }

    React.useEffect(() => {
        const w = p.ctx.value;
        if (w.isNew) {
            void import("./InitialWorkflow.xml?raw").then(xml => {
                updateState(WorkflowModel.create({ diagramXml: xml.default, entities: [] }));
                setIssues(undefined);
            });
        }
        else {
            void WorkflowClient.API.getWorkflowModel(w.toLite()).then(pair => {
                updateState(pair.model);
                setIssues(pair.issues);
            });
        }
    }, [p.ctx.value.id, p.ctx.value.ticks]);

    React.useImperativeHandle(p.ref, () => ({
        workflowState,
        setIssues: value => setIssues(value),
        getXml: () => bpmnModelerComponentRef.current!.getXml(),
        getSvg: () => bpmnModelerComponentRef.current!.getSvg(),
    }), [bpmnModelerComponentRef.current, workflowState]);

    function handleHighlightClick(issue: WorkflowIssue): void {
        if (issue.bpmnElementId != null)
            bpmnModelerComponentRef.current?.focusElement(issue.bpmnElementId);
    }

    function renderIssuesHeader(): React.ReactNode {
        const errorCount = issues?.filter(a => a.type === WorkflowIssueType.Error).length ?? 0;
        const warningCount = issues?.filter(a => a.type === WorkflowIssueType.Warning).length ?? 0;

        return (
            <div>
                <span className="display-7">{WorkflowMessage.WorkflowIssues.niceToString()}&nbsp;</span>
                {errorCount > 0 && <FontAwesomeIcon icon="circle-xmark" className="text-danger me-1" />}
                {errorCount > 0 && errorCount}
                {warningCount > 0 && <FontAwesomeIcon icon="triangle-exclamation" className="text-warning me-1" />}
                {warningCount > 0 && warningCount}
            </div>
        );
    }

    function renderIssues(): React.ReactNode {
        if (issues == null)
            return null;

        const color = (issues.length === 0 ? "success"
            : issues.some(a => a.type === WorkflowIssueType.Error) ? "danger" : "warning") as BsColor;

        return (
            <CollapsableCard
                cardStyle={{ border: color }}
                headerStyle={{ border: color, text: color }}
                header={renderIssuesHeader()}>

                <ul style={{ listStyleType: "none", marginBottom: "0px" }}>
                    {issues.length === 0
                        ? <li>
                            <FontAwesomeIcon icon="check" className="text-success me-1" />
                            {"-- No issues --"}
                        </li>
                        : issues.orderBy(a => a.type).map((issue, i) =>
                            <li key={i}>
                                {issue.type === WorkflowIssueType.Error
                                    ? <FontAwesomeIcon icon="circle-xmark" className="text-danger me-1" />
                                    : <FontAwesomeIcon icon="triangle-exclamation" className="text-warning me-1" />}

                                {issue.bpmnElementId && <span className="me-1">(in <LinkButton title={undefined}
                                    onClick={() => handleHighlightClick(issue)}>{issue.bpmnElementId}</LinkButton>)</span>}
                                {issue.message}
                            </li>)}
                </ul>
            </CollapsableCard>
        );
    }

    /** Changing the main entity type is refused while any node still binds to it. */
    function handleMainEntityTypeChange(): Promise<boolean> {
        if (bpmnModelerComponentRef.current!.existsMainEntityTypeRelatedNodes()) {
            return MessageModal.show({
                title: JavascriptMessage.error.niceToString(),
                message: WorkflowMessage
                    .ChangeWorkflowMainEntityTypeIsNotAllowedBecauseWeHaveNodesThatUseIt.niceToString(),
                buttons: "ok",
                icon: "warning",
                style: "warning",
            }).then(() => false);
        }

        return Promise.resolve(true);
    }

    const ctx = p.ctx.subCtx({ labelColumns: 3 });

    return (
        <div>
            <CollapsableCard
                header={<span className="display-7">{WorkflowMessage.WorkflowProperties.niceToString()}</span>}
                cardStyle={{ background: "info" }}
                headerStyle={{ text: "light" }}
                bodyStyle={{ background: "light" }}
                defaultOpen={ctx.value.isNew}>
                <div className="row">
                    <div className="col-sm-6">
                        <AutoLine ctx={ctx.subCtx(d => d.name)} />
                        <EntityLine ctx={ctx.subCtx(d => d.mainEntityType)}
                            autocomplete={new LiteAutocompleteConfig((signal, str) =>
                                WorkflowClient.API.findMainEntityType({ subString: str, count: 5 }, signal))}
                            find={false}
                            onRemove={handleMainEntityTypeChange} />
                        <AutoLine ctx={ctx.subCtx(d => d.expirationDate)} />
                    </div>
                    <div className="col-sm-6">
                        <MainEntityStrategyCheckboxList ctx={ctx} />
                    </div>
                </div>
            </CollapsableCard>
            {renderIssues()}
            <fieldset>
                {workflowState
                    ? <div>
                        <BpmnModelerComponent ref={bpmnModelerComponentRef}
                            workflow={ctx.value}
                            diagramXML={workflowState.initialXmlDiagram}
                            entities={workflowState.entities} />
                    </div>
                    : <h3>{JavascriptMessage.loading.niceToString()}</h3>}
            </fieldset>
        </div>
    );
}

export default Workflow;

/**
 * The checkbox list over `WorkflowEntity.mainEntityStrategies`.
 *
 * Signum uses core's `EnumCheckboxList` because its field is `MList<WorkflowMainEntityStrategy>` — an array OF
 * the enum. altea's collections are @part ROWS (`WorkflowEntity_MainEntityStrategy`, whose `@valueField` holds
 * the strategy), so the same control cannot bind it: a checkbox toggles a ROW in and out of the array.
 */
function MainEntityStrategyCheckboxList(p: { ctx: TypeContext<WorkflowEntity> }): React.JSX.Element {

    const [, forceUpdate] = React.useReducer(x => x + 1, 0);
    const rows = p.ctx.value.mainEntityStrategies;
    const readOnly = p.ctx.readOnly;

    function handleToggle(strategy: WorkflowMainEntityStrategy): void {
        const existing = rows.filter(r => r.strategy === strategy);
        if (existing.length)
            existing.forEach(r => rows.remove(r));
        else
            rows.push(WorkflowEntity_MainEntityStrategy.create({ strategy }));

        forceUpdate();
    }

    return (
        <div className="sf-checkbox-list" style={{ marginTop: "-15px" }}>
            <label className="form-label">
                {WorkflowEntity.nicePropertyName(a => a.mainEntityStrategies)}
            </label>
            <div className="sf-checkbox-elements">
                {Enum.values(WorkflowMainEntityStrategy).map(name => {
                    const value = Enum.toValue(WorkflowMainEntityStrategy, name);
                    return (
                        <label className="sf-checkbox-element" key={name}>
                            <input type="checkbox" className="form-check-input" disabled={readOnly}
                                checked={rows.some(r => r.strategy === value)}
                                onChange={() => handleToggle(value)} />
                            &nbsp;<span>{Enum.niceName(WorkflowMainEntityStrategy, value)}</span>
                        </label>
                    );
                })}
            </div>
        </div>
    );
}
