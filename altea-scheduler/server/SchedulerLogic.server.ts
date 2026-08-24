import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { Graph } from "@altea/altea/server/graph";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";

import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import type { Type } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";
import { HolidayCalendarEntity } from "../data/HolidayCalendar";
import {
    ScheduledTaskEntity, ScheduledTaskLogEntity, SchedulerTaskExceptionLineEntity,
    ScheduledTaskOperation, ScheduledTaskLogOperation, ITaskOperation, SchedulerPermission,
    SchedulerMessage, SimpleTaskSymbol, type ITaskEntity,
} from "../data/Scheduler";
import { HolidayCalendarLogic } from "./HolidayCalendarLogic.server";
import { SimpleTaskLogic } from "./SimpleTaskLogic.server";
import { ScheduleTaskRunner, type ScheduledTaskContext } from "./ScheduleTaskRunner.server";
import { SchedulerServer } from "./SchedulerServer.server";

// Port of Signum.Scheduler's SchedulerLogic.cs — the module's `start(sb)`: the three tables, the operations,
// the task-dispatch registry, and the cache of tasks this host should run.
//
// altea divergences, documented inline:
//  - Signum's `Polymorphic<Func<ITaskEntity, ScheduledTaskContext, Lite<IEntity>?>> ExecuteTask` → the
//    `registerExecuteTask` registry below, keyed by constructor and walking the prototype chain, so a
//    handler registered for a base task type serves its subclasses (which is what Polymorphic gives).
//  - `QueryLogic.Expressions.Register(...)` for Executions / LastExecution / ExceptionLines is NOT ported:
//    those are @quoted expression MEMBERS in altea, and putting them on the entities would make the
//    isomorphic data layer import the server query API. The panel reaches the same rows through explicit
//    filters instead.
//  - `ExceptionLogic.DeleteLogs` (the log-cleanup hook) has no altea counterpart yet.
//  - `UserAssetsImporter.Register(...)` goes with the XML deferral noted on the entities.

export namespace SchedulerLogic {

    /** Signum's `ScheduledTasksLazy` — the ACTIVE tasks this machine/application should run. */
    export let scheduledTasks: ResetLazy<ScheduledTaskEntity[]> = null!;

    /** Signum's `OnFinally` — every run notifies these, however it ended. */
    export const onFinally: ((log: ScheduledTaskLogEntity) => void)[] = [];

    // Signum's Polymorphic ExecuteTask, keyed by task constructor.
    type ExecuteTaskHandler = (task: ITaskEntity, ctx: ScheduledTaskContext) => Promise<Lite<Entity> | null>;
    const executeTaskHandlers = new Map<Function, ExecuteTaskHandler>();

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        HolidayCalendarLogic.start(sb);

        // altea has no PermissionLogic registry: a PermissionSymbol declared with init() is seeded into the
        // symbol table by PermissionAuthLogic (see its start), so there is nothing to register here — the
        // symbol just has to be REACHED, which importing the data module does.
        void SchedulerPermission.ViewSchedulerPanel;

        SimpleTaskLogic.start(sb);

        sb.include(ScheduledTaskEntity)
            .withSave(ScheduledTaskOperation.Save)
            .withQuery();

        sb.include(ScheduledTaskLogEntity)
            .withIndex(l => l.scheduledTask, undefined, l => l.startTime)
            .withQuery();

        sb.include(SchedulerTaskExceptionLineEntity)
            .withQuery();

        // Signum's Delete: the log rows OUTLIVE the task (they are the history), so they are detached
        // rather than cascaded, and the rule — a Part owned by this task — goes with it.
        new Graph.Delete(ScheduledTaskEntity, ScheduledTaskOperation.Delete, {
            delete: async (scheduledTask: ScheduledTaskEntity) => {
                await table(ScheduledTaskLogEntity)
                    .filter(l => l.scheduledTask!.is(scheduledTask))
                    .executeUpdate(l => ({ scheduledTask: null }));

                const rule = scheduledTask.rule;
                await scheduledTask.delete();
                await rule.delete();
            },
        }).register();

        // Signum's CancelRunningTask: only meaningful while the run is in flight.
        new Graph.Execute(ScheduledTaskLogEntity, ScheduledTaskLogOperation.CancelRunningTask, {
            canExecute: (log: ScheduledTaskLogEntity) =>
                findRunning(log) != null ? null : SchedulerMessage.TaskIsNotRunning.niceToString(),
            execute: (log: ScheduledTaskLogEntity) => { findRunning(log)?.cancel(); },
        }).register();

        // Signum's ITaskOperation.ExecuteSync — "run it now", from the task's own view.
        // Signum registers this on the ITaskEntity INTERFACE and lets its polymorphic registry fan it out.
        // A TS interface has no runtime constructor, so it cannot be an `entityType`: the operation is
        // owned by the framework's own built-in implementor here, and every OTHER task type adds itself
        // through `registerExecuteTask` below (OperationLogic.registerForType) — which is the same set
        // Signum's polymorphic dispatch would cover, made explicit.
        new Graph.ConstructFrom(SimpleTaskSymbol, ITaskOperation.ExecuteSync, {
            construct: async (task: ITaskEntity) => {
                const user = UserHolder.currentUserLite();
                if (user == null)
                    throw new Error("ITaskOperation.ExecuteSync: there is no current user to run the task as");
                return await ScheduleTaskRunner.executeSync(task, null, user);
            },
        }).register();

        // Signum's ScheduledTasksLazy + its OnReset → re-plan whenever the task list changes. A task pinned
        // to another machine (or another application on the same machine) is not ours to run.
        scheduledTasks = sb.globalLazy(
            async () => (await table(ScheduledTaskEntity).toArray()).filter(t => !t.suspended
                && (t.machineName === ScheduledTaskEntity.None
                    || (t.machineName === ScheduleTaskRunner.machineName() && t.applicationName === ScheduleTaskRunner.applicationName()))),
            { invalidateWith: [ScheduledTaskEntity] });

        // ResetLazy carries ONE onReset callback (Signum's event allows many); chain onto whatever is there.
        const previousOnReset = scheduledTasks.onReset;
        scheduledTasks.onReset = () => {
            previousOnReset?.();
            ScheduleTaskRunner.scheduledTasksChanged();
        };

        if (sb.webBuilder)
            SchedulerServer.start(sb.webBuilder);
    }

    /** Signum's `ExecuteTask.Register(...)` — how to run a task of this type. */
    export function registerExecuteTask<T extends ITaskEntity>(
        taskType: Type<T>,
        handler: (task: T, ctx: ScheduledTaskContext) => Promise<Lite<Entity> | null>,
    ): void {
        executeTaskHandlers.set(taskType as unknown as Function, handler as ExecuteTaskHandler);
        // A type that can be run IS a type ITaskOperation.ExecuteSync applies to (see the note there).
        OperationLogic.registerForType(ITaskOperation.ExecuteSync, taskType as unknown as Function);
    }

    /** Signum's `ExecuteTask.Invoke(task, ctx)` — dispatch, walking up the prototype chain so a handler
     *  registered on a base task type serves its subclasses (Polymorphic's behaviour). */
    export async function executeTask(task: ITaskEntity, ctx: ScheduledTaskContext): Promise<Lite<Entity> | null> {
        for (let ctor: Function | null = task.constructor; ctor != null; ctor = Object.getPrototypeOf(ctor) as Function | null) {
            const handler = executeTaskHandlers.get(ctor);
            if (handler != null)
                return await handler(task, ctx);
        }

        throw new Error(`SchedulerLogic.executeTask is not registered for ${task.constructor.name}`);
    }

    /** When each scheduled task last STARTED — what ReloadPlan advances its rule from. Keyed by the task's
     *  id as a string (a PrimaryKey may be a number or a uuid). */
    export async function lastExecutionByTask(): Promise<Map<string, Temporal.PlainDateTime>> {
        const rows = await ExecutionMode.global(async () => await table(ScheduledTaskLogEntity)
            .filter(l => l.scheduledTask != null)
            .map(l => ({ scheduledTask: l.scheduledTask, startTime: l.startTime }))
            .toArray());

        const result = new Map<string, Temporal.PlainDateTime>();
        for (const row of rows) {
            const key = String(row.scheduledTask!.id);
            const previous = result.get(key);
            if (previous == null || Temporal.PlainDateTime.compare(row.startTime, previous) > 0)
                result.set(key, row.startTime);
        }
        return result;
    }

    /** The in-flight context of a log row, matched by ID (the operation receives a freshly retrieved
     *  instance, not the one the runner put in the map). */
    function findRunning(log: ScheduledTaskLogEntity): ScheduledTaskContext | undefined {
        for (const [running, ctx] of ScheduleTaskRunner.runningTasks)
            if (String(running.id) === String(log.id))
                return ctx;
        return undefined;
    }

    /** The default HolidayCalendar, for an app seeding a weekday rule. */
    export async function defaultHolidayCalendar(): Promise<HolidayCalendarEntity | undefined> {
        return await HolidayCalendarLogic.defaultHolidayCalendar.value();
    }

    /** Retrieve a task's user (used by the terminal / seeds that build a ScheduledTask by hand). */
    export async function retrieveUser(user: Lite<Entity>): Promise<Entity> {
        return await retrieve(user.entityType as Type<Entity>, user.id!);
    }
}
