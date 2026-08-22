import { BootstrapStyle, WorkflowActivityModel, WorkflowConnectionModel, ConnectionType } from "../../data/WorkflowNodes";
import type { WorkflowEntitiesDictionary } from "../WorkflowEntitiesDictionary";

// Port of Signum.Workflow's Bpmn/BpmnUtils.tsx — the "what kind of BPMN element is this?" predicates the
// designer branches on, plus the decision-button color lookup.

export function isEvent(elementType: BPMN.ElementType): boolean {
    return elementType === "bpmn:StartEvent"
        || elementType === "bpmn:EndEvent";
}

export function isTaskAnyKind(elementType: BPMN.ElementType): boolean {
    return elementType === "bpmn:Task"
        || elementType === "bpmn:UserTask"
        || elementType === "bpmn:CallActivity"
        || elementType === "bpmn:ScriptTask";
}

export function isGatewayAnyKind(elementType: BPMN.ElementType): boolean {
    return elementType === "bpmn:ExclusiveGateway"
        || elementType === "bpmn:InclusiveGateway"
        || elementType === "bpmn:ParallelGateway";
}

export function isConnection(elementType: BPMN.ElementType): boolean {
    return elementType === "bpmn:SequenceFlow"
        || elementType === "bpmn:MessageFlow";
}

/**
 * A Decision connection is drawn in the color of the button it is the answer to — which lives on the
 * ACTIVITY feeding the gateway, so the lookup walks back one hop.
 */
export function findDecisionStyle(con: BPMN.Connection, entities: WorkflowEntitiesDictionary): BootstrapStyle | undefined {
    const mod = entities[con.id] as WorkflowConnectionModel | undefined;
    if (mod == null || mod.type !== ConnectionType.Decision)
        return undefined;

    const gateway = (con.businessObject as BPMN.ConnectionModdleElemnet).sourceRef;

    const activities = (gateway.incoming ?? [])
        .filter(c => c.sourceRef.$type === "bpmn:Task" || c.sourceRef.$type === "bpmn:UserTask")
        .map(c => entities[c.sourceRef.id] as WorkflowActivityModel | undefined);

    const option = activities.notNull()
        .flatMap(a => a.decisionOptions)
        .firstOrNull(o => o.name === mod.decisionOptionName);

    return option?.style;
}
