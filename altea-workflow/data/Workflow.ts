import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Enum } from "@altea/altea/data/enum";
import {
    entity, implementedBy, primaryKey, uniqueIndex, index, unit, serialize,
    stringLengthValidator, backReference, rowOrder, valueField,
} from "@altea/altea/data/decorators";
import { Temporal, type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { registerEnum } from "@altea/altea/data/registration";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { type IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
// A real (value) import of the node module, which imports THIS one back. The cycle is safe because every
// use below is inside an `@implementedBy` THUNK, evaluated at schema-build / deserialize time — long after
// both modules have finished evaluating. Signum has no such problem: its whole entity model is one
// assembly, and the generated client twin is one file.
import {
    WorkflowActivityEntity, WorkflowActivityModel, WorkflowConnectionModel, WorkflowEventEntity,
    WorkflowEventModel, WorkflowGatewayModel, WorkflowLaneModel, WorkflowPoolModel, type WorkflowLaneEntity,
} from "./WorkflowNodes";

// Port of Signum.Workflow's Workflow.cs (+ WorkflowConfiguration.cs) — the ROOT of the module's model. A
// WORKFLOW is a BPMN diagram, stored twice over: once as ENTITIES (the pools / lanes / activities / events /
// gateways / connections of WorkflowNodes.ts, each carrying the one `<bpmndi:…>` element that draws it), and
// once as the whole `fullDiagramXml` blob, which is redundant and exists only so the diff log can show what
// a save changed. `WorkflowModel` is the round-trip DTO the designer posts back: the diagram XML plus one
// MODEL per bpmn element id.
//
// altea divergences that apply to the WHOLE module, documented once here:
//
//  - **Evals become SYMBOLS.** Signum lets an administrator TYPE C# into a workflow condition / action /
//    script / lane-actors / sub-entities / event-task box and compiles it with Roslyn (Signum.Eval). altea's
//    counterpart is @altea/altea-eval, which stores TYPESCRIPT and compiles it with the TypeScript compiler,
//    so all eight `EvalEmbedded<T>` subclasses port as such — each one lives beside the entity that owns it,
//    and the eight FUNCTION types they are parameterized by live together in WorkflowEval.ts (Signum's eight
//    `IXEvaluator` interfaces).
//    Two consequences of altea-eval's design show up here: an eval's OWNER is bound by
//    `sb.include(Owner).withEvals()` rather than by Signum's `[BindParent]`, and a generated wrapper's
//    signature is written by the eval's own `compile()` (which is where each one reads the main entity type).
//
//  - **`Guid Guid` → a uuid PRIMARY KEY.** Every IUserAssetEntity here follows the convention
//    @altea/altea-user-queries set: `@primaryKey("uuid")`, no separate `guid` field, and the `id` IS the
//    portable identity XML export/import uses.
//
//  - **`DateTime` → `Temporal.PlainDateTime`** throughout (server-local wall clock, as in altea-scheduler).
//
//  - **`MList<T>` → a plain array of `@part` rows**, so `MList<WorkflowMainEntityStrategy>` becomes
//    `WorkflowEntity_MainEntityStrategy[]` carrying the enum on its `@valueField`, and `MList<Lite<Entity>>
//    Actors` likewise. A MODEL keeps plain arrays: it is never persisted, so it needs no row entity.
//
//  - Signum's message / validation enums become `msg()` containers.

// ---- Configuration --------------------------------------------------------------------------------------

// Signum's WorkflowConfigurationEmbedded — the app hands it to WorkflowLogic.start (eastwind keeps it on its
// ApplicationConfigurationEntity, as Southwind does).
@reflect
export class WorkflowConfigurationEmbedded extends EmbeddedEntity {

    @unit("sec")
    scriptRunnerPeriod: int = toInt(5 * 60);

    @unit("hrs")
    avoidExecutingScriptsOlderThan: number | null;

    chunkSizeRunningScripts: int = toInt(100);
}

// ---- The workflow ---------------------------------------------------------------------------------------

// altea enum convention: a numeric TS enum, no string-union alias. The in-memory value is the ORDINAL
// (the wire value is the member name — EnumSerializer converts), so comparisons read
// `WorkflowMainEntityStrategy.CreateNew`, exactly as Signum's C# does.
export enum WorkflowMainEntityStrategy {
    CreateNew,
    SelectByUser,
    Clone,
}
registerEnum(WorkflowMainEntityStrategy);

export enum WorkflowIssueType {
    Warning,
    Error,
}
registerEnum(WorkflowIssueType);

/** Signum's `MList<WorkflowMainEntityStrategy>` as this owner's `@part` row (altea has no MList; a
 *  collection of scalars is a row carrying the value on its `@valueField`). */
@reflect
@entity("Part", "Master")
export class WorkflowEntity_MainEntityStrategy extends Entity {
    @backReference workflow: Lite<WorkflowEntity>;
    @rowOrder order: int;

    @valueField strategy: WorkflowMainEntityStrategy;

    toString(): string {
        return Enum.niceName(WorkflowMainEntityStrategy, this.strategy);
    }
}

@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class WorkflowEntity extends Entity implements IUserAssetEntity {

    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    mainEntityType: TypeEntity;

    mainEntityStrategies: WorkflowEntity_MainEntityStrategy[];

    @index
    expirationDate: Temporal.PlainDateTime | null;

    /**
     * REDUNDANT — only for diff logging. Signum marks it `[InTypeScript(false), AvoidDump]`; altea's
     * counterparts are `@serialize(false)` (the designer round-trips the diagram through WorkflowModel, so
     * the client never needs this second copy) and `ObjectDumper.avoidDump`, registered in WorkflowLogic.
     */
    @serialize(false)
    fullDiagramXml: WorkflowXmlEmbedded | null;

    toString(): string {
        return this.name;
    }
}

export namespace WorkflowOperation {
    export const Create: ConstructSymbol<WorkflowEntity> = init();
    export const Clone: ConstructSymbol<WorkflowEntity, From<WorkflowEntity>> = init();
    export const Save: ExecuteSymbol<WorkflowEntity> = init();
    export const Delete: DeleteSymbol<WorkflowEntity> = init();
    export const Activate: ExecuteSymbol<WorkflowEntity> = init();
    export const Deactivate: ExecuteSymbol<WorkflowEntity> = init();
}

// ---- The diagram XML ------------------------------------------------------------------------------------

/** One element of BPMN diagram interchange (`<bpmndi:BPMNShape>` / `<bpmndi:BPMNEdge>`), verbatim. Every
 *  workflow object owns the XML that draws it, so the diagram survives a designer round-trip untouched. */
@reflect
export class WorkflowXmlEmbedded extends EmbeddedEntity {
    @stringLengthValidator({ min: 3, multiLine: true })
    diagramXml: string;
}

/** Signum's IWorkflowObjectEntity — anything in a workflow that has a bpmn element id and its own diagram
 *  XML (a pool, a lane, a node, a connection). */
export interface IWorkflowObjectEntity extends Entity {
    xml: WorkflowXmlEmbedded;
    bpmnElementId: string;
    getName(): string | null;
}

/** Signum's IWorkflowNodeEntity — a workflow object that sits in a LANE (activity, event, gateway). */
export interface IWorkflowNodeEntity extends IWorkflowObjectEntity {
    lane: WorkflowLaneEntity;
}

/** Signum's IWithModel — an entity the BPMN designer edits through a ModelEntity round-trip. */
export interface IWithModel {
    getModel(): ModelEntity;
    setModel(model: ModelEntity): void;
}

// ---- The designer round-trip ----------------------------------------------------------------------------

/** Signum's WorkflowModel — what the designer POSTs back: the whole diagram XML plus, for every bpmn
 *  element that has non-diagram properties, the model carrying them. */
@reflect
export class WorkflowModel extends ModelEntity {
    diagramXml: string;

    entities: BpmnEntityPairEmbedded[];
}

/**
 * One `bpmnElementId → model` pair of a WorkflowModel.
 *
 * Signum writes `[ImplementedBy()]` — an EMPTY list — on `model`, because the pair is never persisted and
 * its polymorphism is resolved by the JSON type discriminator alone. altea needs no attribute at all: a
 * field declared as the ABSTRACT `ModelEntity` gets the serializer's DYNAMIC dispatch (it writes and reads
 * the concrete type's `$type`), which is the same contract — see graphSerializers.elementSerializer.
 */
@reflect
export class BpmnEntityPairEmbedded extends EmbeddedEntity {
    model: ModelEntity;

    bpmnElementId: string;

    toString(): string {
        return `${this.bpmnElementId} -> ${this.model}`;
    }
}

/** Signum's WorkflowReplacementModel — when a save DELETES an activity that still has case activities, the
 *  user must say which surviving node each one moves to. */
@reflect
export class WorkflowReplacementModel extends ModelEntity {
    replacements: WorkflowReplacementItemEmbedded[];

    newTasks: NewTasksEmbedded[];

    toString(): string {
        return WorkflowReplacementModel.nicePropertyName(a => a.replacements) + ": " + this.replacements.length;
    }
}

@reflect
export class NewTasksEmbedded extends EmbeddedEntity {
    bpmnId: string;
    name: string | null;
    subWorkflow: Lite<WorkflowEntity> | null;
}

@reflect
export class WorkflowReplacementItemEmbedded extends EmbeddedEntity {
    @implementedBy(() => [WorkflowActivityEntity, WorkflowEventEntity])
    oldNode: Lite<IWorkflowNodeEntity>;

    subWorkflow: Lite<WorkflowEntity> | null;

    /** The bpmn element id of the node the old one's case activities move to. */
    newNode: string;
}

// ---- Permissions ----------------------------------------------------------------------------------------

export namespace WorkflowPermission {
    export const ViewWorkflowPanel: PermissionSymbol = init();
    export const ViewCaseFlow: PermissionSymbol = init();
    export const WorkflowToolbarMenu: PermissionSymbol = init();
}

// ---- Messages -------------------------------------------------------------------------------------------

export const WorkflowMessage = {
    _0BelongsToADifferentWorkflow: msg("'{0}' belongs to a different workflow"),
    Condition0IsDefinedFor1Not2: msg("Condition '{0}' is defined for '{1}' not '{2}'"),
    JumpsToSameActivityNotAllowed: msg(),
    JumpTo0FailedBecause1: msg("Jump to '{0}' failed because '{1}'"),
    ToUse0YouSouldSaveWorkflow: msg("To use '{0}', you should save workflow"),
    ToUseNewNodesOnJumpsYouSouldSaveWorkflow: msg("To use new nodes on jumps, you should save workflow"),
    ToUse0YouSouldSetTheWorkflow1: msg("To use '{0}', you should set the workflow '{1}'"),
    ChangeWorkflowMainEntityTypeIsNotAllowedBecauseWeHaveNodesThatUseIt:
        msg("Change workflow main entity type is not allowed because we have nodes that use it."),
    WorkflowUsedIn0ForDecompositionOrCallWorkflow: msg("Workflow uses in {0} for decomposition or call workflow."),
    Workflow0AlreadyActivated: msg("Workflow '{0}' already activated."),
    Workflow0HasExpiredOn1: msg("Workflow '{0}' has expired on '{1}'."),
    HasExpired: msg(),
    DeactivateWorkflow: msg(),
    PleaseChooseExpirationDate: msg(),
    ResetZoom: msg(),
    Color: msg("Color: "),
    WorkflowIssues: msg("Workflow Issues"),
    WorkflowProperties: msg(),
    _0NotAllowedFor1NoConstructorHasBeenDefinedInWithWorkflow:
        msg("{0} not allowed for {1} (no constructor has been defined in 'withWorkflow')"),
    YouAreNotMemberOfAnyLaneContainingAnStartEventInWorkflow0:
        msg("You are not member of any lane containing an Start event in workflow '{0}'"),
    EvaluationOrderOfTheConnectionForIfElse: msg("Evaluation order of the contition (if... else)"),
    SaveAsSVG: msg("Save as SVG"),
    _0Operations: msg("{0} operations"),
};

export const WorkflowValidationMessage = {
    NodeType0WithId1IsInvalid: msg("Node type {0} with Id {1} is invalid."),
    ParticipantsAndProcessesAreNotSynchronized: msg("Participants and Processes are not synchronized."),
    MultipleStartEventsAreNotAllowed: msg("Multiple start events are not allowed."),
    SomeStartEventIsRequired: msg("Start event is required. Each workflow could have one and only one start event."),
    NormalStartEventIsRequiredWhenThe0Are1Or2: msg("Normal start event is required when the '{0}' are '{1}' or '{2}'."),
    TheFollowingTasksAreGoingToBeDeleted: msg("The following tasks are going to be deleted :"),
    FinishEventIsRequired: msg(),
    _0HasInputs: msg("'{0}' has inputs."),
    _0HasOutputs: msg("'{0}' has outputs."),
    _0HasNoInputs: msg("'{0}' has no inputs."),
    _0HasNoOutputs: msg("'{0}' has no outputs."),
    _0HasJustOneInputAndOneOutput: msg("'{0}' has just one input and one output."),
    _0HasMultipleOutputs: msg("'{0}' has multiple outputs."),
    IsNotInWorkflow: msg(),
    Activity0CanNotJumpTo1Because2: msg("Activity '{0}' can not jump to '{1}' because '{2}'."),
    Activity0CanNotTimeoutTo1Because2: msg("Activity '{0}' can not timeout to '{1}' because '{2}'."),
    IsStart: msg(),
    IsSelfJumping: msg(),
    IsInDifferentParallelTrack: msg(),
    _0Track1CanNotBeConnectedTo2Track3InsteadOfTrack4:
        msg("'{0}' (Track {1}) can not be connected to '{2}' (Track {3} instead of Track {4})."),
    StartEventNextNodeShouldBeAnActivity: msg(),
    ParallelGatewaysShouldPair: msg(),
    TimerOrConditionalStartEventsCanNotGoToJoinGateways: msg(),
    InclusiveGateway0ShouldHaveOneConnectionWithoutCondition:
        msg("Inclusive Gateway '{0}' should have one default connection without condition."),
    Gateway0ShouldHasConditionOrDecisionOnEachOutputExceptTheLast:
        msg("Gateway '{0}' should has condition or decision on each output except the last one."),
    _0CanNotBeConnectedToAParallelJoinBecauseHasNoPreviousParallelSplit:
        msg("'{0}' can not be connected to a parallel join because has no previous parallel split."),
    Activity0WithDecisionTypeShouldGoToAnExclusiveOrInclusiveGateways:
        msg("Activity '{0}' with decision type should go to an exclusive or inclusive gateways."),
    Activity0ShouldBeDecision: msg("Activity '{0}' should be decision."),
    _0IsTimerStartAndSchedulerIsMandatory: msg("'{0}' is timer start and scheduler is mandatory."),
    _0IsTimerStartAndTaskIsMandatory: msg("'{0}' is timer start and task is mandatory."),
    _0IsConditionalStartAndTaskConditionIsMandatory: msg("'{0}' is conditional start and condition is mandatory."),
    DelayActivitiesShouldHaveExactlyOneInterruptingTimer: msg(),
    Activity0OfType1ShouldHaveExactlyOneConnectionOfType2:
        msg("Activity '{0}' of type '{1}' should have exactly one connection of type '{2}'."),
    Activity0OfType1CanNotHaveConnectionsOfType2:
        msg("Activity '{0}' of type '{1}' can not have connections of type '{2}'."),
    BoundaryTimer0OfActivity1ShouldHaveExactlyOneConnectionOfType2:
        msg("Boundary timer '{0}' of activity '{1}' should have exactly one connection of type '{2}'."),
    IntermediateTimer0ShouldHaveOneOutputOfType1: msg("Intermediate timer '{0}' should have one output of type '{1}'."),
    IntermediateTimer0ShouldHaveName: msg("Intermediate timer '{0}' should have name."),
    ParallelSplit0ShouldHaveAtLeastOneConnection: msg("Parallel Split '{0}' should have at least one connection."),
    ParallelSplit0ShouldHaveOnlyNormalConnectionsWithoutConditions:
        msg("Parallel Split '{0}' should have only normal connections without conditions."),
    Join0OfType1DoesNotMatchWithItsPairTheSplit2OfType3:
        msg("Join '{0}' (of type {1}) does not match with its pair, the Split '{2}' (of type {3})"),
    DecisionOption0IsDeclaredButNeverUsedInAConnection:
        msg("Decision option '{0}' is declared but never used in a connection"),
    DecisionOptionName0IsNotDeclaredInAnyActivity:
        msg("Decision option name '{0}' is not declared in any activity"),
    BoundaryTimer0OfActivity1CanNotHave2BecauseActivityIsNot3:
        msg("Boundary timer '{0}' of activity '{1}' can not have {2} because activity is not {3}"),
    BoundaryTimer0OfActivity1ShouldHave2BecauseActivityIs3:
        msg("Boundary timer '{0}' of activity '{1}' should have {2} because activity is {3}"),
    BoundaryTimer0OfActivity1HasInvalid23: msg("Boundary timer '{0}' of activity '{1}' has invalid {2}: '{3}'"),
};

export const WorkflowActivityMonitorMessage = {
    WorkflowActivityMonitor: msg(),
    Draw: msg(),
    ResetZoom: msg(),
    Find: msg(),
    Filters: msg(),
    Columns: msg(),
    OpenWorkflow: msg(),
};
