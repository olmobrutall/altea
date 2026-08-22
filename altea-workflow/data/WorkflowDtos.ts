import { Lite } from "@altea/altea/data/lite";
import { Temporal, type int, type uuid } from "@altea/altea/data/basics";
import type { FilterRequest, ColumnRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import type { IUserEntity } from "@altea/altea/data/security";
import type { EntityPack } from "@altea/altea/data/entityPack";
import { WorkflowEntity, WorkflowIssueType, type IWorkflowNodeEntity } from "./Workflow";
import type {
    ConnectionType, WorkflowActivityEntity, WorkflowActivityType, WorkflowConnectionEntity, WorkflowEventType,
} from "./WorkflowNodes";
import type { CaseActivityEntity, DoneType } from "./CaseActivity";
import type { CaseEntity, ICaseMainEntity } from "./Case";

// The module's WIRE DTOs — the shapes that cross /api/workflow/* but are not entities: workflow issues, the
// case-flow diagram, the activity monitor and the script runner's state.
//
// altea keeps them in data/ (declared ONCE, used by both the routes and the client) rather than in Signum's
// two places — the C# class in the logic layer and a hand-written `interface` in WorkflowClient.tsx — which is
// the convention @altea/altea-omnibox established. Two consequences:
//
//  - the enum members are the ORDINAL, not Signum's string name: both tiers import the same enum object, so
//    a name↔ordinal conversion in every DTO builder would buy nothing. Compare with `DoneType.Jump`.
//  - `DateTime` fields are `Temporal.PlainDateTime`, serialized as their ISO string by the route.

/** Signum's WorkflowIssue — one problem found while validating a diagram, anchored to a bpmn element. */
export interface WorkflowIssue {
    type: WorkflowIssueType;
    bpmnElementId: string | null;
    message: string;
}

// ---- Case flow ------------------------------------------------------------------------------------------

/** One case activity as the case-flow diagram needs it: where it was, how long it took, and how it ended. */
export interface CaseActivityStats {
    caseActivity: Lite<CaseActivityEntity>;
    previousActivity: Lite<CaseActivityEntity> | null;
    workflowActivity: Lite<IWorkflowNodeEntity>;
    workflowActivityType: WorkflowActivityType | null;
    workflowEventType: WorkflowEventType | null;
    subWorkflow: Lite<WorkflowEntity> | null;
    notifications: int;
    startDate: string;
    doneDate: string | null;
    doneType: DoneType | null;
    doneDecision: string | null;
    doneBy: Lite<IUserEntity> | null;
    duration: number | null;
    averageDuration: number | null;
    estimatedDuration: number | null;
    bpmnElementId: string;
}

/** One traversal of a connection (or, when `bpmnElementId` is null, a JUMP the diagram has to draw itself). */
export interface CaseConnectionStats {
    connection: Lite<WorkflowConnectionEntity> | null;
    doneDate: string | null;
    doneBy: Lite<IUserEntity> | null;
    doneType: DoneType | null;
    doneDecision: string | null;
    bpmnElementId: string | null;
    fromBpmnElementId: string | null;
    toBpmnElementId: string | null;
}

export interface CaseFlow {
    activities: { [bpmnElementId: string]: CaseActivityStats[] };
    connections: { [bpmnElementId: string]: CaseConnectionStats[] };
    jumps: CaseConnectionStats[];
    allNodes: string[];
}

// ---- Activity monitor -----------------------------------------------------------------------------------

export interface WorkflowActivityMonitorRequest {
    workflow: Lite<WorkflowEntity>;
    /** Filters over the CASE (they are applied to the CaseActivity query through `Entity.Case`). */
    filters: FilterRequest[];
    /** Aggregate columns over the CASE ACTIVITY — the monitor rejects anything that is not an aggregate. */
    columns: ColumnRequest[];
}

export interface WorkflowActivityStats {
    workflowActivity: Lite<IWorkflowNodeEntity>;
    caseActivityCount: int;
    customValues: unknown[];
}

export interface WorkflowActivityMonitor {
    workflow: Lite<WorkflowEntity>;
    customColumns: string[];
    activities: WorkflowActivityStats[];
}

// ---- Script runner --------------------------------------------------------------------------------------

export interface WorkflowScriptRunnerState {
    running: boolean;
    initialDelayMilliseconds: number | null;
    scriptRunnerPeriod: int;
    isCancelationRequested: boolean;
    nextPlannedExecution: string | null;
    queuedItems: number;
    currentProcessIdentifier: uuid;
}

// ---- Route request/response shapes ----------------------------------------------------------------------

export interface WorkflowFindNodeRequest {
    workflowId: string;
    subString: string;
    count: int;
    excludes?: Lite<IWorkflowNodeEntity>[];
}

export interface NextConnectionsRequest {
    workflowActivity: Lite<WorkflowActivityEntity>;
    connectionType: ConnectionType;
}

export interface CaseActivityMainEntityPair {
    caseActivity: Lite<CaseActivityEntity>;
    mainEntity: Lite<ICaseMainEntity>;
}

/** What `/api/workflow/fetchForViewing` answers: the activity plus the two canExecute maps a case frame needs
 *  (its own operations, and the main entity's). */
export interface CaseEntityPack {
    activity: CaseActivityEntity;
    canExecuteActivity: { [operationKey: string]: string };
    canExecuteMainEntity: { [operationKey: string]: string };
}

export interface CaseFlowEntityPack {
    pack: EntityPack<CaseEntity>;
    workflowActivity: IWorkflowNodeEntity;
}

/** The workflow designer's initial GET: the model plus whatever the validator already complains about. */
export interface WorkflowModelAndIssues {
    model: import("./Workflow").WorkflowModel;
    issues: WorkflowIssue[];
}

/** What a workflow SAVE answers — the entity pack plus the (non-fatal) issues the validator found. */
export interface EntityPackWithIssues {
    entityPack: EntityPack<WorkflowEntity>;
    issues: WorkflowIssue[];
}

/** Unused by the engine but part of the module's vocabulary — Signum's `DecisionResultValues`. */
export const DecisionResultValues: string[] = ["Approve", "Decline"];

/** A Temporal.PlainDateTime as it crosses the wire (an ISO string), for the DTOs above. */
export function toIsoOrNull(value: Temporal.PlainDateTime | null | undefined): string | null {
    return value == null ? null : value.toString();
}
