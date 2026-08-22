import "@altea/altea/data/globals/arrayExtensions";
import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Enum } from "@altea/altea/data/enum";
import {
    entity, implementedBy, forceNullable, column, unit, stringLengthValidator, fieldValidation,
    backReference, rowOrder, valueField, quoted, uniqueIndex,
} from "@altea/altea/data/decorators";
import { noRepeatValidator, ValidationMessage, ComparisonType } from "@altea/altea/data/validators";
import { Temporal, type int } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { registerEnum } from "@altea/altea/data/registration";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import {
    WorkflowEntity, WorkflowXmlEmbedded, type IWorkflowNodeEntity, type IWorkflowObjectEntity, type IWithModel,
} from "./Workflow";
import { WorkflowLaneActorsSymbol, WorkflowSubEntitiesSymbol } from "./WorkflowEval";
import { WorkflowConditionEntity } from "./WorkflowCondition";
import { WorkflowActionEntity } from "./WorkflowAction";
import { WorkflowTimerConditionEntity } from "./WorkflowTimerCondition";
import { WorkflowScriptEntity, WorkflowScriptRetryStrategyEntity } from "./WorkflowScript";
// A value import, and a real ESM cycle: WorkflowEventTask.ts needs `WorkflowEventEntity` from here, and
// `WorkflowEventModel.task` needs its model. It is safe for the same reason Workflow.ts's cycle is — nothing
// dereferences the other module at evaluation time (the transformer emits a `() => WorkflowEventTaskModel`
// thunk for the field type) — but `import type` is NOT an option: the transformer needs the runtime binding.
import { WorkflowEventTaskModel } from "./WorkflowEventTask";

// Port of Signum.Workflow's WorkflowPool.cs + WorkflowLane.cs + WorkflowActivity.cs + WorkflowEvent.cs +
// WorkflowGateway.cs + WorkflowConnection.cs — the BPMN graph itself, plus the MODEL each node round-trips
// through when the designer edits it.
//
// altea divergence — ONE file where Signum has six: the six node kinds are mutually recursive (a lane knows
// its pool, an activity knows its lane, an event knows the activity it is a boundary of, an activity knows
// its boundary events, a connection knows both endpoints), so splitting them per Signum file would mean an
// ESM import cycle that DOES bite: `extends` and the `@entity` decorators run at module-evaluation time.
// Signum has no such constraint — its model is one assembly and its generated client twin is one file.
//
// Two more divergences, both explained where they appear:
//  - `WorkflowLaneActorsEval` / `SubEntitiesEval` (compiled C#) → symbol fields (see WorkflowEval.ts).
//  - `WorkflowActivityEntity.BoundaryTimers` was a Signum VIRTUAL MList; altea has none, so it becomes a
//    non-persisted list the module maintains itself.

// ---- Pool -----------------------------------------------------------------------------------------------

// Signum's `.WithUniqueIndex(wp => new { wp.Workflow, wp.Name })` — altea declares a COMPOSITE index on
// the entity itself rather than on the include.
@reflect
@uniqueIndex<WorkflowPoolEntity>(p => [p.workflow, p.name])
@entity("String", "Master")
export class WorkflowPoolEntity extends Entity implements IWorkflowObjectEntity, IWithModel {

    workflow: WorkflowEntity;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    @stringLengthValidator({ min: 1, max: 100 })
    bpmnElementId: string;

    xml: WorkflowXmlEmbedded;

    getName(): string | null {
        return this.name;
    }

    getModel(): ModelEntity {
        return WorkflowPoolModel.create({ name: this.name });
    }

    setModel(model: ModelEntity): void {
        this.name = (model as WorkflowPoolModel).name;
    }

    toString(): string {
        return this.name ?? this.bpmnElementId;
    }
}

export namespace WorkflowPoolOperation {
    export const Save: ExecuteSymbol<WorkflowPoolEntity> = init();
    export const Delete: DeleteSymbol<WorkflowPoolEntity> = init();
}

@reflect
export class WorkflowPoolModel extends ModelEntity {
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;
}

// ---- Lane -----------------------------------------------------------------------------------------------

/** Signum's `MList<Lite<Entity>> Actors` [ImplementedBy(User, Role)] as this owner's `@part` row — a
 *  POLYMORPHIC collection cannot be a bare array in altea, it needs the row's `@valueField`. */
@reflect
@entity("Part", "Master")
export class WorkflowLaneEntity_Actor extends Entity {
    @backReference lane: Lite<WorkflowLaneEntity>;
    @rowOrder order: int;

    @valueField @implementedBy(() => [UserEntity, RoleEntity])
    actor: Lite<Entity>;

    toString(): string {
        return this.actor?.toString() ?? "";
    }
}

@reflect
@uniqueIndex<WorkflowLaneEntity>(l => [l.pool, l.name])
@entity("Main", "Master")
export class WorkflowLaneEntity extends Entity implements IWorkflowObjectEntity, IWithModel {

    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    @stringLengthValidator({ min: 1, max: 100 })
    bpmnElementId: string;

    xml: WorkflowXmlEmbedded;

    pool: WorkflowPoolEntity;

    /** Whoever gets a notification for an activity in this lane. `@noRepeatValidator` compares through the
     *  row's `@valueField`, so two rows naming the same actor ARE caught. */
    @noRepeatValidator()
    actors: WorkflowLaneEntity_Actor[];

    /** altea: Signum's `WorkflowLaneActorsEval` (a compiled C# script) — the actors computed per case. */
    actorsEvaluator: WorkflowLaneActorsSymbol | null;

    @fieldValidation<WorkflowLaneEntity>(l => !l.useActorEvalForStart || l.actorsEvaluator != null ? null
        : ValidationMessage._0ShouldBe12.niceToString(
            WorkflowLaneEntity.nicePropertyName(a => a.useActorEvalForStart),
            Enum.niceName(ComparisonType, "EqualTo"), false))
    useActorEvalForStart: boolean = false;

    @fieldValidation<WorkflowLaneEntity>(l =>
        !l.combineActorAndActorEvalWhenContinuing || (l.actorsEvaluator != null && l.actors.length > 0) ? null
            : ValidationMessage._0ShouldBe12.niceToString(
                WorkflowLaneEntity.nicePropertyName(a => a.combineActorAndActorEvalWhenContinuing),
                Enum.niceName(ComparisonType, "EqualTo"), false))
    combineActorAndActorEvalWhenContinuing: boolean = false;

    getName(): string | null {
        return this.name;
    }

    getModel(): ModelEntity {
        return WorkflowLaneModel.create({
            mainEntityType: this.pool.workflow.mainEntityType,
            name: this.name,
            actors: this.actors.map(a => a.actor),
            actorsEvaluator: this.actorsEvaluator,
            useActorEvalForStart: this.useActorEvalForStart,
            combineActorAndActorEvalWhenContinuing: this.combineActorAndActorEvalWhenContinuing,
        });
    }

    setModel(model: ModelEntity): void {
        const m = model as WorkflowLaneModel;
        this.name = m.name;
        this.actorsEvaluator = m.actorsEvaluator;
        this.useActorEvalForStart = m.useActorEvalForStart;
        this.combineActorAndActorEvalWhenContinuing = m.combineActorAndActorEvalWhenContinuing;
        // Rebuild the rows, reusing the ones that already point at the same actor so their row id (and with
        // it the @rowOrder) survives a save that only reordered or added.
        const old = this.actors;
        this.actors = m.actors.map(a => old.firstOrNull(o => o.actor.is(a))
            ?? WorkflowLaneEntity_Actor.create({ actor: a }));
    }

    toString(): string {
        return this.name ?? this.bpmnElementId;
    }
}

export namespace WorkflowLaneOperation {
    export const Save: ExecuteSymbol<WorkflowLaneEntity> = init();
    export const Delete: DeleteSymbol<WorkflowLaneEntity> = init();
}

@reflect
export class WorkflowLaneModel extends ModelEntity {
    mainEntityType: TypeEntity;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    /** A MODEL is never persisted, so the polymorphic collection stays a plain array of Lites (no `@part`
     *  row) — the shape @altea/altea-templating's MultiEntityModel uses. */
    @implementedBy(() => [UserEntity, RoleEntity])
    @noRepeatValidator()
    actors: Lite<Entity>[];

    actorsEvaluator: WorkflowLaneActorsSymbol | null;

    @fieldValidation<WorkflowLaneModel>(l => !l.useActorEvalForStart || l.actorsEvaluator != null ? null
        : ValidationMessage._0ShouldBe12.niceToString(
            WorkflowLaneModel.nicePropertyName(a => a.useActorEvalForStart),
            Enum.niceName(ComparisonType, "EqualTo"), false))
    useActorEvalForStart: boolean = false;

    @fieldValidation<WorkflowLaneModel>(l =>
        !l.combineActorAndActorEvalWhenContinuing || (l.actorsEvaluator != null && l.actors.length > 0) ? null
            : ValidationMessage._0ShouldBe12.niceToString(
                WorkflowLaneModel.nicePropertyName(a => a.combineActorAndActorEvalWhenContinuing),
                Enum.niceName(ComparisonType, "EqualTo"), false))
    combineActorAndActorEvalWhenContinuing: boolean = false;
}

// ---- Activity -------------------------------------------------------------------------------------------

export enum WorkflowActivityType {
    Task,
    Decision,
    DecompositionWorkflow,
    CallWorkflow,
    Script,
}
registerEnum(WorkflowActivityType);

/**
 * Signum's BootstrapStyle (Signum.Basics) — the bootstrap contextual colors, here the color of a decision
 * button. altea declares it in THIS module because nothing else needs it yet; the client's `BsColor` is the
 * same set in lowercase. It needs no `Enum` suffix: nothing reads it as a string union, so the registered
 * name is "BootstrapStyle".
 */
export enum BootstrapStyle {
    Light,
    Dark,
    Primary,
    Secondary,
    Success,
    Info,
    Warning,
    Danger,
}
registerEnum(BootstrapStyle);

/** Signum's ButtonOptionEmbedded — one button of a Decision activity, or the custom "Next" of a Task. */
@reflect
export class ButtonOptionEmbedded extends EmbeddedEntity {
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    style: BootstrapStyle;

    withConfirmation: boolean = false;

    clone(): ButtonOptionEmbedded {
        return ButtonOptionEmbedded.create({
            name: this.name,
            style: this.style,
            withConfirmation: this.withConfirmation,
        });
    }
}

/** Signum's ViewNamePropEmbedded — an extra prop passed to the activity's custom view. `expression` is a
 *  JavaScript snippet the CLIENT evaluates when it builds the view promise (Signum does the same, and it
 *  runs in the browser there too — so this one is not an Eval divergence). */
@reflect
export class ViewNamePropEmbedded extends EmbeddedEntity {
    @stringLengthValidator({ max: 100 })
    name: string;

    @stringLengthValidator({ max: 100 })
    expression: string | null;
}

/** Signum's WorkflowScriptPartEmbedded — which script a Script activity runs, and how to back off. */
@reflect
export class WorkflowScriptPartEmbedded extends EmbeddedEntity {
    script: Lite<WorkflowScriptEntity>;

    retryStrategy: WorkflowScriptRetryStrategyEntity | null;

    clone(): WorkflowScriptPartEmbedded {
        return WorkflowScriptPartEmbedded.create({ script: this.script, retryStrategy: this.retryStrategy });
    }
}

/** Signum's SubWorkflowEmbedded — the workflow a Decomposition / CallWorkflow activity spawns, and the
 *  registered function that says which entities to spawn it for. */
@reflect
export class SubWorkflowEmbedded extends EmbeddedEntity {
    workflow: WorkflowEntity;

    /** altea: Signum's `SubEntitiesEval` (a compiled C# script). */
    subEntitiesEvaluator: WorkflowSubEntitiesSymbol;

    clone(): SubWorkflowEmbedded {
        return SubWorkflowEmbedded.create({
            workflow: this.workflow,
            subEntitiesEvaluator: this.subEntitiesEvaluator,
        });
    }
}

/** Signum's `MList<ButtonOptionEmbedded> DecisionOptions` — an embedded collection, so a `@part` row. */
@reflect
@entity("Part", "Master")
export class WorkflowActivityEntity_DecisionOption extends Entity {
    @backReference activity: Lite<WorkflowActivityEntity>;
    @rowOrder order: int;

    @valueField option: ButtonOptionEmbedded;

    toString(): string {
        return this.option?.name ?? "";
    }
}

/** Signum's `MList<ViewNamePropEmbedded> ViewNameProps`. */
@reflect
@entity("Part", "Master")
export class WorkflowActivityEntity_ViewNameProp extends Entity {
    @backReference activity: Lite<WorkflowActivityEntity>;
    @rowOrder order: int;

    @valueField prop: ViewNamePropEmbedded;

    toString(): string {
        return this.prop?.name ?? "";
    }
}

@reflect
@uniqueIndex<WorkflowActivityEntity>(a => [a.lane, a.name])
@entity("Main", "Master")
export class WorkflowActivityEntity extends Entity implements IWorkflowNodeEntity, IWithModel {

    lane: WorkflowLaneEntity;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    @stringLengthValidator({ min: 1, max: 100 })
    bpmnElementId: string;

    type: WorkflowActivityType;

    @stringLengthValidator({ min: 3, max: 400, multiLine: true })
    comments: string | null;

    requiresOpen: boolean = false;

    @fieldValidation<WorkflowActivityEntity>(a =>
        isSetOnlyWhen(WorkflowActivityEntity.nicePropertyName(x => x.decisionOptions),
            a.decisionOptions.length > 0, a.type === WorkflowActivityType.Decision))
    decisionOptions: WorkflowActivityEntity_DecisionOption[];

    @fieldValidation<WorkflowActivityEntity>(a => a.customNextButton == null || a.type === WorkflowActivityType.Task ? null
        : ValidationMessage._0IsSet.niceToString(WorkflowActivityEntity.nicePropertyName(x => x.customNextButton)))
    customNextButton: ButtonOptionEmbedded | null;

    /**
     * The boundary timer events attached to this activity.
     *
     * altea divergence: Signum declares `[Ignore, QueryableProperty] MList<WorkflowEventEntity>` and wires it
     * with `.WithVirtualMList(wa => wa.BoundaryTimers, e => e.BoundaryOf, …)` — a Signum VirtualMList, i.e. a
     * collection of FULL entities that live in their own table and point back. altea has no VirtualMList (its
     * `@part` collections ARE that shape, but a part has exactly one owner and a boundary event is a
     * first-class node owned by a LANE), so this stays a NON-PERSISTED list: `@column(false)`, filled by the
     * WorkflowNodeGraph loader and by the designer's ApplyXml, which saves the events themselves with
     * `boundaryOf` set. Signum's `QueryableProperty` (a query token over the virtual list) goes with it —
     * the two server queries that used it join WorkflowEventEntity on `boundaryOf` instead.
     */
    @column(false)
    @noRepeatValidator()
    boundaryTimers: WorkflowEventEntity[];

    @unit("min")
    estimatedDuration: number | null;

    @stringLengthValidator({ min: 3, max: 255 })
    viewName: string | null;

    @fieldValidation<WorkflowActivityEntity>(a => a.viewNameProps.length === 0 || (a.viewName ?? "") !== "" ? null
        : ValidationMessage._0ShouldBeNull.niceToString(
            WorkflowActivityEntity.nicePropertyName(x => x.viewNameProps)))
    @noRepeatValidator()
    viewNameProps: WorkflowActivityEntity_ViewNameProp[];

    @fieldValidation<WorkflowActivityEntity>(a => scriptValidation(a.script != null, a.type))
    script: WorkflowScriptPartEmbedded | null;

    xml: WorkflowXmlEmbedded;

    @fieldValidation<WorkflowActivityEntity>(a => subWorkflowValidation(a.subWorkflow != null, a.type))
    subWorkflow: SubWorkflowEmbedded | null;

    @stringLengthValidator({ multiLine: true })
    userHelp: string | null;

    getName(): string | null {
        return this.name;
    }

    getModel(): ModelEntity {
        const workflow = this.lane.pool.workflow;
        return WorkflowActivityModel.create({
            workflowActivity: this.toLite(),
            workflow: workflow,
            mainEntityType: workflow.mainEntityType,
            name: this.name,
            type: this.type,
            requiresOpen: this.requiresOpen,
            boundaryTimers: this.boundaryTimers.map(we => we.getModel() as WorkflowEventModel),
            decisionOptions: this.decisionOptions.map(d => d.option),
            customNextButton: this.customNextButton,
            estimatedDuration: this.estimatedDuration,
            script: this.script,
            viewName: this.viewName,
            viewNameProps: this.viewNameProps.map(p => p.prop),
            userHelp: this.userHelp,
            subWorkflow: this.subWorkflow,
            comments: this.comments,
        });
    }

    setModel(model: ModelEntity): void {
        const m = model as WorkflowActivityModel;
        this.name = m.name;
        this.type = m.type;
        this.requiresOpen = m.requiresOpen;
        this.decisionOptions = (m.type === WorkflowActivityType.Decision ? m.decisionOptions : [])
            .map(o => WorkflowActivityEntity_DecisionOption.create({ option: o }));
        this.customNextButton = m.customNextButton;
        // Signum: "We can not set boundary timers in model" — they are synchronized by ApplyXml instead.
        this.estimatedDuration = m.estimatedDuration;
        this.script = m.script;
        this.viewName = m.viewName;
        this.viewNameProps = m.viewNameProps.map(p => WorkflowActivityEntity_ViewNameProp.create({ prop: p }));
        this.userHelp = m.userHelp;
        this.comments = m.comments;
        this.subWorkflow = m.subWorkflow;
    }

    toString(): string {
        return this.name ?? this.bpmnElementId;
    }
}

export namespace WorkflowActivityOperation {
    export const Save: ExecuteSymbol<WorkflowActivityEntity> = init();
    export const Delete: DeleteSymbol<WorkflowActivityEntity> = init();
}

@reflect
export class WorkflowActivityModel extends ModelEntity {
    workflowActivity: Lite<WorkflowActivityEntity> | null;

    workflow: WorkflowEntity | null;

    mainEntityType: TypeEntity;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    type: WorkflowActivityType;

    requiresOpen: boolean = false;

    @fieldValidation<WorkflowActivityModel>(a =>
        isSetOnlyWhen(WorkflowActivityModel.nicePropertyName(x => x.decisionOptions),
            a.decisionOptions.length > 0, a.type === WorkflowActivityType.Decision))
    decisionOptions: ButtonOptionEmbedded[];

    @fieldValidation<WorkflowActivityModel>(a => a.customNextButton == null || a.type === WorkflowActivityType.Task ? null
        : ValidationMessage._0IsSet.niceToString(WorkflowActivityModel.nicePropertyName(x => x.customNextButton)))
    customNextButton: ButtonOptionEmbedded | null;

    @noRepeatValidator()
    boundaryTimers: WorkflowEventModel[];

    @unit("min")
    estimatedDuration: number | null;

    script: WorkflowScriptPartEmbedded | null;

    @stringLengthValidator({ min: 3, max: 255 })
    viewName: string | null;

    @fieldValidation<WorkflowActivityModel>(a => a.viewNameProps.length === 0 || (a.viewName ?? "") !== "" ? null
        : ValidationMessage._0ShouldBeNull.niceToString(WorkflowActivityModel.nicePropertyName(x => x.viewNameProps)))
    @noRepeatValidator()
    viewNameProps: ViewNamePropEmbedded[];

    @stringLengthValidator({ min: 3, max: 400, multiLine: true })
    comments: string | null;

    @stringLengthValidator({ multiLine: true })
    userHelp: string | null;

    subWorkflow: SubWorkflowEmbedded | null;
}

export const WorkflowActivityMessage = {
    DuplicateViewNameFound0: msg("Duplicate view name found: {0}"),
    ChooseADestinationForWorkflowJumping: msg(),
    CaseFlow: msg(),
    AverageDuration: msg(),
    ActivityIs: msg("Activity Is"),
    NoActiveTimerFound: msg(),
    InprogressCaseActivities: msg(),
    OpenCaseActivityStats: msg(),
    LocateWorkflowActivityInDiagram: msg(),
    Approve: msg(),
    Decline: msg(),
    Confirmation: msg(),
    AreYouSureYouWantToExecute0: msg("Are you sure you want to execute: {0}"),
};

// ---- Event ----------------------------------------------------------------------------------------------

export enum WorkflowEventType {
    Start,
    ScheduledStart,
    Finish,
    BoundaryForkTimer,
    BoundaryInterruptingTimer,
    IntermediateTimer,
}
registerEnum(WorkflowEventType);

// Signum's WorkflowEventTypeExtension, as plain functions over the string union.
export function isStart(type: WorkflowEventType): boolean {
    return type === WorkflowEventType.Start || type === WorkflowEventType.ScheduledStart;
}
export function isScheduledStart(type: WorkflowEventType): boolean {
    return type === WorkflowEventType.ScheduledStart;
}
export function isFinish(type: WorkflowEventType): boolean {
    return type === WorkflowEventType.Finish;
}
export function isTimer(type: WorkflowEventType): boolean {
    return type === WorkflowEventType.BoundaryForkTimer || type === WorkflowEventType.BoundaryInterruptingTimer
        || type === WorkflowEventType.IntermediateTimer;
}
export function isBoundaryTimer(type: WorkflowEventType): boolean {
    return type === WorkflowEventType.BoundaryForkTimer || type === WorkflowEventType.BoundaryInterruptingTimer;
}

/**
 * Signum's TimeSpanEmbedded — a duration as four int columns.
 *
 * altea has a real `Duration` field type, and using it here would be tempting; it is NOT used, for the same
 * reason Signum spells the parts out: `Duration` maps to SQL Server `time`, which tops out at 24 hours, and a
 * workflow timer of "3 days" is entirely normal. Four ints also keep `add` / `subtract` translatable to SQL,
 * which the timeout query needs.
 */
@reflect
export class TimeSpanEmbedded extends EmbeddedEntity {
    days: int;
    hours: int;
    minutes: int;
    seconds: int;

    isZero(): boolean {
        return this.days === 0 && this.hours === 0 && this.minutes === 0 && this.seconds === 0;
    }

    @quoted
    add(date: Temporal.PlainDateTime): Temporal.PlainDateTime {
        return date.add({ days: this.days, hours: this.hours, minutes: this.minutes, seconds: this.seconds });
    }

    @quoted
    subtract(date: Temporal.PlainDateTime): Temporal.PlainDateTime {
        return date.add({ days: -this.days, hours: -this.hours, minutes: -this.minutes, seconds: -this.seconds });
    }

    /** The whole duration in minutes — what the case-flow view compares an activity's duration against. */
    totalMinutes(): number {
        return this.days * 24 * 60 + this.hours * 60 + this.minutes + this.seconds / 60;
    }

    clone(): TimeSpanEmbedded {
        return TimeSpanEmbedded.create({
            days: this.days, hours: this.hours, minutes: this.minutes, seconds: this.seconds,
        });
    }

    toString(): string {
        const pad = (n: int): string => String(n).padStart(2, "0");
        return `${this.days > 0 ? this.days + "." : ""}${pad(this.hours)}:${pad(this.minutes)}:${pad(this.seconds)}`;
    }
}

@reflect
export class WorkflowTimerEmbedded extends EmbeddedEntity {

    @fieldValidation<WorkflowTimerEmbedded>(t =>
        t.duration == null && t.condition == null
            ? ValidationMessage._0IsMandatoryWhen1IsNotSet.niceToString(
                WorkflowTimerEmbedded.nicePropertyName(a => a.duration),
                WorkflowTimerEmbedded.nicePropertyName(a => a.condition))
            : t.duration != null && t.condition != null
                ? ValidationMessage._0ShouldBeNullWhen1IsSet.niceToString(
                    WorkflowTimerEmbedded.nicePropertyName(a => a.condition),
                    WorkflowTimerEmbedded.nicePropertyName(a => a.duration))
                : null)
    duration: TimeSpanEmbedded | null;

    /** Skip the condition when the TIMER fires — evaluate it only on the scheduled sweep. */
    avoidExecuteConditionByTimer: boolean = false;

    condition: Lite<WorkflowTimerConditionEntity> | null;

    clone(): WorkflowTimerEmbedded {
        return WorkflowTimerEmbedded.create({
            avoidExecuteConditionByTimer: this.avoidExecuteConditionByTimer,
            condition: this.condition,
            duration: this.duration?.clone() ?? null,
        });
    }
}

@reflect
@entity("String", "Master")
export class WorkflowEventEntity extends Entity implements IWorkflowNodeEntity, IWithModel {

    @stringLengthValidator({ min: 3, max: 100 })
    name: string | null;

    @stringLengthValidator({ min: 1, max: 100 })
    bpmnElementId: string;

    lane: WorkflowLaneEntity;

    type: WorkflowEventType;

    /** A BoundaryForkTimer can fire again and again while its activity is pending. */
    runRepeatedly: boolean = false;

    @stringLengthValidator({ min: 3, max: 100 })
    decisionOptionName: string | null;

    timer: WorkflowTimerEmbedded | null;

    boundaryOf: Lite<WorkflowActivityEntity> | null;

    xml: WorkflowXmlEmbedded;

    getName(): string | null {
        return this.name;
    }

    getModel(): ModelEntity {
        return WorkflowEventModel.create({
            mainEntityType: this.lane.pool.workflow.mainEntityType,
            name: this.name,
            type: this.type,
            runRepeatedly: this.runRepeatedly,
            decisionOptionName: this.decisionOptionName,
            // Signum fills `Task` here through the static `WorkflowEventTaskModel.GetModel` hook, which needs
            // the database; altea's getModel stays PURE and the server fills it (see WorkflowLogic).
            task: null,
            timer: this.timer,
            bpmnElementId: this.bpmnElementId,
        });
    }

    setModel(model: ModelEntity): void {
        const m = model as WorkflowEventModel;
        this.name = m.name;
        this.type = m.type;
        this.runRepeatedly = m.runRepeatedly;
        this.decisionOptionName = m.decisionOptionName;
        this.timer = m.timer;
        this.bpmnElementId = m.bpmnElementId;
    }

    toString(): string {
        return this.name ?? this.bpmnElementId;
    }
}

export namespace WorkflowEventOperation {
    export const Save: ExecuteSymbol<WorkflowEventEntity> = init();
    export const Delete: DeleteSymbol<WorkflowEventEntity> = init();
}

@reflect
export class WorkflowEventModel extends ModelEntity {
    mainEntityType: TypeEntity;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string | null;

    type: WorkflowEventType;

    runRepeatedly: boolean = false;

    @stringLengthValidator({ min: 3, max: 100 })
    decisionOptionName: string | null;

    task: WorkflowEventTaskModel | null;

    timer: WorkflowTimerEmbedded | null;

    bpmnElementId: string;
}

// ---- Gateway --------------------------------------------------------------------------------------------

export enum WorkflowGatewayType {
    /** 1 */
    Exclusive,
    /** 1…N */
    Inclusive,
    /** N */
    Parallel,
}
registerEnum(WorkflowGatewayType);

export enum WorkflowGatewayDirection {
    Split,
    Join,
}
registerEnum(WorkflowGatewayDirection);

@reflect
@entity("String", "Master")
export class WorkflowGatewayEntity extends Entity implements IWorkflowNodeEntity, IWithModel {

    lane: WorkflowLaneEntity;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string | null;

    @stringLengthValidator({ min: 1, max: 100 })
    bpmnElementId: string;

    type: WorkflowGatewayType;

    direction: WorkflowGatewayDirection;

    xml: WorkflowXmlEmbedded;

    getName(): string | null {
        return this.name;
    }

    getModel(): ModelEntity {
        return WorkflowGatewayModel.create({ name: this.name, type: this.type, direction: this.direction });
    }

    setModel(model: ModelEntity): void {
        const m = model as WorkflowGatewayModel;
        this.name = m.name;
        this.type = m.type;
        this.direction = m.direction;
    }

    toString(): string {
        return this.name ?? this.bpmnElementId;
    }
}

export namespace WorkflowGatewayOperation {
    export const Save: ExecuteSymbol<WorkflowGatewayEntity> = init();
    export const Delete: DeleteSymbol<WorkflowGatewayEntity> = init();
}

@reflect
export class WorkflowGatewayModel extends ModelEntity {
    @stringLengthValidator({ min: 3, max: 100 })
    name: string | null;

    type: WorkflowGatewayType;

    direction: WorkflowGatewayDirection;
}

// ---- Connection -----------------------------------------------------------------------------------------

export enum ConnectionType {
    Normal,
    Decision,
    Jump,
    ScriptException,
}
registerEnum(ConnectionType);

@reflect
@entity("Main", "Master")
export class WorkflowConnectionEntity extends Entity implements IWorkflowObjectEntity, IWithModel {

    /** Signum's `[ForceNullable]`: the column must be nullable because a connection is saved before its
     *  endpoints exist in a fresh diagram, even though a saved connection always has both. */
    @forceNullable
    @implementedBy(() => [WorkflowActivityEntity, WorkflowEventEntity, WorkflowGatewayEntity])
    from: IWorkflowNodeEntity;

    @forceNullable
    @implementedBy(() => [WorkflowActivityEntity, WorkflowEventEntity, WorkflowGatewayEntity])
    to: IWorkflowNodeEntity;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string | null;

    @fieldValidation<WorkflowConnectionEntity>(c =>
        isSetOnlyWhen(WorkflowConnectionEntity.nicePropertyName(x => x.decisionOptionName),
            c.decisionOptionName != null, c.type === ConnectionType.Decision))
    @stringLengthValidator({ min: 3, max: 100 })
    decisionOptionName: string | null;

    @stringLengthValidator({ min: 1, max: 100 })
    bpmnElementId: string;

    type: ConnectionType;

    condition: Lite<WorkflowConditionEntity> | null;

    action: Lite<WorkflowActionEntity> | null;

    /** Evaluation order on an Exclusive split (the if / else-if chain). */
    order: int | null;

    xml: WorkflowXmlEmbedded;

    getName(): string | null {
        return this.name;
    }

    /** Signum's internal DoneDecision() — the decision this connection is the answer to, if any. */
    doneDecision(): string | null {
        return this.type === ConnectionType.Decision ? this.decisionOptionName : null;
    }

    getModel(): ModelEntity {
        return WorkflowConnectionModel.create({
            mainEntityType: this.from.lane.pool.workflow.mainEntityType,
            name: this.name,
            decisionOptionName: this.decisionOptionName,
            type: this.type,
            condition: this.condition,
            action: this.action,
            order: this.order,
        });
    }

    setModel(model: ModelEntity): void {
        const m = model as WorkflowConnectionModel;
        this.name = m.name;
        this.decisionOptionName = m.type === ConnectionType.Decision ? m.decisionOptionName : null;
        this.type = m.type;
        this.condition = m.condition;
        this.action = m.action;
        this.order = m.order;
    }

    toString(): string {
        return this.name ?? this.bpmnElementId;
    }
}

export namespace WorkflowConnectionOperation {
    export const Save: ExecuteSymbol<WorkflowConnectionEntity> = init();
    export const Delete: DeleteSymbol<WorkflowConnectionEntity> = init();
}

@reflect
export class WorkflowConnectionModel extends ModelEntity {
    mainEntityType: TypeEntity;

    @stringLengthValidator({ min: 3, max: 100 })
    name: string | null;

    @fieldValidation<WorkflowConnectionModel>(c => c.decisionOptionName != null || c.type !== ConnectionType.Decision ? null
        : ValidationMessage._0IsNotSet.niceToString(
            WorkflowConnectionModel.nicePropertyName(x => x.decisionOptionName)))
    @stringLengthValidator({ min: 3, max: 100 })
    decisionOptionName: string | null;

    /** Set by the designer, not stored: the source is a gateway that needs a guard. */
    needCondition: boolean = false;

    /** Set by the designer, not stored: the source is an Exclusive split, so the order matters. */
    needOrder: boolean = false;

    type: ConnectionType;

    condition: Lite<WorkflowConditionEntity> | null;

    action: Lite<WorkflowActionEntity> | null;

    order: int | null;

    /** The decision options the designer offers, gathered from the activities feeding this gateway. */
    decisionOptions: ButtonOptionEmbedded[];
}

// ---- Validation helpers ---------------------------------------------------------------------------------

/** Signum's `(pi, value).IsSetOnlyWhen(condition)` extension. */
function isSetOnlyWhen(niceName: string, isSet: boolean, condition: boolean): string | null {
    if (condition)
        return isSet ? null : ValidationMessage._0IsNotSet.niceToString(niceName);
    return isSet ? ValidationMessage._0ShouldBeNull.niceToString(niceName) : null;
}

function scriptValidation(isSet: boolean, type: WorkflowActivityType): string | null {
    const niceName = WorkflowActivityEntity.nicePropertyName(a => a.script);
    return isSetOnlyWhen(niceName, isSet, type === WorkflowActivityType.Script);
}

function subWorkflowValidation(isSet: boolean, type: WorkflowActivityType): string | null {
    const niceName = WorkflowActivityEntity.nicePropertyName(a => a.subWorkflow);
    return isSetOnlyWhen(niceName, isSet, type === WorkflowActivityType.CallWorkflow || type === WorkflowActivityType.DecompositionWorkflow);
}
