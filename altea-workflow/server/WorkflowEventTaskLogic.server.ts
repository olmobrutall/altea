import "@altea/altea/server"; // installs Entity.save()/delete()
import { EvalLogic } from "@altea/altea-eval/server/EvalLogic.server"; // + FluentInclude.withEvals
import "@altea/altea/server/operationFluentInclude";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/data/globals/arrayExtensions";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import type { IQuery } from "@altea/altea/data/iquery";
import { graph } from "@altea/altea/server/graphBuilder";
import { Operations } from "@altea/altea/server/operationLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { retrieve } from "@altea/altea/server/Database";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { withQuoted } from "@altea/altea/data/decorators";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { isGraphModified } from "@altea/altea/data/changes";
import { ScheduledTaskEntity, ScheduledTaskOperation } from "@altea/altea-scheduler/data/Scheduler";
import type { ScheduledTaskContext } from "@altea/altea-scheduler/server/ScheduleTaskRunner.server";
import { SchedulerLogic } from "@altea/altea-scheduler/server/SchedulerLogic.server";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { PackageEntity, PackageLineEntity } from "@altea/altea-processes/data/Package";
import { Clock } from "@altea/altea/data/utils/clock";
import { WorkflowEntity, WorkflowMessage } from "../data/Workflow";
import { ConnectionType, WorkflowEventEntity, WorkflowEventType, isScheduledStart } from "../data/WorkflowNodes";
import {
    TriggeredOn, WorkflowEventTaskConditionResultEntity, WorkflowEventTaskEntity, WorkflowEventTaskModel,
    WorkflowEventTaskOperation,
} from "../data/WorkflowEventTask";
import { CaseActivityOperation, CaseActivityEntity } from "../data/CaseActivity";
import { CaseEntity, type ICaseMainEntity } from "../data/Case";
import { CaseQueries } from "./CaseQueries.server";
import { WorkflowLogic } from "./WorkflowLogic.server";
import { hasExpired } from "./WorkflowNodeGraph.server";
import { CaseActivityLogic } from "./CaseActivityLogic.server";
import {
    setApplyWorkflowEventTaskModel, setCloneScheduledTasks, setGetWorkflowEventTaskModel,
} from "./WorkflowBuilder.server";

// Port of Signum.Workflow's WorkflowEventTaskLogic.cs — the bridge between a SCHEDULED START event and
// altea-scheduler: one ScheduledTask per such event, whose task entity holds the "should it fire" condition
// and the "what to open cases for" action.
//
// altea divergences:
//  - Signum installs `WorkflowEventTaskModel.GetModel` / `.ApplyModel` as STATICS on the data class (the
//    entity assembly cannot see the engine). altea keeps the same two functions but INJECTS them into the
//    builder (setGetWorkflowEventTaskModel / setApplyWorkflowEventTaskModel), so the data layer stays free of
//    server hooks.
//  - `ExceptionLogic.DeleteLogs` (trimming old condition results) is not ported: altea's log-deletion
//    parameters have no per-type date limits yet. The index on `creationDate` is kept, so it is a one-liner
//    when they land.
//  - the two evals become symbols, evaluated through WorkflowLogic (see data/WorkflowEval.ts).

declare module "../data/WorkflowEventTask" {
    interface WorkflowEventTaskEntity {
        conditionResults(): IQuery<WorkflowEventTaskConditionResultEntity>;
    }
}

declare module "../data/WorkflowNodes" {
    interface WorkflowEventEntity {
        /** The ScheduledTask that drives this Scheduled Start event, if any. */
        scheduledTask(): Promise<ScheduledTaskEntity | null>;
        workflowEventTask(): Promise<WorkflowEventTaskEntity | null>;
    }
}

WorkflowEventTaskEntity.prototype.conditionResults = withQuoted(
    function (this: WorkflowEventTaskEntity): IQuery<WorkflowEventTaskConditionResultEntity> {
        return table(WorkflowEventTaskConditionResultEntity).filter(a => a.workflowEventTask!.is(this));
    });

WorkflowEventEntity.prototype.scheduledTask = withQuoted(
    function (this: WorkflowEventEntity): Promise<ScheduledTaskEntity | null> {
        return table(ScheduledTaskEntity)
            .singleOrNull(s => (s.task as WorkflowEventTaskEntity).event.is(this));
    });

WorkflowEventEntity.prototype.workflowEventTask = withQuoted(
    function (this: WorkflowEventEntity): Promise<WorkflowEventTaskEntity | null> {
        return table(WorkflowEventTaskEntity).singleOrNull(et => et.event.is(this));
    });

export namespace WorkflowEventTaskLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(WorkflowEventTaskEntity)
            .withEvals()
            .withDelete(WorkflowEventTaskOperation.Delete)
            .withQuery();

        EvalLogic.registerEvalSource(WorkflowEventTaskEntity.niceName(), async () =>
            (await table(WorkflowEventTaskEntity).toArray()).filter(t => t.condition != null || t.action != null));

        graph(WorkflowEventTaskEntity, g => {
            g.Execute(WorkflowEventTaskOperation.Save, {
                canBeNew: true,
                canBeModified: true,
                execute: e => {
                    if (e.triggeredOn === TriggeredOn.Always)
                        e.condition = null;
                },
            });
        }).register();

        // Signum hangs this off PreUnsafeDelete; altea's event has the same shape.
        sb.schema.entityEvents(WorkflowEventTaskEntity).preUnsafeDelete.push(async query => {
            // A nested query inside a quoted filter has no translation, so the ids are read first and the
            // delete filters on them (the shape ToolbarLogic.registerDelete uses).
            const ids = await query.map(t => t.id!).toArray();
            if (ids.length > 0)
                await table(WorkflowEventTaskConditionResultEntity)
                    .filter(r => ids.includes(r.workflowEventTask!.id!))
                    .executeDelete();
        });

        sb.include(WorkflowEventTaskConditionResultEntity).withQuery();

        QueryLogic.expressions.register(WorkflowEventTaskEntity,
            (e: WorkflowEventTaskEntity) => e.conditionResults());

        // Signum registers this ConstructFrom in CaseActivityLogic's graph; altea registers it HERE, because
        // its SOURCE type is WorkflowEventTaskEntity (a ConstructFrom is owned by its source — see CLAUDE.md)
        // and this is the module that knows both sides.
        graph(CaseEntity, g => {
            g.ConstructFrom(CaseActivityOperation.CreateCaseFromWorkflowEventTask, {
                entityType: WorkflowEventTaskEntity,
                construct: async (wet, args) => {
                    const workflow = await getWorkflow(wet);

                    if (hasExpired(workflow))
                        throw new Error(WorkflowMessage.Workflow0HasExpiredOn1
                            .niceToString(workflow, workflow.expirationDate!.toString()));

                    const mainEntity = args[0] as ICaseMainEntity;
                    const caseEntity = CaseEntity.create({
                        workflow,
                        description: workflow.name,
                        mainEntity,
                    });

                    const start = await retrieve(WorkflowEventEntity, wet.event.id!);
                    const conn = (await WorkflowLogic.nextConnectionsFromCache(start, ConnectionType.Normal)).single();
                    await CaseActivityLogic.executeInitialStep(caseEntity, start, conn);

                    return caseEntity;
                },
                resultIsSaved: true,
            });
        }).register();

        SchedulerLogic.registerExecuteTask(WorkflowEventTaskEntity,
            async (wet: WorkflowEventTaskEntity, _ctx: ScheduledTaskContext) => await executeTask(wet));

        // The three hooks WorkflowBuilder / WorkflowLogic need from here (see the header).
        setGetWorkflowEventTaskModel(getModel);
        setApplyWorkflowEventTaskModel(applyModel);
        setCloneScheduledTasks(cloneScheduledTasks);

        WorkflowLogic.deleteScheduledTaskOf = async e => {
            const scheduled = await CaseQueries.scheduledTask(e);
            if (scheduled != null)
                await deleteWorkflowEventScheduledTask(scheduled);
        };

        WorkflowLogic.suspendWorkflowScheduledTasks = async (workflow, suspended) => {
            // Signum does this as one UnsafeUpdate over the events' scheduled tasks.
            const events = await table(WorkflowEventEntity)
                .filter(a => a.lane.pool.workflow.is(workflow) && a.type === WorkflowEventType.ScheduledStart)
                .toArray();
            for (const e of events) {
                const st = await CaseQueries.scheduledTask(e);
                if (st != null) {
                    st.suspended = suspended;
                    await st.save();
                }
            }
        };

        WorkflowLogic.scheduledStartInfo = async e => {
            const schedule = await CaseQueries.scheduledTask(e);
            const task = schedule?.task as WorkflowEventTaskEntity | undefined;
            return {
                hasSchedule: schedule != null,
                hasTask: task != null,
                conditionMissing: task != null && task.triggeredOn !== TriggeredOn.Always && task.condition == null,
            };
        };
    }

    /** Signum's `WorkflowEventTaskEntity.GetWorkflow()` — the full workflow behind the task's lite. */
    export async function getWorkflow(wet: WorkflowEventTaskEntity): Promise<WorkflowEntity> {
        if (wet.fullWorkflow != null)
            return wet.fullWorkflow;

        const graphs = await WorkflowLogic.workflowGraphLazy.value();
        const g = graphs.get(wet.workflow.key());
        if (g == null)
            throw new Error(`Workflow '${wet.workflow.key()}' not found`);
        return g.workflow;
    }

    /** Signum's `WorkflowEventTaskModel.GetModel` — read the scheduler side of a Scheduled Start event. */
    export async function getModel(event: WorkflowEventEntity): Promise<WorkflowEventTaskModel | null> {
        if (!isScheduledStart(event.type))
            return null;

        const schedule = event.isNew ? null : await CaseQueries.scheduledTask(event);
        const task = schedule?.task as WorkflowEventTaskEntity | undefined;
        const triggeredOn = task?.triggeredOn ?? TriggeredOn.Always;

        return WorkflowEventTaskModel.create({
            suspended: schedule?.suspended ?? true,
            rule: schedule?.rule ?? null,
            triggeredOn,
            condition: triggeredOn === TriggeredOn.Always ? null : task!.condition,
            action: task?.action ?? null,
        });
    }

    /** Signum's `WorkflowEventTaskModel.ApplyModel` — write it back, creating or dropping the ScheduledTask. */
    export async function applyModel(event: WorkflowEventEntity, model: WorkflowEventTaskModel | null): Promise<void> {
        const schedule = event.isNew ? null : await CaseQueries.scheduledTask(event);

        if (!isScheduledStart(event.type)) {
            if (schedule != null)
                await deleteWorkflowEventScheduledTask(schedule);
            return;
        }

        if (model == null)
            throw new Error("A Scheduled Start event needs a WorkflowEventTaskModel");

        if (schedule != null) {
            const task = schedule.task as WorkflowEventTaskEntity;
            schedule.suspended = model.suspended;
            if (schedule.rule !== model.rule)
                schedule.rule = model.rule!;
            task.triggeredOn = model.triggeredOn;
            task.condition = model.triggeredOn === TriggeredOn.Always ? null : model.condition;
            task.action = model.action;

            if (isGraphModified(schedule)) {
                await Operations.execute(task, WorkflowEventTaskOperation.Save);
                await Operations.execute(schedule, ScheduledTaskOperation.Save);
            }
        }
        else {
            const newTask = WorkflowEventTaskEntity.create({
                workflow: event.lane.pool.workflow.toLite(),
                event: event.toLite(),
                triggeredOn: model.triggeredOn,
                condition: model.triggeredOn === TriggeredOn.Always ? null : model.condition,
                action: model.action,
            });
            await Operations.execute(newTask, WorkflowEventTaskOperation.Save);

            const systemUser = await AuthLogic.systemUser();
            const newSchedule = ScheduledTaskEntity.create({
                suspended: model.suspended,
                rule: model.rule!,
                task: newTask,
                user: systemUser!.toLite(),
            });
            await Operations.execute(newSchedule, ScheduledTaskOperation.Save);
        }
    }

    /** Signum's CloneScheduledTasks — cloning a workflow clones the scheduled tasks of its start events. */
    export async function cloneScheduledTasks(oldEvent: WorkflowEventEntity, newEvent: WorkflowEventEntity): Promise<void> {
        const task = await table(WorkflowEventTaskEntity).singleOrNull(a => a.event.is(oldEvent));
        if (task == null)
            return;

        const st = await table(ScheduledTaskEntity).singleOrNull(a => a.task.is(task));
        if (st == null)
            return;

        const newTask = WorkflowEventTaskEntity.create({
            workflow: newEvent.lane.pool.workflow.toLite(),
            fullWorkflow: newEvent.lane.pool.workflow,
            event: newEvent.toLite(),
            triggeredOn: task.triggeredOn,
            condition: task.condition,
            action: task.action,
        });
        await Operations.execute(newTask, WorkflowEventTaskOperation.Save);

        const systemUser = await AuthLogic.systemUser();
        const newSchedule = ScheduledTaskEntity.create({
            suspended: st.suspended,
            rule: st.rule.clone(),
            task: newTask,
            user: systemUser!.toLite(),
        });
        await Operations.execute(newSchedule, ScheduledTaskOperation.Save);
    }

    export async function deleteWorkflowEventScheduledTask(schedule: ScheduledTaskEntity): Promise<void> {
        const workflowEventTask = schedule.task as WorkflowEventTaskEntity;
        await Operations.delete(schedule, ScheduledTaskOperation.Delete);
        await Operations.delete(workflowEventTask, WorkflowEventTaskOperation.Delete);
    }

    /**
     * Signum's ExecuteTask — the scheduled sweep: check the condition, ask the action which entities to open
     * cases for, and return what to show (one case activity, or a Package of many).
     */
    export async function executeTask(wet: WorkflowEventTaskEntity): Promise<Lite<Entity> | null> {
        const workflow = await getWorkflow(wet);

        if (hasExpired(workflow))
            throw new Error(WorkflowMessage.Workflow0HasExpiredOn1
                .niceToString(workflow, workflow.expirationDate!.toString()));

        return await Transaction.create(async () => {
            if (!await evaluateCondition(wet))
                return null;

            if (wet.action == null)
                throw new Error(`WorkflowEventTask '${wet}' has no action`);

            const mainEntities = await WorkflowLogic.evaluateEventTaskAction(wet.action);
            const caseActivities: Lite<CaseActivityEntity>[] = [];

            for (const me of mainEntities) {
                const c = await Operations.constructFrom(wet, CaseActivityOperation.CreateCaseFromWorkflowEventTask, me);
                caseActivities.push(...(await CaseQueries.caseActivities(c).map(a => a.toLite()).toArray()));
                const subCases = await CaseQueries.subCases(c).toArray();
                for (const sc of subCases)
                    caseActivities.push(...(await CaseQueries.caseActivities(sc).map(a => a.toLite()).toArray()));
            }

            if (caseActivities.length === 0)
                return null;

            if (caseActivities.length === 1)
                return caseActivities[0] as Lite<Entity>;

            // altea-processes ports the Package TABLES but no "create lines" helper, so the rows are
            // written here (as CaseActivityLogic's timeout sweep does).
            const pkg = PackageEntity.create({ name: `${wet.event} ${Clock.now.toString()}` });
            await pkg.save();
            for (const a of caseActivities)
                await PackageLineEntity.create({ package: pkg.toLite(), target: a }).save();
            return pkg.toLite() as Lite<Entity>;
        });
    }

    /** Signum's EvaluateCondition — including the "changes to true" bookkeeping. */
    async function evaluateCondition(task: WorkflowEventTaskEntity): Promise<boolean> {
        if (task.triggeredOn === TriggeredOn.Always)
            return true;

        const result = await WorkflowLogic.evaluateEventTaskCondition(task.condition!);
        if (task.triggeredOn === TriggeredOn.ConditionIsTrue)
            return result;

        const last = await CaseQueries.conditionResults(task).orderByDescending(a => a.creationDate).firstOrNull();

        await WorkflowEventTaskConditionResultEntity.create({
            workflowEventTask: task.toLite(),
            result,
        }).save();

        return result && (last == null || !last.result);
    }
}
