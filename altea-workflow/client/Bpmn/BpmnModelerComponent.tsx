import "@altea/altea/data/globals/stringExtensions";
import "@altea/altea/data/globals/arrayExtensions";
import * as React from "react";
import Modeler from "bpmn-js/lib/Modeler";
import { Button } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import { Lite } from "@altea/altea/data/lite";
import { ModelEntity } from "@altea/altea/data/entity";
import { WorkflowEntity, WorkflowMessage } from "../../data/Workflow";
import {
    ButtonOptionEmbedded, ConnectionType, TimeSpanEmbedded, WorkflowActivityModel, WorkflowActivityType,
    WorkflowConnectionModel, WorkflowEventModel, WorkflowEventType, WorkflowLaneModel, WorkflowPoolModel,
    WorkflowTimerEmbedded,
} from "../../data/WorkflowNodes";
import { TriggeredOn } from "../../data/WorkflowEventTask";
import type { WorkflowEntitiesDictionary } from "../WorkflowEntitiesDictionary";
import * as connectionIcons from "./ConnectionIcons";
import * as customRenderer from "./CustomRenderer";
import * as customPopupMenu from "./CustomPopupMenu";
import * as customContextPad from "./CustomContextPad";
import * as customMinimap from "./CustomMinimap";
import * as BpmnUtils from "./BpmnUtils";
import "diagram-js-minimap/assets/diagram-js-minimap.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css";
import "diagram-js/assets/diagram-js.css";
import "./Bpmn.css";

// Port of Signum.Workflow's Bpmn/BpmnModelerComponent.tsx — the DESIGNER: a bpmn-js Modeler wired to the
// workflow's model dictionary. Double-clicking a shape opens its altea MODEL in a dialog; the answer is
// written back into the dictionary AND reflected in the diagram (a Decision activity becomes a `userTask`, a
// scheduled start grows a conditional event definition, …). Everything is kept in the dictionary until the
// workflow is saved, which posts the whole diagram + dictionary in one WorkflowModel.
//
// altea divergences:
//  - `componentWillReceiveProps` (removed from React) → `componentDidUpdate`.
//  - the enum comparisons are ORDINALS (`WorkflowActivityType.Decision`), not Signum's strings.
//  - the boundary-timer list on the activity MODEL is a plain array, not an MList, so `newMListElement` and
//    `.element` are gone.
//  - `parseLite(key)` → `Lite.parse(key)`.

export interface BpmnModelerComponentProps {
    workflow: WorkflowEntity;
    diagramXML: string;
    entities: WorkflowEntitiesDictionary;
}

class CustomModeler extends Modeler {
}

CustomModeler.prototype._modules =
    CustomModeler.prototype._modules.concat([customRenderer, customPopupMenu, customContextPad, customMinimap]);

export default class BpmnModelerComponent extends React.Component<BpmnModelerComponentProps> {
    private modeler!: Modeler;
    private elementRegistry!: BPMN.ElementRegistry;
    private bpmnFactory!: BPMN.BpmnFactory;
    private bpmnReplace!: BPMN.BpmnReplace;
    private divArea!: HTMLDivElement;

    override componentDidMount(): void {
        this.modeler = new CustomModeler({
            container: this.divArea,
            height: 1000,
            keyboard: { bindTo: document },
            additionalModules: [connectionIcons],
        });
        this.configureModules();
        this.elementRegistry = this.modeler.get<BPMN.ElementRegistry>("elementRegistry");
        this.bpmnFactory = this.modeler.get<BPMN.BpmnFactory>("bpmnFactory");
        this.bpmnReplace = this.modeler.get<BPMN.BpmnReplace>("bpmnReplace");
        this.modeler.on("element.dblclick", 1500, this.handleElementDoubleClick as (obj: BPMN.Event) => void);
        this.modeler.on("element.paste", 1500, this.handleElementPaste as (obj: BPMN.Event) => void);
        this.modeler.on("element.changed", 1500, this.handleElementChanged as (obj: BPMN.Event) => void);
        this.modeler.on("create.ended", 1500, this.handleCreateEnded as (obj: BPMN.Event) => void);
        this.modeler.on("autoPlace.end", 1500, this.handleCreateEnded as (obj: BPMN.Event) => void);
        this.modeler.on("shape.add", 1500, this.handleAddShapeOrConnection as (obj: BPMN.Event) => void);
        this.modeler.on("commandStack.elements.delete.postExecuted", 1500,
            this.handleElementDeletePostExecuted as (obj: BPMN.Event) => void);
        this.modeler.on("connection.add", 1500, this.handleAddShapeOrConnection as (obj: BPMN.Event) => void);
        this.modeler.on("label.add", 1500, () => { this.lastPasted = undefined; });
        this.modeler.importXML(this.props.diagramXML, this.handleOnModelError);
    }

    focusElement(bpmnElementId: string): void {
        const searchPad = this.modeler.get<any>("searchPad");
        searchPad._search(bpmnElementId);
        searchPad._resetOverlay();
    }

    /** Would changing the workflow's main entity type break something? (a lane actors evaluator, a start
     *  event's task, a connection's action / condition, or a script activity all bind to that type). */
    existsMainEntityTypeRelatedNodes(): boolean {
        const entities = this.props.entities;
        let result = false;
        this.elementRegistry.forEach(e => {
            const model = entities[e.id];
            if (model == null)
                return;

            if (e.type === "bpmn:Lane" && (model as WorkflowLaneModel).actorsEvaluator != null)
                result = true;

            if (e.type === "bpmn:StartEvent") {
                const task = (model as WorkflowEventModel).task;
                if (task != null && (task.action != null || task.condition != null))
                    result = true;
            }

            if ((BpmnUtils.isConnection(e.type) && (model as WorkflowConnectionModel).action != null)
                || ((e.type === "bpmn:ExclusiveGateway" || e.type === "bpmn:InclusiveGateway")
                    && (model as WorkflowConnectionModel).condition != null))
                result = true;

            if (BpmnUtils.isTaskAnyKind(e.type) && (model as WorkflowActivityModel).script != null)
                result = true;
        });

        return result;
    }

    private handleOnModelError = (err: string): void => {
        if (err)
            throw new Error("Error rendering the model " + err);

        this.modeler.get<connectionIcons.ConnectionIcons>("connectionIcons").show();
        this.resetZoom();
    };

    configureModules(): void {
        const conIcons = this.modeler.get<connectionIcons.ConnectionIcons>("connectionIcons");
        conIcons.hasAction = con => (this.props.entities[con.id] as WorkflowConnectionModel | undefined)?.action ?? undefined;
        conIcons.hasCondition = con => (this.props.entities[con.id] as WorkflowConnectionModel | undefined)?.condition ?? undefined;

        const cusRenderer = this.modeler.get<customRenderer.CustomRenderer>("customRenderer");
        cusRenderer.getConnectionType = con => (this.props.entities[con.id] as WorkflowConnectionModel | undefined)?.type ?? undefined;
        cusRenderer.getDecisionStyle = con => BpmnUtils.findDecisionStyle(con, this.props.entities);

        conIcons.show();
    }

    private saveXmlAsync(options: BPMN.SaveOptions): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.modeler.saveXML(options, (err, xml) => err ? reject(new Error(err)) : resolve(xml));
        });
    }

    private saveSvgAsync(options: BPMN.SaveOptions): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.modeler.saveSVG(options, (err, svgStr) => err ? reject(new Error(err)) : resolve(svgStr));
        });
    }

    getXml(): Promise<string> {
        return this.saveXmlAsync({});
    }

    getSvg(): Promise<string> {
        return this.saveSvgAsync({});
    }

    /** A model for a shape the user just created — the defaults Signum's newModel supplies. */
    newModel(element: BPMN.DiElement): ModelEntity {
        const mainEntityType = this.props.workflow.mainEntityType;
        const elementType = element.type;
        const elementName = element.businessObject.name;

        if (elementType === "bpmn:Participant")
            return WorkflowPoolModel.create({ name: elementName });

        if (elementType === "bpmn:Lane")
            return WorkflowLaneModel.create({ name: elementName, mainEntityType });

        if (elementType === "bpmn:StartEvent")
            return WorkflowEventModel.create({
                name: elementName,
                type: WorkflowEventType.Start,
                mainEntityType,
                bpmnElementId: element.id,
            });

        if (elementType === "bpmn:BoundaryEvent") {
            const parentTask = this.props.entities[element.host.id] as WorkflowActivityModel;
            const boundaryTimer = WorkflowEventModel.create({
                name: elementName,
                type: WorkflowEventType.BoundaryInterruptingTimer,
                mainEntityType,
                bpmnElementId: element.id,
                timer: WorkflowTimerEmbedded.create({ duration: oneDay() }),
            });

            parentTask.boundaryTimers.push(boundaryTimer);
            return boundaryTimer;
        }

        if (BpmnUtils.isTaskAnyKind(elementType))
            return WorkflowActivityModel.create({
                name: elementName,
                type: WorkflowActivityType.Task,
                workflow: this.props.workflow,
                mainEntityType,
            });

        if (elementType === "bpmn:IntermediateCatchEvent")
            return WorkflowEventModel.create({
                name: elementName,
                type: WorkflowEventType.IntermediateTimer,
                mainEntityType,
                bpmnElementId: element.id,
                timer: WorkflowTimerEmbedded.create({ duration: oneDay() }),
            });

        if (BpmnUtils.isConnection(elementType))
            return WorkflowConnectionModel.create({
                name: elementName,
                mainEntityType,
                type: ConnectionType.Normal,
            });

        throw new Error("Impossible to create new Model: Unexpected " + elementType);
    }

    getModel(element: BPMN.DiElement): ModelEntity | undefined {
        if (element.type === "bpmn:BoundaryEvent") {
            const parentTask = this.props.entities[element.host.id] as WorkflowActivityModel;
            return parentTask.boundaryTimers.singleOrNull(a => a.bpmnElementId === element.id) ?? undefined;
        }

        return this.props.entities[element.id];
    }

    setModel(element: BPMN.DiElement, value: ModelEntity): void {
        if (element.type === "bpmn:BoundaryEvent") {
            const parentTask = this.props.entities[element.host.id] as WorkflowActivityModel;
            const index = parentTask.boundaryTimers.findIndex(a => a.bpmnElementId === element.id);
            parentTask.boundaryTimers[index] = value as WorkflowEventModel;
        }
        else
            this.props.entities[element.id] = value;
    }

    handleElementDoubleClick = (e: BPMN.DoubleClickEvent): void => {
        if (e.element.type === "bpmn:EndEvent" || e.element.type === "label" || BpmnUtils.isGatewayAnyKind(e.element.type))
            return;

        let model = this.getModel(e.element);

        if (model == null) {
            if (BpmnUtils.isConnection(e.element.type) || e.element.type === "bpmn:Participant"
                || e.element.type === "bpmn:Lane" || e.element.type === "bpmn:StartEvent")
                model = this.props.entities[e.element.id] = this.newModel(e.element);
            else
                throw new Error("No Model found for " + e.element.id);
        }

        (model as unknown as { name: string }).name = e.element.businessObject.name;

        if (BpmnUtils.isConnection(e.element.type)) {
            const sourceRef = (e.element.businessObject as BPMN.ConnectionModdleElemnet).sourceRef;
            const sourceElementType = sourceRef.$type;
            const connModel = model as WorkflowConnectionModel;

            connModel.needCondition = sourceElementType === "bpmn:ExclusiveGateway"
                || sourceElementType === "bpmn:InclusiveGateway";

            if (connModel.needCondition) {
                connModel.decisionOptions = [];
                for (const c of (sourceRef.incoming ?? [])) {
                    const sourceType = c.sourceRef.$type;
                    if (sourceType === "bpmn:Task" || sourceType === "bpmn:UserTask") {
                        const sourceActivityModel = this.props.entities[c.sourceRef.id] as WorkflowActivityModel | undefined;
                        if (sourceActivityModel?.type === WorkflowActivityType.Decision)
                            connModel.decisionOptions.push(...sourceActivityModel.decisionOptions);
                    }
                }
            }

            connModel.needOrder = sourceElementType === "bpmn:ExclusiveGateway";
        }

        e.preventDefault();
        e.stopPropagation();

        void Navigator.view(model).then(me => {
            if (me == null)
                return;

            this.setModel(e.element, me as ModelEntity);

            e.element.businessObject.name = (me as unknown as { name: string }).name;

            if (BpmnUtils.isTaskAnyKind(e.element.type)) {
                const dt = (me as WorkflowActivityModel).type;
                e.element.type =
                    (dt === WorkflowActivityType.CallWorkflow || dt === WorkflowActivityType.DecompositionWorkflow) ? "bpmn:CallActivity" :
                        dt === WorkflowActivityType.Decision ? "bpmn:UserTask" :
                            dt === WorkflowActivityType.Script ? "bpmn:ScriptTask" :
                                "bpmn:Task";
            }
            else if (e.element.type === "bpmn:StartEvent") {
                const et = (me as WorkflowEventModel).type;
                e.element.type = (et === WorkflowEventType.Start || et === WorkflowEventType.ScheduledStart)
                    ? "bpmn:StartEvent" : "bpmn:EndEvent";

                const shouldEvent =
                    (et === WorkflowEventType.Start || et === WorkflowEventType.Finish) ? null :
                        (me as WorkflowEventModel).task!.triggeredOn === TriggeredOn.Always
                            ? "bpmn:TimerEventDefinition"
                            : "bpmn:ConditionalEventDefinition";

                this.changeElementDefinition(e.element, shouldEvent);
            }

            let newName = (me as unknown as { name: string | null }).name;

            if (me instanceof WorkflowConnectionModel) {
                if (newName)
                    newName = newName.tryBeforeLast(":") ?? newName;

                if (me.order != null)
                    newName = newName + ": " + me.order;
            }

            this.modeler.get<any>("modeling").updateProperties(e.element, { name: newName });
        });
    };

    handleElementChanged = (e: BPMN.ElementEvent): void => {
        if (BpmnUtils.isTaskAnyKind(e.element.type)) {
            const act = this.props.entities[e.element.id] as WorkflowActivityModel | undefined;
            if (act != null) {
                // No explicit "modified = true" (Signum's next line): altea's dirty tracking is
                // snapshot-based, so the assignment below already makes the model self-modified.
                act.name = e.element.businessObject.name;
            }
        }
        else if (e.element.type === "bpmn:BoundaryEvent") {
            if (e.element.host) {
                const event = this.getModel(e.element) as WorkflowEventModel | undefined;
                if (event != null) {
                    event.type = (e.element.businessObject as unknown as { cancelActivity: boolean }).cancelActivity
                        ? WorkflowEventType.BoundaryInterruptingTimer
                        : WorkflowEventType.BoundaryForkTimer;

                    if (event.timer != null)
                        this.changeElementDefinition(e.element, event.timer.condition != null
                            ? "bpmn:ConditionalEventDefinition" : "bpmn:TimerEventDefinition");

                    this.setModel(e.element, event);
                }
            }
        }
        else if (e.element.type === "bpmn:IntermediateCatchEvent") {
            const event = this.getModel(e.element) as WorkflowEventModel | undefined;
            if (event?.timer != null)
                this.changeElementDefinition(e.element, event.timer.condition != null
                    ? "bpmn:ConditionalEventDefinition" : "bpmn:TimerEventDefinition");
        }
    };

    changeElementDefinition(element: BPMN.DiElement, shouldEvent?: string | null): void {
        const bo = element.businessObject;

        if (shouldEvent) {
            if (!bo.eventDefinitions)
                bo.eventDefinitions = [];

            bo.eventDefinitions.filter(a => a.$type !== shouldEvent).forEach(a => bo.eventDefinitions!.remove(a));
            if (bo.eventDefinitions.length === 0)
                bo.eventDefinitions.push(this.bpmnFactory.create(shouldEvent, {}));
        }
        else
            bo.eventDefinitions = undefined;
    }

    handleCreateEnded = (e: BPMN.EndedEvent | BPMN.AutoPlaceEndEvent): void => {
        let shape = (e as BPMN.EndedEvent).context
            ? (e as BPMN.EndedEvent).context.shape
            : (e as BPMN.AutoPlaceEndEvent).shape;

        if (shape.type === "bpmn:EndEvent" || shape.type === "label" || BpmnUtils.isGatewayAnyKind(shape.type))
            return;

        if (shape.type === "bpmn:BoundaryEvent") {
            shape = this.bpmnReplace.replaceElement(shape, {
                type: "bpmn:BoundaryEvent",
                eventDefinitionType: "bpmn:TimerEventDefinition",
            });
        }
        else if (shape.type === "bpmn:IntermediateThrowEvent") {
            shape = this.bpmnReplace.replaceElement(shape, {
                type: "bpmn:IntermediateCatchEvent",
                eventDefinitionType: "bpmn:TimerEventDefinition",
            });
        }

        const model = this.newModel(shape);
        if (shape.type !== "bpmn:BoundaryEvent")
            this.props.entities[shape.id] = model;
    };

    lastPasted?: { id: string; name?: string };

    handleElementPaste = (e: BPMN.PasteEvent): void => {
        if (this.lastPasted)
            console.error("lastPasted not consumed: " + this.lastPasted.id);

        if (e.descriptor.type !== "label")
            this.lastPasted = { id: e.descriptor.id, name: e.descriptor.name };
    };

    handleElementDeletePostExecuted = (e: BPMN.DeletePostExecutedEvent): void => {
        e.context.elements.forEach(element => {
            if (element.type === "bpmn:BoundaryEvent") {
                const parentActivity = Object.values(this.props.entities)
                    .single(model => model instanceof WorkflowActivityModel
                        && model.boundaryTimers.some(a => a.bpmnElementId === element.id)) as WorkflowActivityModel;

                const timer = parentActivity.boundaryTimers.single(a => a.bpmnElementId === element.id);
                parentActivity.boundaryTimers.remove(timer);
            }
            else {
                // Signum guards this with "model.isNew", which is always true for a ModelEntity (a model is
                // never saved), so the entry simply goes; what happens to the STORED node is the server's
                // replacement dialog, driven by the diagram no longer containing it.
                delete this.props.entities[element.id];
            }
        });
    };

    handleAddShapeOrConnection = (e: BPMN.ElementEvent): void => {
        if (this.lastPasted) {
            const model = this.props.entities[this.lastPasted.id];
            if (model != null) {
                // A structural clone: the pasted shape gets its own model, not a shared reference.
                const clone = JSON.parse(JSON.stringify(model)) as ModelEntity;
                this.props.entities[e.element.id] = clone;
            }

            if (this.lastPasted.name)
                e.element.businessObject.name = this.lastPasted.name;

            this.lastPasted = undefined;
        }
    };

    override componentWillUnmount(): void {
        this.modeler.destroy();
    }

    override componentDidUpdate(prevProps: BpmnModelerComponentProps): void {
        if (this.modeler && this.props.diagramXML !== undefined && prevProps.diagramXML !== this.props.diagramXML)
            this.modeler.importXML(this.props.diagramXML, this.handleOnModelError);
    }

    setDiv = (div: HTMLDivElement | null): void => {
        if (this.divArea)
            this.divArea.removeEventListener("click", this.clickConnectionIconEvent as EventListener);

        this.divArea = div!;

        if (this.divArea)
            this.divArea.addEventListener("click", this.clickConnectionIconEvent);
    };

    clickConnectionIconEvent = (e: MouseEvent): void => {
        const d = e.target as HTMLDivElement;

        if (d.classList && d.classList.contains("connection-icon")) {
            const lite = Lite.parse(d.dataset["key"]!);
            void Navigator.view(lite);
        }
    };

    handleZoomClick = (): void => {
        this.resetZoom();
    };

    resetZoom(): void {
        const zoomScroll = this.modeler.get<any>("zoomScroll");
        zoomScroll.reset();
    }

    override render(): React.JSX.Element {
        return (
            <div>
                <Button variant="secondary" style={{ marginLeft: "10px" }} onClick={this.handleZoomClick}>
                    {WorkflowMessage.ResetZoom.niceToString()}
                </Button>
                <Button variant="secondary" style={{ marginLeft: "10px" }} onClick={this.handleSaveSvgClick}>
                    <FontAwesomeIcon icon="image" title={WorkflowMessage.SaveAsSVG.niceToString()} />
                </Button>
                <div ref={this.setDiv} />
            </div>
        );
    }

    handleSaveSvgClick = (): void => {
        const fileName = this.props.workflow.name ? `${this.props.workflow.name}.svg` : "diagram.svg";

        void this.getSvg().then(svgData => {
            const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
            const svgUrl = URL.createObjectURL(svgBlob);
            const downloadLink = document.createElement("a");
            downloadLink.href = svgUrl;
            downloadLink.download = fileName;
            document.body.appendChild(downloadLink);
            try {
                downloadLink.click();
            } finally {
                document.body.removeChild(downloadLink);
            }
        });
    };
}

function oneDay(): TimeSpanEmbedded {
    return TimeSpanEmbedded.create({ days: 1 as never, hours: 0 as never, minutes: 0 as never, seconds: 0 as never });
}
