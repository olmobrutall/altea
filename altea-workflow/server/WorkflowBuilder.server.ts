import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/data/globals/arrayExtensions";
import { table } from "@altea/altea/server/table";
import { Operations } from "@altea/altea/server/operationLogic";
import { Synchronizer } from "@altea/altea/server/sync/synchronizer";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { XmlElement, XmlText } from "@altea/altea/server/xml/xmlElement";
import { parseXmlDocument, serializeElement } from "@altea/altea/server/xml/xmlDocument";
import { cleanModified, isGraphModified } from "@altea/altea/data/changes";
import { Lite } from "@altea/altea/data/lite";
import { ModelEntity } from "@altea/altea/data/entity";
import {
    WorkflowEntity, WorkflowEntity_MainEntityStrategy, WorkflowModel, WorkflowReplacementModel,
    WorkflowReplacementItemEmbedded, NewTasksEmbedded,
    WorkflowValidationMessage, WorkflowXmlEmbedded, BpmnEntityPairEmbedded,
    type IWithModel, type IWorkflowNodeEntity, type IWorkflowObjectEntity,
} from "../data/Workflow";
import {
    WorkflowActivityEntity, WorkflowActivityEntity_DecisionOption, WorkflowActivityEntity_ViewNameProp,
    WorkflowActivityModel, WorkflowActivityOperation, WorkflowActivityType, ViewNamePropEmbedded,
    WorkflowLaneEntity_Actor, ConnectionType,
    WorkflowConnectionEntity, WorkflowConnectionModel, WorkflowConnectionOperation, WorkflowEventEntity,
    WorkflowEventModel, WorkflowEventOperation, WorkflowEventType, WorkflowGatewayDirection,
    WorkflowGatewayEntity, WorkflowGatewayOperation, WorkflowGatewayType, WorkflowLaneEntity,
    WorkflowLaneModel, WorkflowLaneOperation, WorkflowPoolEntity, WorkflowPoolModel, WorkflowPoolOperation,
    isBoundaryTimer, isScheduledStart, isStart, isTimer,
} from "../data/WorkflowNodes";
import type { WorkflowIssue } from "../data/WorkflowDtos";
import { WorkflowNodeGraph } from "./WorkflowNodeGraph.server";

// Port of Signum.Workflow's WorkflowBuilder.cs + PoolBuilder.cs + LaneBuilder.cs — the two-way bridge between
// the BPMN diagram the designer edits and the ENTITIES that store it. Reading: assemble one `<bpmn:definitions>`
// document out of the stored nodes plus each one's own diagram element. Writing: diff the posted document
// against the stored graph and create / update / delete accordingly, moving or dropping the case activities of
// anything that disappears.
//
// altea divergences:
//  - `System.Xml.Linq` becomes altea's own XML element tree (@altea/altea/server/xml) — promoted to core from
//    @altea/altea-office-template for this port. `XNamespace + local name` becomes the QUALIFIED name as
//    written ("bpmn:process"), which is the same identity for a document that declares its prefixes on the
//    root and never rebinds them (BPMN never does).
//  - Signum parses an entity's stored diagram element by wrapping it in a fake `<bpmn:definitions>` envelope,
//    because XDocument resolves namespace URIs. altea's tree matches on the prefix, so the bare element parses
//    directly — the envelope is unnecessary.
//  - Signum's three C# PARTIAL classes (WorkflowBuilder / PoolBuilder / LaneBuilder, nested) become three
//    classes in this one file: TypeScript has no nested classes, and splitting them across files would be an
//    import cycle.
//  - the constructor's work is async (it reads the graph), so `new WorkflowBuilder(wf)` becomes the static
//    `WorkflowBuilder.create(wf)`; every pass through `Synchronizer.synchronizeAsync` (added to core) awaits.
//  - `GraphExplorer.HasChanges(x)` → `isGraphModified(x)` (altea's snapshot-based dirty check).

const BPMN = "bpmn";
const BPMNDI = "bpmndi";
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
const BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const BPMNDI_NS = "http://www.omg.org/spec/BPMN/20100524/DI";
const DC_NS = "http://www.omg.org/spec/DD/20100524/DC";
const DI_NS = "http://www.omg.org/spec/DD/20100524/DI";
const TARGET_NAMESPACE = "http://bpmn.io/schema/bpmn";

/** Signum's `LaneBuilder.WorkflowEventTypes` — which BPMN element each event type is drawn as. */
export const workflowEventTypes: Record<WorkflowEventType, string> = {
    [WorkflowEventType.Start]: "startEvent",
    [WorkflowEventType.ScheduledStart]: "startEvent",
    [WorkflowEventType.Finish]: "endEvent",
    [WorkflowEventType.BoundaryForkTimer]: "boundaryEvent",
    [WorkflowEventType.BoundaryInterruptingTimer]: "boundaryEvent",
    [WorkflowEventType.IntermediateTimer]: "intermediateCatchEvent",
};

export const workflowActivityTypes: Record<WorkflowActivityType, string> = {
    [WorkflowActivityType.Task]: "task",
    [WorkflowActivityType.Decision]: "userTask",
    [WorkflowActivityType.CallWorkflow]: "callActivity",
    [WorkflowActivityType.DecompositionWorkflow]: "callActivity",
    [WorkflowActivityType.Script]: "scriptTask",
};

export const workflowGatewayTypes: Record<WorkflowGatewayType, string> = {
    [WorkflowGatewayType.Inclusive]: "inclusiveGateway",
    [WorkflowGatewayType.Parallel]: "parallelGateway",
    [WorkflowGatewayType.Exclusive]: "exclusiveGateway",
};

/** The set of element names an EVENT can be, excluding boundary events (which live under their activity). */
const nonBoundaryEventElementNames = new Set(
    (Object.keys(workflowEventTypes) as unknown as WorkflowEventType[])
        .filter(t => !isBoundaryTimer(Number(t) as WorkflowEventType))
        .map(t => workflowEventTypes[t as WorkflowEventType]));

const activityElementNames = new Set(Object.values(workflowActivityTypes));
const gatewayElementNames = new Set(Object.values(workflowGatewayTypes));

// ---- The per-entity diagram element --------------------------------------------------------------------

/**
 * Signum's `XmlEntity<T>` — an entity paired with the ONE `<bpmndi:BPMNShape>` / `<bpmndi:BPMNEdge>` element
 * that draws it, parsed out of its stored `xml.diagramXml`.
 */
export class XmlEntity<T extends IWorkflowObjectEntity & IWithModel> {
    readonly element: XmlElement;
    readonly bpmnElementId: string;

    constructor(readonly entity: T) {
        this.element = parseXmlDocument(entity.xml.diagramXml).root;
        const id = this.element.getAttribute("bpmnElement");
        if (id == null)
            throw new Error(`The stored diagram element of '${entity}' has no bpmnElement attribute`);
        this.bpmnElementId = id;
    }

    toModelPair(): [string, ModelEntity] {
        return [this.bpmnElementId, this.entity.getModel()];
    }

    toString(): string {
        return `${this.bpmnElementId} ${this.entity.constructor.name} ${this.entity.getName()}`;
    }
}

function el(qualifiedName: string, attributes: Record<string, string | number | boolean | null | undefined>,
    ...children: (XmlElement | XmlElement[] | null | undefined)[]): XmlElement {
    const e = new XmlElement(qualifiedName);
    for (const [k, v] of Object.entries(attributes))
        if (v != null)
            e.setAttribute(k, String(v));
    for (const c of children) {
        if (c == null) continue;
        if (Array.isArray(c)) e.append(...c);
        else e.append(c);
    }
    return e;
}

function textEl(qualifiedName: string, text: string): XmlElement {
    const e = new XmlElement(qualifiedName);
    e.append(new XmlText(text));
    return e;
}

// ---- Locator ------------------------------------------------------------------------------------------

/** Signum's Locator — what `applyXml` needs while walking the posted document. */
export class Locator {
    readonly replacements = new Map<string, string>();
    private readonly entitiesFromModel = new Map<string, ModelEntity>();

    constructor(
        private readonly wb: WorkflowBuilder,
        private readonly diagramElements: Map<string, XmlElement>,
        model: WorkflowModel,
        replacements: WorkflowReplacementModel | null,
    ) {
        for (const r of replacements?.replacements ?? [])
            this.replacements.set(r.oldNode.key(), r.newNode);
        for (const p of model.entities)
            this.entitiesFromModel.set(p.bpmnElementId, p.model);
    }

    findEntity(bpmnElementId: string): IWorkflowNodeEntity | null {
        return this.wb.findEntity(bpmnElementId);
    }

    findLane(lane: WorkflowLaneEntity): LaneBuilder {
        return this.wb.findLane(lane);
    }

    existDiagram(bpmnElementId: string): boolean {
        return this.diagramElements.has(bpmnElementId);
    }

    getDiagram(bpmnElementId: string): XmlElement {
        const e = this.diagramElements.get(bpmnElementId);
        if (e == null)
            throw new Error(`No diagram element for '${bpmnElementId}'`);
        return e;
    }

    getModelEntity<T extends ModelEntity>(bpmnElementId: string): T | null {
        return (this.entitiesFromModel.get(bpmnElementId) as T | undefined) ?? null;
    }

    hasReplacement(lite: Lite<IWorkflowNodeEntity>): boolean {
        return (this.replacements.get(lite.key()) ?? "") !== "";
    }

    getReplacement(lite: Lite<IWorkflowNodeEntity>): IWorkflowNodeEntity | null {
        const bpmnElementId = this.replacements.get(lite.key());
        if (bpmnElementId == null)
            throw new Error(`No replacement declared for '${lite.key()}'`);
        return this.findEntity(bpmnElementId);
    }
}

// ---- The case-activity moves a delete implies ----------------------------------------------------------
//
// Signum puts these two on LaneBuilder as private statics; they need CaseActivityLogic, which needs the
// builder, so altea injects them (WorkflowLogic wires them at start). Without a case module they are no-ops,
// which is exactly right: a workflow with no cases has nothing to move.

export interface CaseActivityMover {
    /** Signum's `DeleteCaseActivities(node, filter)` — drop the case activities of a node being deleted. */
    deleteCaseActivities(node: IWorkflowNodeEntity): Promise<void>;
    /** Signum's `MoveCasesAndDelete` half that re-points them at a replacement node. */
    moveCaseActivities(node: IWorkflowNodeEntity, replacement: IWorkflowNodeEntity): Promise<void>;
    /** Does this node still have any case activity at all? */
    hasCaseActivities(node: IWorkflowNodeEntity): Promise<boolean>;
    /** Signum's `WorkflowBuilder.Delete` — every case of a workflow being deleted. */
    deleteCasesOfWorkflow(workflow: WorkflowEntity): Promise<void>;
}

const noCases: CaseActivityMover = {
    deleteCaseActivities: async () => { },
    moveCaseActivities: async () => { },
    hasCaseActivities: async () => false,
    deleteCasesOfWorkflow: async () => { },
};

let mover: CaseActivityMover = noCases;

/** Wired by CaseActivityLogic.start (Signum reaches those statics directly). */
export function setCaseActivityMover(m: CaseActivityMover): void {
    mover = m;
}

/** Wired by WorkflowEventTaskLogic.start — cloning a Scheduled Start clones its scheduled task. */
export let cloneScheduledTasks: (oldEvent: WorkflowEventEntity, newEvent: WorkflowEventEntity) => Promise<void> =
    async () => { };

export function setCloneScheduledTasks(fn: typeof cloneScheduledTasks): void {
    cloneScheduledTasks = fn;
}

/** Wired by WorkflowEventTaskLogic.start — apply the scheduler side of a Scheduled Start's model. */
export let applyWorkflowEventTaskModel:
    (event: WorkflowEventEntity, model: import("../data/WorkflowEventTask").WorkflowEventTaskModel | null) => Promise<void> =
    async () => { };

export function setApplyWorkflowEventTaskModel(fn: typeof applyWorkflowEventTaskModel): void {
    applyWorkflowEventTaskModel = fn;
}

/** Wired by WorkflowEventTaskLogic.start — read the scheduler side INTO a WorkflowEventModel. */
export let getWorkflowEventTaskModel:
    (event: WorkflowEventEntity) => Promise<import("../data/WorkflowEventTask").WorkflowEventTaskModel | null> =
    async () => null;

export function setGetWorkflowEventTaskModel(fn: typeof getWorkflowEventTaskModel): void {
    getWorkflowEventTaskModel = fn;
}

// ---- LaneBuilder --------------------------------------------------------------------------------------

export class LaneBuilder {
    readonly lane: XmlEntity<WorkflowLaneEntity>;
    events = new Map<string, XmlEntity<WorkflowEventEntity>>();
    activities = new Map<string, XmlEntity<WorkflowActivityEntity>>();
    gateways = new Map<string, XmlEntity<WorkflowGatewayEntity>>();
    connections = new Map<string, XmlEntity<WorkflowConnectionEntity>>();
    private incoming = new Map<string, XmlEntity<WorkflowConnectionEntity>[]>();
    private outgoing = new Map<string, XmlEntity<WorkflowConnectionEntity>[]>();

    constructor(lane: WorkflowLaneEntity,
        activities: WorkflowActivityEntity[],
        events: WorkflowEventEntity[],
        gateways: WorkflowGatewayEntity[],
        connections: XmlEntity<WorkflowConnectionEntity>[]) {

        this.lane = new XmlEntity(lane);
        for (const e of events) { const x = new XmlEntity(e); this.events.set(x.bpmnElementId, x); }
        for (const a of activities) { const x = new XmlEntity(a); this.activities.set(x.bpmnElementId, x); }
        for (const g of gateways) { const x = new XmlEntity(g); this.gateways.set(x.bpmnElementId, x); }
        for (const c of connections) this.connections.set(c.bpmnElementId, c);

        for (const c of this.connections.values()) {
            push(this.outgoing, c.entity.from.toLite().key(), c);
            push(this.incoming, c.entity.to.toLite().key(), c);
        }
    }

    findEntity(bpmnElementId: string): IWorkflowNodeEntity | null {
        return this.events.get(bpmnElementId)?.entity
            ?? this.activities.get(bpmnElementId)?.entity
            ?? this.gateways.get(bpmnElementId)?.entity
            ?? null;
    }

    getEvents(): XmlEntity<WorkflowEventEntity>[] { return [...this.events.values()]; }
    getActivities(): XmlEntity<WorkflowActivityEntity>[] { return [...this.activities.values()]; }
    getGateways(): XmlEntity<WorkflowGatewayEntity>[] { return [...this.gateways.values()]; }
    getConnections(): XmlEntity<WorkflowConnectionEntity>[] { return [...this.connections.values()]; }

    isEmpty(): boolean {
        return this.activities.size === 0 && this.events.size === 0 && this.gateways.size === 0;
    }

    getBpmnElementId(node: IWorkflowNodeEntity): string {
        // `is` (row identity), not `===`: Signum compares with `.Is(node)` too, and here it matters — a node
        // reached through a connection's `from`/`to` is a DIFFERENT object than the builder's own instance
        // for the same row (altea has no ambient EntityCache; see WorkflowNodeGraph.fillGraphs).
        const find = (values: Iterable<{ entity: IWorkflowNodeEntity; bpmnElementId: string }>): string | undefined =>
            [...values].firstOrNull(a => a.entity.is(node))?.bpmnElementId;

        const result = find(this.events.values())
            ?? find(this.activities.values())
            ?? find(this.gateways.values());
        if (result == null)
            throw new Error(WorkflowValidationMessage.NodeType0WithId1IsInvalid
                .niceToString(node.constructor.name, String(node.id)));
        return result;
    }

    async applyChanges(processElement: XmlElement, laneElement: XmlElement, locator: Locator): Promise<void> {
        const laneIds = new Set(laneElement.descendantsNamed(BPMN + ":flowNodeRef").map(a => a.innerText));
        const laneElements = [...processElement.elements()].filter(a => laneIds.has(a.getAttribute("id") ?? ""));

        // ---- Events -------------------------------------------------------------------------------
        const events = new Map(laneElements
            .filter(a => nonBoundaryEventElementNames.has(localName(a)))
            .map(a => [a.getAttribute("id")!, a]));
        const oldEvents = new Map([...this.events.values()]
            .filter(a => a.entity.boundaryOf == null)
            .map(a => [a.bpmnElementId, a]));

        await Synchronizer.synchronizeAsync(events, oldEvents,
            async (id, e) => {
                // The node may have been MOVED here from another lane — reuse it rather than recreating.
                const already = locator.findEntity(id) as WorkflowEventEntity | null;
                if (already != null) {
                    locator.findLane(already.lane).events.delete(id);
                    already.lane = this.lane.entity;
                }
                const we = await applyEventXml(already ?? WorkflowEventEntity.create({
                    xml: WorkflowXmlEmbedded.create({}), lane: this.lane.entity,
                }), e, locator);
                this.events.set(id, new XmlEntity(we));
            },
            async (id, oe) => {
                if (!locator.existDiagram(id)) {
                    this.events.delete(id);
                    if (oe.entity.type === WorkflowEventType.IntermediateTimer)
                        await moveCasesAndDelete(oe.entity, locator);
                    else
                        await Operations.delete(oe.entity, WorkflowEventOperation.Delete);
                }
            },
            async (_id, e, oe) => { await applyEventXml(oe.entity, e, locator); });

        // ---- Activities ---------------------------------------------------------------------------
        const activities = new Map(laneElements
            .filter(a => activityElementNames.has(localName(a)))
            .map(a => [a.getAttribute("id")!, a]));
        const oldActivities = new Map([...this.activities.values()].map(a => [a.bpmnElementId, a]));

        await Synchronizer.synchronizeAsync(activities, oldActivities,
            async (id, a) => {
                const already = locator.findEntity(id) as WorkflowActivityEntity | null;
                if (already != null) {
                    locator.findLane(already.lane).activities.delete(id);
                    already.lane = this.lane.entity;
                }
                const wa = await applyActivityXml(already ?? WorkflowActivityEntity.create({
                    xml: WorkflowXmlEmbedded.create({}), lane: this.lane.entity,
                }), a, locator, this.events);
                this.activities.set(id, new XmlEntity(wa));
            },
            async (id, oa) => {
                if (!locator.existDiagram(id)) {
                    this.activities.delete(id);
                    await moveCasesAndDelete(oa.entity, locator);
                }
            },
            async (_id, a, oa) => { await applyActivityXml(oa.entity, a, locator, this.events); });

        // ---- Gateways -----------------------------------------------------------------------------
        const gateways = new Map(laneElements
            .filter(a => gatewayElementNames.has(localName(a)))
            .map(a => [a.getAttribute("id")!, a]));
        const oldGateways = new Map([...this.gateways.values()].map(a => [a.bpmnElementId, a]));

        await Synchronizer.synchronizeAsync(gateways, oldGateways,
            async (id, g) => {
                const already = locator.findEntity(id) as WorkflowGatewayEntity | null;
                if (already != null) {
                    locator.findLane(already.lane).gateways.delete(id);
                    already.lane = this.lane.entity;
                }
                const wg = await applyGatewayXml(already ?? WorkflowGatewayEntity.create({
                    xml: WorkflowXmlEmbedded.create({}), lane: this.lane.entity,
                }), g, locator);
                this.gateways.set(id, new XmlEntity(wg));
            },
            async (id, og) => {
                if (!locator.existDiagram(id)) {
                    this.gateways.delete(id);
                    await Operations.delete(og.entity, WorkflowGatewayOperation.Delete);
                }
            },
            async (_id, g, og) => { await applyGatewayXml(og.entity, g, locator); });
    }

    // ---- Writing the document ------------------------------------------------------------------------

    getLaneSetElement(): XmlElement {
        return el(BPMN + ":lane", { id: this.lane.bpmnElementId, name: this.lane.entity.name },
            this.getEvents().map(e => textEl(BPMN + ":flowNodeRef", e.bpmnElementId)),
            this.getActivities().map(e => textEl(BPMN + ":flowNodeRef", e.bpmnElementId)),
            this.getGateways().map(e => textEl(BPMN + ":flowNodeRef", e.bpmnElementId)));
    }

    async getNodesElement(): Promise<XmlElement[]> {
        const result: XmlElement[] = [];
        for (const e of this.getEvents())
            result.push(await this.getEventProcessElement(e));
        for (const a of this.getActivities())
            result.push(this.getActivityProcessElement(a));
        for (const g of this.getGateways())
            result.push(this.getGatewayProcessElement(g));
        return result;
    }

    getDiagramElement(): XmlElement[] {
        return [
            this.lane.element,
            ...this.getEvents().map(a => a.element),
            ...this.getActivities().map(a => a.element),
            ...this.getGateways().map(a => a.element),
        ];
    }

    private async getEventProcessElement(e: XmlEntity<WorkflowEventEntity>): Promise<XmlElement> {
        const activity = e.entity.boundaryOf == null ? null
            : this.getActivities().single(a => e.entity.boundaryOf!.is(a.entity)).entity;

        // Signum asks the event's MODEL for its task to decide timer-vs-conditional; altea reads the
        // scheduler side through the injected hook (getModel is pure here — see data/WorkflowNodes.ts).
        const task = isScheduledStart(e.entity.type) ? await getWorkflowEventTaskModel(e.entity) : null;
        const isTimerDefinition = task?.triggeredOn === 0 /* TriggeredOn.Always */
            || (isTimer(e.entity.type) && e.entity.timer?.duration != null);

        return el(BPMN + ":" + workflowEventTypes[e.entity.type], {
            id: e.bpmnElementId,
            attachedToRef: activity?.bpmnElementId,
            cancelActivity: e.entity.type === WorkflowEventType.BoundaryForkTimer ? "false" : undefined,
            name: (e.entity.name ?? "") === "" ? undefined : e.entity.name,
        },
            isScheduledStart(e.entity.type) || isTimer(e.entity.type)
                ? el(BPMN + ":" + (isTimerDefinition ? "timerEventDefinition" : "conditionalEventDefinition"), {})
                : null,
            this.getConnectionElements(e.entity.toLite()));
    }

    private getActivityProcessElement(a: XmlEntity<WorkflowActivityEntity>): XmlElement {
        return el(BPMN + ":" + workflowActivityTypes[a.entity.type],
            { id: a.bpmnElementId, name: a.entity.name },
            this.getConnectionElements(a.entity.toLite()));
    }

    private getGatewayProcessElement(g: XmlEntity<WorkflowGatewayEntity>): XmlElement {
        return el(BPMN + ":" + workflowGatewayTypes[g.entity.type],
            { id: g.bpmnElementId, name: (g.entity.name ?? "") === "" ? undefined : g.entity.name },
            this.getConnectionElements(g.entity.toLite()));
    }

    private getConnectionElements(lite: Lite<IWorkflowNodeEntity>): XmlElement[] {
        return [
            ...(this.incoming.get(lite.key()) ?? []).map(c => textEl(BPMN + ":incoming", c.bpmnElementId)),
            ...(this.outgoing.get(lite.key()) ?? []).map(c => textEl(BPMN + ":outgoing", c.bpmnElementId)),
        ];
    }

    // ---- Deleting -----------------------------------------------------------------------------------

    async deleteAll(locator: Locator | null): Promise<void> {
        for (const e of this.getEvents().map(a => a.entity)) {
            if (e.type === WorkflowEventType.IntermediateTimer) {
                if (locator != null)
                    await moveCasesAndDelete(e, locator);
                else {
                    await mover.deleteCaseActivities(e);
                    await Operations.delete(e, WorkflowEventOperation.Delete);
                }
            }
            else
                await Operations.delete(e, WorkflowEventOperation.Delete);
        }

        for (const g of this.getGateways().map(a => a.entity))
            await Operations.delete(g, WorkflowGatewayOperation.Delete);

        for (const ac of this.getActivities().map(a => a.entity)) {
            if (locator != null)
                await moveCasesAndDelete(ac, locator);
            else {
                await mover.deleteCaseActivities(ac);
                await Operations.delete(ac, WorkflowActivityOperation.Delete);
            }
        }

        await Operations.delete(this.lane.entity, WorkflowLaneOperation.Delete);
    }

    // ---- Cloning ------------------------------------------------------------------------------------

    async clone(pool: WorkflowPoolEntity, nodes: ClonedNodes): Promise<void> {
        const oldLane = this.lane.entity;
        const newLane = WorkflowLaneEntity.create({
            pool,
            name: oldLane.name,
            bpmnElementId: oldLane.bpmnElementId,
            actorsEvaluator: oldLane.actorsEvaluator,
            useActorEvalForStart: oldLane.useActorEvalForStart,
            combineActorAndActorEvalWhenContinuing: oldLane.combineActorAndActorEvalWhenContinuing,
            xml: oldLane.xml,
        });
        // The `@part` actor rows are cloned: a part belongs to exactly ONE owner, so the copy needs its
        // own rows rather than a shared reference.
        newLane.actors = oldLane.actors.map(a => WorkflowLaneEntity_Actor.create({ actor: a.actor }));
        await newLane.save();

        // Keyed by the old event's lite key, like `nodes` — an activity's `boundaryTimers` entry need not be
        // the same object as the one this loop cloned (see ClonedNodes).
        const newEvents = new Map<string, WorkflowEventEntity>();
        for (const e of this.getEvents().map(a => a.entity)) {
            const ne = WorkflowEventEntity.create({
                lane: newLane,
                name: e.name,
                bpmnElementId: e.bpmnElementId,
                timer: e.timer?.clone() ?? null,
                type: e.type,
                runRepeatedly: e.runRepeatedly,
                decisionOptionName: e.decisionOptionName,
                xml: e.xml,
            });
            newEvents.set(e.toLite().key(), ne);
            await ne.save();
            nodes.set(e.toLite().key(), { old: e, new: ne });
        }

        for (const a of this.getActivities().map(x => x.entity)) {
            const na = WorkflowActivityEntity.create({
                lane: newLane,
                name: a.name,
                bpmnElementId: a.bpmnElementId,
                xml: a.xml,
                type: a.type,
                viewName: a.viewName,
                requiresOpen: a.requiresOpen,
                estimatedDuration: a.estimatedDuration,
                script: a.script?.clone() ?? null,
                subWorkflow: a.subWorkflow?.clone() ?? null,
                userHelp: a.userHelp,
                comments: a.comments,
                customNextButton: a.customNextButton?.clone() ?? null,
            });
            na.viewNameProps = a.viewNameProps.map(p => WorkflowActivityEntity_ViewNameProp.create({
                prop: ViewNamePropEmbedded.create({ name: p.prop.name, expression: p.prop.expression }),
            }));
            na.decisionOptions = a.decisionOptions.map(d => WorkflowActivityEntity_DecisionOption.create({
                option: d.option.clone(),
            }));
            await na.save();

            // The boundary timers are the cloned events, re-pointed at the cloned activity.
            for (const t of a.boundaryTimers) {
                const nt = newEvents.get(t.toLite().key())!;
                nt.boundaryOf = na.toLite();
                await nt.save();
                na.boundaryTimers.push(nt);
            }

            nodes.set(a.toLite().key(), { old: a, new: na });
        }

        for (const g of this.getGateways().map(a => a.entity)) {
            const ng = WorkflowGatewayEntity.create({
                lane: newLane,
                name: g.name,
                bpmnElementId: g.bpmnElementId,
                type: g.type,
                direction: g.direction,
                xml: g.xml,
            });
            await ng.save();
            nodes.set(g.toLite().key(), { old: g, new: ng });
        }
    }
}

// ---- PoolBuilder --------------------------------------------------------------------------------------

export class PoolBuilder {
    readonly pool: XmlEntity<WorkflowPoolEntity>;
    private lanes = new Map<string, LaneBuilder>();
    /** Every connection INTERNAL to this pool (including the ones internal to a single lane). */
    private sequenceFlows: XmlEntity<WorkflowConnectionEntity>[];

    constructor(p: WorkflowPoolEntity, laneBuilders: LaneBuilder[], sequenceFlows: XmlEntity<WorkflowConnectionEntity>[]) {
        this.pool = new XmlEntity(p);
        for (const lb of laneBuilders)
            this.lanes.set(lb.lane.entity.toLite().key(), lb);
        this.sequenceFlows = [...sequenceFlows];
    }

    getLanes(): LaneBuilder[] { return [...this.lanes.values()]; }
    getSequenceFlows(): XmlEntity<WorkflowConnectionEntity>[] { return this.sequenceFlows; }

    getLaneBuilder(lane: Lite<WorkflowLaneEntity>): LaneBuilder {
        const lb = this.lanes.get(lane.key());
        if (lb == null)
            throw new Error(`Lane '${lane.key()}' is not in this pool`);
        return lb;
    }

    findEntity(bpmnElementId: string): IWorkflowNodeEntity | null {
        return this.getLanes().map(lb => lb.findEntity(bpmnElementId)).notNull().singleOrNull();
    }

    getAllActivities(): XmlEntity<WorkflowActivityEntity>[] {
        return this.getLanes().flatMap(la => la.getActivities());
    }

    async applyChanges(processElement: XmlElement, locator: Locator): Promise<void> {
        const sequenceFlows = new Map(processElement.descendantsNamed(BPMN + ":sequenceFlow")
            .filter(a => a.parent === processElement)
            .map(a => [a.getAttribute("id")!, a]));
        const oldSequenceFlows = new Map(this.sequenceFlows.map(a => [a.bpmnElementId, a]));

        // PASS 1 — drop the connections that are gone, and RE-POINT the ones whose endpoints moved. Both
        // must happen before the node passes so a node delete does not trip over a dangling FK.
        await Synchronizer.synchronizeAsync(sequenceFlows, oldSequenceFlows,
            undefined,
            async (_id, osf) => {
                this.sequenceFlows.remove(osf);
                await Operations.delete(osf.entity, WorkflowConnectionOperation.Delete);
            },
            async (_id, sf, osf) => {
                const newFrom = locator.findEntity(sf.getAttribute("sourceRef")!);
                const newTo = locator.findEntity(sf.getAttribute("targetRef")!);

                if (!sameNode(newFrom, osf.entity.from) || !sameNode(newTo, osf.entity.to)) {
                    // Signum does this as an UnsafeUpdate + SetCleanModified(false): the endpoints must be
                    // re-pointed WITHOUT running the Save operation, which would validate against a graph
                    // that is only half-applied.
                    await table(WorkflowConnectionEntity).filter(a => a.id === osf.entity.id)
                        .executeUpdate(() => ({ from: newFrom!, to: newTo! }));
                    osf.entity.from = newFrom!;
                    osf.entity.to = newTo!;
                    cleanModified(osf.entity);
                }
            });

        // PASS 2 — the lanes (and, through them, the nodes).
        const oldLanes = new Map(this.getLanes().map(a => [a.lane.bpmnElementId, a]));
        const laneSet = processElement.element(BPMN + ":laneSet");
        const lanes = new Map((laneSet?.descendantsNamed(BPMN + ":lane") ?? [])
            .map(a => [a.getAttribute("id")!, a]));

        await Synchronizer.synchronizeAsync(lanes, oldLanes,
            async (_id, l) => {
                const wl = await applyLaneXml(WorkflowLaneEntity.create({
                    xml: WorkflowXmlEmbedded.create({}), pool: this.pool.entity,
                }), l, locator);
                const lb = new LaneBuilder(wl, [], [], [], []);
                await lb.applyChanges(processElement, l, locator);
                this.lanes.set(wl.toLite().key(), lb);
            },
            undefined,
            async (_id, l, ol) => {
                await applyLaneXml(ol.lane.entity, l, locator);
                await ol.applyChanges(processElement, l, locator);
            });

        await Synchronizer.synchronizeAsync(lanes, oldLanes,
            undefined,
            async (_id, ol) => {
                // Empty the lane first (its nodes must go before it does), then drop it.
                await ol.applyChanges(processElement, ol.lane.element, locator);
                this.lanes.delete(ol.lane.entity.toLite().key());
                await Operations.delete(ol.lane.entity, WorkflowLaneOperation.Delete);
            },
            undefined);

        // PASS 3 — the connections that are NEW or whose properties changed (their endpoints exist now).
        await Synchronizer.synchronizeAsync(sequenceFlows, oldSequenceFlows,
            async (_id, sf) => {
                const wc = await applyConnectionXml(WorkflowConnectionEntity.create({
                    type: ConnectionType.Normal,
                    xml: WorkflowXmlEmbedded.create({}),
                }), sf, locator);
                this.sequenceFlows.push(new XmlEntity(wc));
            },
            undefined,
            async (_id, sf, osf) => { await applyConnectionXml(osf.entity, sf, locator); });
    }

    getParticipantElement(): XmlElement {
        return el(BPMN + ":participant", {
            id: this.pool.bpmnElementId,
            name: this.pool.entity.name,
            processRef: "Process_" + this.pool.bpmnElementId,
        });
    }

    async getProcessElement(): Promise<XmlElement> {
        const nodes: XmlElement[] = [];
        for (const l of this.getLanes())
            nodes.push(...await l.getNodesElement());

        return el(BPMN + ":process", { id: "Process_" + this.pool.bpmnElementId, isExecutable: "false" },
            el(BPMN + ":laneSet", {}, this.getLanes().map(l => l.getLaneSetElement())),
            nodes,
            this.getSequenceFlowsElement());
    }

    getDiagramElements(): XmlElement[] {
        return [
            this.pool.element,
            ...this.getLanes().flatMap(a => a.getDiagramElement()),
            ...this.sequenceFlows.map(a => a.element),
        ];
    }

    private getSequenceFlowsElement(): XmlElement[] {
        return this.sequenceFlows.map(a => el(BPMN + ":sequenceFlow", {
            id: a.bpmnElementId,
            name: (a.entity.name ?? "") === "" ? undefined : a.entity.name,
            sourceRef: this.getLaneBuilder(a.entity.from.lane.toLite()).getBpmnElementId(a.entity.from),
            targetRef: this.getLaneBuilder(a.entity.to.lane.toLite()).getBpmnElementId(a.entity.to),
        }));
    }

    async deleteAll(locator: Locator | null): Promise<void> {
        for (const lb of this.getLanes())
            await lb.deleteAll(locator);

        await Operations.delete(this.pool.entity, WorkflowPoolOperation.Delete);
    }

    async clone(wf: WorkflowEntity, nodes: ClonedNodes): Promise<void> {
        const oldPool = this.pool.entity;
        const newPool = WorkflowPoolEntity.create({
            workflow: wf,
            name: oldPool.name,
            bpmnElementId: oldPool.bpmnElementId,
            xml: oldPool.xml,
        });
        await newPool.save();

        for (const lb of this.getLanes())
            await lb.clone(newPool, nodes);
    }
}

/**
 * The clone's old→new node map, keyed by the OLD node's lite key.
 *
 * Signum keys `Dictionary<IWorkflowNodeEntity, IWorkflowNodeEntity>` by the entity, which works there because
 * its graph is built inside `using (new EntityCache())`. altea has no such scope, so the connection's
 * `from`/`to` are different objects than the builder's nodes for the same rows — hence the key, and the
 * `old` half so the scheduled-task pass can still see which node it came from.
 */
type ClonedNodes = Map<string, { old: IWorkflowNodeEntity; new: IWorkflowNodeEntity }>;

// ---- WorkflowBuilder ----------------------------------------------------------------------------------

export class WorkflowBuilder {
    private pools = new Map<string, PoolBuilder>();
    /** The connections that CROSS two pools (excluded from every pool's own sequence flows). */
    private messageFlows: XmlEntity<WorkflowConnectionEntity>[] = [];

    private constructor(private readonly workflow: WorkflowEntity) { }

    /** Signum's `new WorkflowBuilder(wf)` — a static factory because reading the graph is async. */
    static async create(wf: WorkflowEntity): Promise<WorkflowBuilder> {
        using _prof = HeavyProfiler.log("WorkflowBuilder");
        const wb = new WorkflowBuilder(wf);

        const [connections, events, activities, gateways, poolEntities] = wf.isNew
            ? [[], [], [], [], []] as [WorkflowConnectionEntity[], WorkflowEventEntity[], WorkflowActivityEntity[], WorkflowGatewayEntity[], WorkflowPoolEntity[]]
            // NOTE these are the same sets as `wf.workflowConnections()` & friends, spelled as plain queries.
            // A `withQuoted` prototype member is QUERY-ONLY in altea: the transformer emits the quoted AST as
            // a second argument and leaves the runtime body's inner lambdas unstamped, so CALLING one directly
            // throws "The following lambda has not been quoted". Signum's [AutoExpressionField] members are
            // real C# methods and can be called either way; here the builder has to query.
            : await Promise.all([
                table(WorkflowConnectionEntity)
                    .filter(a => a.from.lane.pool.workflow.is(wf) && a.to.lane.pool.workflow.is(wf)).toArray(),
                table(WorkflowEventEntity).filter(a => a.lane.pool.workflow.is(wf)).toArray(),
                table(WorkflowActivityEntity).filter(a => a.lane.pool.workflow.is(wf)).toArray(),
                table(WorkflowGatewayEntity).filter(a => a.lane.pool.workflow.is(wf)).toArray(),
                table(WorkflowPoolEntity).filter(a => a.workflow.is(wf)).toArray(),
            ]);

        const lanes = wf.isNew ? [] as WorkflowLaneEntity[]
            : await table(WorkflowLaneEntity).filter(l => l.pool.workflow.is(wf)).toArray();

        // The boundary-timer list is not persisted (see data/WorkflowNodes.ts), so fill it here too.
        const activityByKey = new Map(activities.map(a => [a.toLite().key(), a]));
        for (const a of activities)
            a.boundaryTimers = [];
        for (const e of events)
            if (e.boundaryOf != null)
                activityByKey.get(e.boundaryOf.key())?.boundaryTimers.push(e);

        const xmlConnections = connections.map(a => new XmlEntity(a));

        for (const pool of poolEntities) {
            const laneBuilders = lanes.filter(l => l.pool.is(pool)).map(lane => new LaneBuilder(
                lane,
                activities.filter(a => a.lane.is(lane)),
                events.filter(a => a.lane.is(lane)),
                gateways.filter(a => a.lane.is(lane)),
                xmlConnections.filter(c => c.entity.from.lane.is(lane) || c.entity.to.lane.is(lane))));

            const sequenceFlows = xmlConnections
                .filter(c => c.entity.from.lane.pool.is(pool) && c.entity.to.lane.pool.is(pool));

            const pb = new PoolBuilder(pool, laneBuilders, sequenceFlows);
            wb.pools.set(pool.toLite().key(), pb);
        }

        wb.messageFlows = xmlConnections.filter(c => !c.entity.from.lane.pool.is(c.entity.to.lane.pool));

        return wb;
    }

    // ---- Reading ------------------------------------------------------------------------------------

    async getWorkflowModel(): Promise<WorkflowModel> {
        const xml = await this.getDocumentText();
        const dic = new Map<string, ModelEntity>();

        const add = (pair: [string, ModelEntity]): void => { dic.set(pair[0], pair[1]); };

        for (const pb of this.pools.values())
            add(pb.pool.toModelPair());

        const lanes = [...this.pools.values()].flatMap(pb => pb.getLanes());
        for (const lb of lanes)
            add(lb.lane.toModelPair());

        for (const a of lanes.flatMap(lb => lb.getActivities()))
            add(a.toModelPair());

        // Only START events (and intermediate timers) have a model — an end event has no extra properties.
        for (const e of lanes.flatMap(lb => lb.getEvents())
            .filter(e => isStart(e.entity.type) || e.entity.type === WorkflowEventType.IntermediateTimer)) {
            const model = e.entity.getModel() as WorkflowEventModel;
            // Signum fills `Task` inside GetModel through a static hook; altea does it here (see the header
            // of data/WorkflowNodes.ts) so the entity's getModel stays pure.
            if (isScheduledStart(e.entity.type))
                model.task = await getWorkflowEventTaskModel(e.entity);
            dic.set(e.bpmnElementId, model);
        }

        for (const mf of this.messageFlows)
            add(mf.toModelPair());

        for (const sf of [...this.pools.values()].flatMap(pb => pb.getSequenceFlows()))
            add(sf.toModelPair());

        return WorkflowModel.create({
            diagramXml: xml,
            entities: [...dic.entries()].map(([bpmnElementId, model]) =>
                BpmnEntityPairEmbedded.create({ bpmnElementId, model })),
        });
    }

    /** Signum's ParseDocument. */
    static parseDocument(diagramXml: string): XmlElement {
        return parseXmlDocument(diagramXml).root;
    }

    /** Signum's GetXDocument().ToString(). */
    async getDocumentText(): Promise<string> {
        const processes: XmlElement[] = [];
        for (const pb of this.pools.values())
            processes.push(await pb.getProcessElement());

        const root = el(BPMN + ":definitions", {
            "xmlns:bpmn": BPMN_NS,
            "xmlns:bpmndi": BPMNDI_NS,
            "xmlns:dc": DC_NS,
            "xmlns:di": DI_NS,
            "xmlns:xsi": XSI_NS,
            targetNamespace: TARGET_NAMESPACE,
        },
            el(BPMN + ":collaboration", { id: "Collaboration_" + this.workflow.id },
                [...this.pools.values()].map(a => a.getParticipantElement()),
                this.getMessageFlowElements()),
            processes,
            el(BPMNDI + ":BPMNDiagram", { id: "BPMNDiagram" + this.workflow.id },
                el(BPMNDI + ":BPMNPlane", {
                    id: "BPMNPlane_" + this.workflow.id,
                    bpmnElement: "Collaboration_" + this.workflow.id,
                }, this.getDiagramElements())));

        return `<?xml version="1.0" encoding="UTF-8"?>\n` + serializeElement(root);
    }

    private getMessageFlowElements(): XmlElement[] {
        return this.messageFlows.map(a => el(BPMN + ":messageFlow", {
            id: a.bpmnElementId,
            name: (a.entity.name ?? "") === "" ? undefined : a.entity.name,
            sourceRef: this.getBpmnElementId(a.entity.from),
            targetRef: this.getBpmnElementId(a.entity.to),
        }));
    }

    private getDiagramElements(): XmlElement[] {
        return [
            ...[...this.pools.values()].flatMap(a => a.getDiagramElements()),
            ...this.messageFlows.map(a => a.element),
        ];
    }

    private getBpmnElementId(node: IWorkflowNodeEntity): string {
        const pb = this.pools.get(node.lane.pool.toLite().key());
        if (pb == null)
            throw new Error(`Pool '${node.lane.pool}' is not in this workflow`);
        return pb.getLaneBuilder(node.lane.toLite()).getBpmnElementId(node);
    }

    findEntity(bpmnElementId: string): IWorkflowNodeEntity | null {
        return [...this.pools.values()].map(pb => pb.findEntity(bpmnElementId)).notNull().singleOrNull();
    }

    findLane(lane: WorkflowLaneEntity): LaneBuilder {
        const lb = [...this.pools.values()].flatMap(a => a.getLanes())
            .firstOrNull(l => l.lane.entity === lane || l.lane.entity.is(lane));
        if (lb == null)
            throw new Error(`Lane '${lane}' is not in this workflow`);
        return lb;
    }

    // ---- Writing ------------------------------------------------------------------------------------

    async applyChanges(model: WorkflowModel, replacements: WorkflowReplacementModel | null): Promise<void> {
        const document = WorkflowBuilder.parseDocument(model.diagramXml);

        const collaboration = document.descendantsNamed(BPMN + ":collaboration");
        const participants = new Map(collaboration.flatMap(c => c.descendantsNamed(BPMN + ":participant"))
            .map(a => [a.getAttribute("id")!, a]));
        const processElements = new Map(document.descendantsNamed(BPMN + ":process")
            .map(a => [a.getAttribute("id")!, a]));
        const plane = document.descendantsNamed(BPMNDI + ":BPMNPlane").firstOrNull();
        const diagramElements = new Map([...(plane?.elements() ?? [])]
            .map(a => [a.getAttribute("bpmnElement")!, a]));

        if (participants.size !== processElements.size)
            throw new Error(WorkflowValidationMessage.ParticipantsAndProcessesAreNotSynchronized.niceToString());

        const locator = new Locator(this, diagramElements, model, replacements);

        const messageFlows = new Map(collaboration.flatMap(c => c.descendantsNamed(BPMN + ":messageFlow"))
            .map(a => [a.getAttribute("id")!, a]));
        const oldMessageFlows = new Map(this.messageFlows.map(a => [a.bpmnElementId, a]));

        // Message flows: delete + update first (same reason as the pool's pass 1).
        await Synchronizer.synchronizeAsync(messageFlows, oldMessageFlows,
            undefined,
            async (_id, omf) => {
                this.messageFlows.remove(omf);
                await Operations.delete(omf.entity, WorkflowConnectionOperation.Delete);
            },
            async (_id, mf, omf) => { await applyConnectionXml(omf.entity, mf, locator); });

        const oldPools = new Map([...this.pools.values()].map(a => [a.pool.bpmnElementId, a]));

        await Synchronizer.synchronizeAsync(participants, oldPools,
            async (_id, pa) => {
                const wp = await applyPoolXml(WorkflowPoolEntity.create({
                    xml: WorkflowXmlEmbedded.create({}), workflow: this.workflow,
                }), pa, locator);
                const pb = new PoolBuilder(wp, [], []);
                this.pools.set(wp.toLite().key(), pb);
                await pb.applyChanges(mapGet(processElements, pa.getAttribute("processRef")!, "bpmn:process"), locator);
            },
            undefined,
            async (_id, pa, pb) => {
                await applyPoolXml(pb.pool.entity, pa, locator);
                await pb.applyChanges(mapGet(processElements, pa.getAttribute("processRef")!, "bpmn:process"), locator);
            });

        await Synchronizer.synchronizeAsync(participants, oldPools,
            undefined,
            async (_id, pb) => {
                this.pools.delete(pb.pool.entity.toLite().key());
                await pb.deleteAll(locator);
            },
            undefined);

        await Synchronizer.synchronizeAsync(messageFlows, oldMessageFlows,
            async (_id, mf) => {
                const wc = await applyConnectionXml(WorkflowConnectionEntity.create({
                    type: ConnectionType.Normal,
                    xml: WorkflowXmlEmbedded.create({}),
                }), mf, locator);
                this.messageFlows.push(new XmlEntity(wc));
            },
            undefined,
            async (_id, mf, omf) => { await applyConnectionXml(omf.entity, mf, locator); });
    }

    /** Signum's PreviewChanges — which activities would lose their case activities, and what the new nodes
     *  the user can move them to are. */
    async previewChanges(document: XmlElement, model: WorkflowModel): Promise<WorkflowReplacementModel> {
        const oldTasks = [...this.pools.values()].flatMap(p => p.getAllActivities()).map(a => a.entity);
        const oldIntermediateEvents = [...this.pools.values()]
            .flatMap(p => p.getLanes().flatMap(l => l.getEvents()))
            .filter(e => e.entity.type === WorkflowEventType.IntermediateTimer)
            .map(a => a.entity);
        const oldNodes = new Map<string, IWorkflowNodeEntity>(
            [...oldTasks, ...oldIntermediateEvents].map(n => [n.bpmnElementId, n]));

        const intermediateName = workflowEventTypes[WorkflowEventType.IntermediateTimer];
        const newNodes = new Map([...document.descendants()]
            .filter(a => activityElementNames.has(localName(a)) || localName(a) === intermediateName)
            .map(a => [a.getAttribute("id")!, a]));

        const entities = new Map(model.entities.map(a => [a.bpmnElementId, a.model]));

        const replacements: WorkflowReplacementItemEmbedded[] = [];
        for (const [key, node] of oldNodes) {
            if (newNodes.has(key))
                continue;
            if (!await mover.hasCaseActivities(node))
                continue;
            replacements.push(WorkflowReplacementItemEmbedded.create({
                oldNode: node.toLite(),
                subWorkflow: (node as WorkflowActivityEntity).subWorkflow?.workflow.toLite() ?? null,
                newNode: "",
            }));
        }

        return WorkflowReplacementModel.create({
            replacements,
            newTasks: [...newNodes.entries()].map(([key, element]) => NewTasksEmbedded.create({
                bpmnId: key,
                name: element.getAttribute("name") ?? null,
                subWorkflow: (entities.get(key) as WorkflowActivityModel | undefined)?.subWorkflow?.workflow.toLite() ?? null,
            })),
        });
    }

    /** Signum's Clone — a whole new workflow, nodes and connections, with a fresh "Copy of …" name. */
    async clone(): Promise<WorkflowEntity> {
        const newName = await findFreeCopyName(this.workflow.name);

        const newWorkflow = WorkflowEntity.create({
            name: newName,
            mainEntityType: this.workflow.mainEntityType,
            expirationDate: this.workflow.expirationDate,
        });
        newWorkflow.mainEntityStrategies = this.workflow.mainEntityStrategies
            .map(s => WorkflowEntity_MainEntityStrategy.create({ strategy: s.strategy }));
        await newWorkflow.save();

        const nodes: ClonedNodes = new Map();

        for (const pb of this.pools.values())
            await pb.clone(newWorkflow, nodes);

        for (const c of this.getAllConnections()) {
            const wc = WorkflowConnectionEntity.create({
                name: c.entity.name,
                bpmnElementId: c.bpmnElementId,
                action: c.entity.action,
                condition: c.entity.condition,
                type: c.entity.type,
                order: c.entity.order,
                xml: c.entity.xml,
                from: nodes.get(c.entity.from.toLite().key())!.new,
                to: nodes.get(c.entity.to.toLite().key())!.new,
                decisionOptionName: c.entity.decisionOptionName,
            });
            await wc.save();
        }

        for (const { old: oldNode, new: newNode } of nodes.values())
            if (oldNode instanceof WorkflowEventEntity && isScheduledStart(oldNode.type))
                await cloneScheduledTasks(oldNode, newNode as WorkflowEventEntity);

        const wb = await WorkflowBuilder.create(newWorkflow);
        newWorkflow.fullDiagramXml = WorkflowXmlEmbedded.create({ diagramXml: await wb.getDocumentText() });
        await newWorkflow.save();

        return newWorkflow;
    }

    /** Signum's Delete — the whole workflow: connections, nodes, lanes, pools, cases. */
    async deleteAll(): Promise<void> {
        await table(WorkflowConnectionEntity).filter(a => a.from.lane.pool.workflow.is(this.workflow)).executeDelete();
        await table(WorkflowConnectionEntity).filter(a => a.to.lane.pool.workflow.is(this.workflow)).executeDelete();

        for (const pb of this.pools.values())
            await pb.deleteAll(null);

        await mover.deleteCasesOfWorkflow(this.workflow);
        await this.workflow.delete();
    }

    private getAllConnections(): XmlEntity<WorkflowConnectionEntity>[] {
        return [...this.messageFlows, ...[...this.pools.values()].flatMap(p => p.getSequenceFlows())];
    }

    /** Signum's ValidateGraph — build a WorkflowNodeGraph out of the IN-MEMORY builder state and validate
     *  it, FIXING any gateway whose direction disagrees with its fan-in/fan-out. */
    async validateGraph(issuesContainer: WorkflowIssue[]): Promise<void> {
        const lanes = [...this.pools.values()].flatMap(p => p.getLanes());

        const wg = new WorkflowNodeGraph();
        wg.workflow = this.workflow;
        wg.activities = new Map(lanes.flatMap(l => l.getActivities())
            .map(a => [a.entity.toLite().key(), a.entity]));
        wg.events = new Map(lanes.flatMap(l => l.getEvents())
            .map(a => [a.entity.toLite().key(), a.entity]));
        wg.gateways = new Map(lanes.flatMap(l => l.getGateways())
            .map(a => [a.entity.toLite().key(), a.entity]));
        wg.connections = new Map(this.getAllConnections()
            .map(a => [a.entity.toLite().key(), a.entity]));
        wg.lanes = lanes.map(l => l.lane.entity);

        wg.fillGraphs();
        await wg.validate(issuesContainer, async (g, newDirection) => {
            g.direction = newDirection;
            await Operations.execute(g, WorkflowGatewayOperation.Save);
        }, async e => {
            const task = await getWorkflowEventTaskModel(e);
            return {
                hasSchedule: task != null,
                hasTask: task != null,
                conditionMissing: task != null && task.triggeredOn !== 0 && task.condition == null,
            };
        });
    }
}

// ---- applyXml (Signum's NodeEntityExtensions) ----------------------------------------------------------

async function applyPoolXml(wp: WorkflowPoolEntity, participant: XmlElement, locator: Locator): Promise<WorkflowPoolEntity> {
    const bpmnElementId = participant.getAttribute("id")!;
    const model = locator.getModelEntity<WorkflowPoolModel>(bpmnElementId);
    if (model != null)
        wp.setModel(model);
    wp.bpmnElementId = bpmnElementId;
    wp.name = participant.getAttribute("name")!;
    wp.xml.diagramXml = serializeElement(locator.getDiagram(bpmnElementId));
    if (isGraphModified(wp))
        await Operations.execute(wp, WorkflowPoolOperation.Save);
    return wp;
}

async function applyLaneXml(wl: WorkflowLaneEntity, lane: XmlElement, locator: Locator): Promise<WorkflowLaneEntity> {
    const bpmnElementId = lane.getAttribute("id")!;
    const model = locator.getModelEntity<WorkflowLaneModel>(bpmnElementId);
    if (model != null)
        wl.setModel(model);
    wl.bpmnElementId = bpmnElementId;
    wl.name = lane.getAttribute("name")!;
    wl.xml.diagramXml = serializeElement(locator.getDiagram(bpmnElementId));
    if (isGraphModified(wl))
        await Operations.execute(wl, WorkflowLaneOperation.Save);
    return wl;
}

async function applyEventXml(we: WorkflowEventEntity, event: XmlElement, locator: Locator): Promise<WorkflowEventEntity> {
    const bpmnElementId = event.getAttribute("id")!;
    we.bpmnElementId = bpmnElementId;
    const model = locator.getModelEntity<WorkflowEventModel>(bpmnElementId);
    if (model != null)
        we.setModel(model);
    else {
        we.name = event.getAttribute("name") ?? null;
        we.type = eventTypeOf(localName(event));
    }

    we.xml.diagramXml = serializeElement(locator.getDiagram(bpmnElementId));

    if (isGraphModified(we))
        await Operations.execute(we, WorkflowEventOperation.Save);

    if (model != null)
        await applyWorkflowEventTaskModel(we, model.task);

    return we;
}

async function applyActivityXml(wa: WorkflowActivityEntity, activity: XmlElement, locator: Locator,
    currentEvents: Map<string, XmlEntity<WorkflowEventEntity>>): Promise<WorkflowActivityEntity> {

    const bpmnElementId = activity.getAttribute("id")!;
    const model = locator.getModelEntity<WorkflowActivityModel>(bpmnElementId);
    if (model != null) {
        wa.setModel(model);

        // The boundary timers Signum synchronizes through its virtual MList; altea saves them itself (they
        // are first-class events pointing back at the activity — see data/WorkflowNodes.ts).
        const oldTimers = new Map(wa.boundaryTimers.map(a => [a.bpmnElementId, a]));
        const timers = new Map(model.boundaryTimers.map(a => [a.bpmnElementId, a]));

        await Synchronizer.synchronizeAsync(timers, oldTimers,
            async (id, m) => {
                const we = WorkflowEventEntity.create({
                    name: m.name,
                    lane: wa.lane,
                    bpmnElementId: id,
                    xml: WorkflowXmlEmbedded.create({ diagramXml: serializeElement(locator.getDiagram(id)) }),
                    type: m.type,
                    timer: m.timer,
                    runRepeatedly: m.runRepeatedly,
                    decisionOptionName: m.decisionOptionName,
                });
                wa.boundaryTimers.push(we);
                currentEvents.set(id, new XmlEntity(we));
            },
            async (id, e) => {
                wa.boundaryTimers.remove(e);
                currentEvents.delete(id);
                await Operations.delete(e, WorkflowEventOperation.Delete);
            },
            async (id, m, e) => {
                e.xml.diagramXml = serializeElement(locator.getDiagram(id));
                e.setModel(m);
            });
    }

    wa.bpmnElementId = bpmnElementId;
    wa.name = activity.getAttribute("name") ?? bpmnElementId;
    wa.xml.diagramXml = serializeElement(locator.getDiagram(bpmnElementId));
    if (isGraphModified(wa))
        await Operations.execute(wa, WorkflowActivityOperation.Save);

    // The activity must exist before a boundary event can point at it, so the timers are saved after.
    for (const t of wa.boundaryTimers) {
        t.boundaryOf = wa.toLite();
        if (isGraphModified(t))
            await Operations.execute(t, WorkflowEventOperation.Save);
    }

    return wa;
}

async function applyGatewayXml(wg: WorkflowGatewayEntity, gateway: XmlElement, locator: Locator): Promise<WorkflowGatewayEntity> {
    const bpmnElementId = gateway.getAttribute("id")!;
    wg.bpmnElementId = bpmnElementId;
    wg.name = gateway.getAttribute("name") ?? null;
    wg.type = gatewayTypeOf(localName(gateway));
    wg.xml.diagramXml = serializeElement(locator.getDiagram(bpmnElementId));
    if (isGraphModified(wg))
        await Operations.execute(wg, WorkflowGatewayOperation.Save);
    return wg;
}

async function applyConnectionXml(wc: WorkflowConnectionEntity, flow: XmlElement, locator: Locator): Promise<WorkflowConnectionEntity> {
    wc.from = locator.findEntity(flow.getAttribute("sourceRef")!)!;
    wc.to = locator.findEntity(flow.getAttribute("targetRef")!)!;

    const bpmnElementId = flow.getAttribute("id")!;
    const model = locator.getModelEntity<WorkflowConnectionModel>(bpmnElementId);
    if (model != null)
        wc.setModel(model);
    wc.bpmnElementId = bpmnElementId;

    let name = flow.getAttribute("name") ?? null;
    if (name != null)
        name = name.tryBeforeLast(":") ?? name;

    // Signum shows an Exclusive split's evaluation order INSIDE the connection's label ("name: 3").
    if (model?.order != null)
        name = name + ": " + model.order;

    wc.name = name;
    wc.xml.diagramXml = serializeElement(locator.getDiagram(bpmnElementId));

    const gateway = wc.from instanceof WorkflowGatewayEntity ? wc.from : null;

    if (gateway == null || gateway.type !== WorkflowGatewayType.Exclusive)
        wc.order = null;

    if (gateway == null || gateway.type === WorkflowGatewayType.Parallel)
        wc.condition = null;

    if (isGraphModified(wc))
        await Operations.execute(wc, WorkflowConnectionOperation.Save);

    return wc;
}

/** Signum's LaneBuilder.MoveCasesAndDelete — the replacement the user picked, or a plain delete. */
async function moveCasesAndDelete(node: IWorkflowNodeEntity, locator: Locator): Promise<void> {
    if (await mover.hasCaseActivities(node)) {
        if (locator.hasReplacement(node.toLite())) {
            const replacement = locator.getReplacement(node.toLite())!;
            await mover.moveCaseActivities(node, replacement);
        }
        else
            await mover.deleteCaseActivities(node);
    }

    if (node instanceof WorkflowActivityEntity)
        await Operations.delete(node, WorkflowActivityOperation.Delete);
    else
        await Operations.delete(node as WorkflowEventEntity, WorkflowEventOperation.Delete);
}

// ---- Small helpers ------------------------------------------------------------------------------------

function localName(e: XmlElement): string {
    return e.localName;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key);
    if (list == null)
        map.set(key, [value]);
    else
        list.push(value);
}

function sameNode(a: IWorkflowNodeEntity | null, b: IWorkflowNodeEntity | null): boolean {
    return a === b || (a != null && b != null && a.is(b));
}

function eventTypeOf(elementName: string): WorkflowEventType {
    const entry = (Object.entries(workflowEventTypes) as [string, string][])
        .firstOrNull(([, name]) => name === elementName);
    if (entry == null)
        throw new Error("Unexpected BPMN event element " + elementName);
    return Number(entry[0]) as WorkflowEventType;
}

function gatewayTypeOf(elementName: string): WorkflowGatewayType {
    const entry = (Object.entries(workflowGatewayTypes) as [string, string][])
        .single(([, name]) => name === elementName);
    return Number(entry[0]) as WorkflowGatewayType;
}

async function findFreeCopyName(name: string): Promise<string> {
    for (let i = 0; i < 1000; i++) {
        const candidate = `Copy${i === 0 ? "" : ` (${i})`} of ${name}`;
        if (!await table(WorkflowEntity).some(w => w.name === candidate))
            return candidate;
    }
    throw new Error("Impossible to find a free name for a copy of " + name);
}

/** A Map lookup that FAILS LOUDLY (Signum's Dictionary.GetOrThrow). */
function mapGet<V>(map: Map<string, V>, key: string, what: string): V {
    const value = map.get(key);
    if (value == null)
        throw new Error(`${what} '${key}' not found`);
    return value;
}
