import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, uniqueIndex, index, implementedBy, column, fieldValidation } from "@altea/altea/data/decorators";
import { ValidationMessage } from "@altea/altea/data/validators";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { registerEnum } from "@altea/altea/data/registration";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import {
    ScheduleRuleMinutelyEntity, ScheduleRuleMonthsEntity, ScheduleRuleWeekDaysEntity,
    type ITaskEntity, type IScheduleRuleEntity,
} from "@altea/altea-scheduler/data/Scheduler";
import { WorkflowEntity } from "./Workflow";
import { WorkflowEventEntity } from "./WorkflowNodes";
import { EvalEmbedded, type CompilationResult } from "@altea/altea-eval/data/Eval";
import type { IWorkflowEventTaskActionEvaluator, IWorkflowEventTaskConditionEvaluator } from "./WorkflowEval";

// Port of Signum.Workflow's WorkflowEventTask.cs — what a SCHEDULED START event actually is: an
// altea-scheduler task (`ITaskEntity`) that, when its rule fires, asks a registered function which entities
// to open cases for.
//
// altea divergences:
//  - the ACTION eval returns the entities to create cases for, where Signum's script calls a generated
//    `CreateCase(entity)` helper — see WorkflowEventTaskActionEval.
//  - Signum reaches the full workflow through a static `Func<Lite<WorkflowEntity>, WorkflowEntity>` the logic
//    layer assigns (`WorkflowEventTaskEntity.GetWorkflowEntity`), because the entity assembly cannot see the
//    engine. altea keeps the `@column(false) fullWorkflow` cache Signum has, but the RESOLUTION lives in
//    WorkflowEventTaskLogic (`getWorkflow(task)`) rather than on the entity — a data-layer class holding a
//    mutable hook into the server is exactly the coupling the layer split exists to prevent.
//  - Signum's `WorkflowEventTaskModel.GetModel` / `.ApplyModel` statics move to the server for the same
//    reason: they read and write ScheduledTaskEntity rows.

export enum TriggeredOn {
    Always,
    ConditionIsTrue,
    ConditionChangesToTrue,
}
registerEnum(TriggeredOn);

@reflect
@entity("Shared", "Master")
export class WorkflowEventTaskEntity extends Entity implements ITaskEntity {

    workflow: Lite<WorkflowEntity>;

    /** Signum's `[Ignore] internal WorkflowEntity? fullWorkflow` — set when the task is built in memory
     *  (cloning a workflow) so the engine need not re-read it. */
    @column(false)
    fullWorkflow: WorkflowEntity | null = null;

    @uniqueIndex
    event: Lite<WorkflowEventEntity>;

    triggeredOn: TriggeredOn = TriggeredOn.Always;

    @fieldValidation<WorkflowEventTaskEntity>(t =>
        t.triggeredOn === TriggeredOn.Always && t.condition != null
            ? ValidationMessage._0IsSet.niceToString(WorkflowEventTaskEntity.nicePropertyName(a => a.condition))
            : t.triggeredOn !== TriggeredOn.Always && t.condition == null
                ? ValidationMessage._0IsNotSet.niceToString(WorkflowEventTaskEntity.nicePropertyName(a => a.condition))
                : null)
    condition: WorkflowEventTaskConditionEval | null;

    action: WorkflowEventTaskActionEval | null;

    toString(): string {
        return this.workflow + " : " + this.event;
    }
}

export namespace WorkflowEventTaskOperation {
    export const Save: ExecuteSymbol<WorkflowEventTaskEntity> = init();
    export const Delete: DeleteSymbol<WorkflowEventTaskEntity> = init();
}

/** What the designer edits when you open a Scheduled Start event: the scheduler's side (suspended + rule)
 *  and the task's side (when to trigger, and the two functions), in one model. */
@reflect
export class WorkflowEventTaskModel extends ModelEntity {
    suspended: boolean = false;

    /** Signum copies ScheduledTaskEntity.Rule's `[ImplementedBy]` onto this member at startup
     *  (`sb.Schema.Settings.FieldAttributes((WorkflowEventTaskModel a) => a.Rule).Replace(…)`); altea names
     *  altea-scheduler's three rule types directly — a model is never persisted, so there is no schema
     *  step to keep in sync, and an explicit list is what the deserializer checks against. */
    @implementedBy(() => [ScheduleRuleMinutelyEntity, ScheduleRuleWeekDaysEntity, ScheduleRuleMonthsEntity])
    rule: IScheduleRuleEntity | null;

    triggeredOn: TriggeredOn = TriggeredOn.Always;

    condition: WorkflowEventTaskConditionEval | null;

    action: WorkflowEventTaskActionEval | null;
}

/**
 * Signum's WorkflowEventTaskConditionEval — "should this scheduled start fire now?". It takes NOTHING: there
 * is no case yet, so the script queries for itself.
 */
@reflect
export class WorkflowEventTaskConditionEval extends EvalEmbedded<IWorkflowEventTaskConditionEvaluator> {
    protected override compile(): CompilationResult<IWorkflowEventTaskConditionEvaluator> {
        return this.wrap({ parameters: "", returnType: "boolean", isAsync: true });
    }
}

/**
 * Signum's WorkflowEventTaskActionEval — what a scheduled start creates cases FOR.
 *
 * altea divergence: Signum's generated wrapper gives the script a `CreateCase(entity)` method that pushes
 * onto a list it then returns, because a C# method body cannot be an expression. A TypeScript function just
 * RETURNS the list, so the indirection (and its inner `CreateCaseEvaluator` class) is gone.
 */
@reflect
export class WorkflowEventTaskActionEval extends EvalEmbedded<IWorkflowEventTaskActionEvaluator> {
    protected override compile(): CompilationResult<IWorkflowEventTaskActionEvaluator> {
        // UNTYPED, exactly as Signum's generated `CreateCase(ICaseMainEntity)` is: the task only holds a
        // `Lite<WorkflowEntity>`, so neither tier can name the sub-workflow's main entity type here.
        return this.wrap({
            importTypes: ["ICaseMainEntity"],
            parameters: "",
            returnType: "ICaseMainEntity[]",
            isAsync: true,
        });
    }
}

/** Signum's WorkflowEventTaskConditionResultEntity — the log of what a `ConditionChangesToTrue` task saw
 *  last time, which is how "changes to" is decided. */
@reflect
@index<WorkflowEventTaskConditionResultEntity>(e => [e.creationDate])
@entity("System", "Transactional")
export class WorkflowEventTaskConditionResultEntity extends Entity {

    creationDate: Temporal.PlainDateTime = Clock.now;

    workflowEventTask: Lite<WorkflowEventTaskEntity> | null;

    result: boolean = false;
}
