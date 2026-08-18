import "@altea/altea/server"; // installs Entity.save()/delete()
import { hostname } from "node:os";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { retrieve } from "@altea/altea/server/Database";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import type { Type } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { UserWithClaims, type IUserEntity } from "@altea/altea/data/security";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import {
    ScheduledTaskEntity, ScheduledTaskLogEntity, SchedulerTaskExceptionLineEntity,
    type ITaskEntity,
} from "../data/Scheduler";
import type { SchedulerState, SchedulerHealth } from "../data/SchedulerState";
import { HolidayCalendarLogic } from "./HolidayCalendarLogic.server";
import { SchedulerLogic } from "./SchedulerLogic.server";

// Port of Signum.Scheduler's ScheduleTaskRunner.cs — the IN-PROCESS scheduler: a queue of
// (scheduled task → next date) ordered by date, and ONE timer armed for the earliest of them. When it
// fires, every task now due is started and re-queued at its following occurrence.
//
// altea divergences, documented inline:
//  - `System.Threading.Timer` → `setTimeout`, and the `lock (priorityQueue)` disappears: node runs the
//    callback on the single event loop, so the queue is only ever touched between awaits. What Signum's
//    lock protected against (a reload racing the tick) is handled by re-reading the queue after each await.
//  - Signum's `PriorityQueue<T>` → a plain array kept sorted by next date. The queue holds one entry per
//    ACTIVE scheduled task (tens, not thousands), so an O(n) insert is cheaper than a heap.
//  - `Task.Run(...)` (thread-pool fire-and-forget) → an un-awaited async call whose rejection is logged, so
//    an exploding task can never take the process down.
//  - `EntityCache(ForceNew)` has no altea counterpart (no identity-map scope beyond a retriever); each run
//    already gets its own `Transaction.forceNew`, which is what mattered.
//  - `AuthLogic.Disable()` → `ExecutionMode.global`; `UserHolder.UserSession(user)` → `UserHolder.withUser`.
//  - `SystemEventLogLogic.Log(...)` is not ported (no system-event-log module) — the start/stop transitions
//    are reported through the panel's state instead.
//  - The schedule rules evaluate SYNCHRONOUSLY (they are isomorphic — the editors preview them), but a
//    weekday rule needs its holiday calendar, which lives behind an async cache. So the planner warms that
//    cache (HolidayCalendarLogic.warm) before it advances any rule.

export namespace ScheduleTaskRunner {

    interface ScheduledTaskPair {
        scheduledTask: ScheduledTaskEntity;
        nextDate: Temporal.PlainDateTime;
    }

    /** Signum's `SchedulerMargin` — half a second, to stabilise sub-day rules. */
    const schedulerMarginMilliseconds = 500;

    let queue: ScheduledTaskPair[] = [];
    let timer: NodeJS.Timeout | undefined;
    let nextExecution: Temporal.PlainDateTime | undefined;
    let started = false;

    /** Signum's `InitialDelayMilliseconds` — set by startScheduledTasksAfter, and what tells the health
     *  check whether "stopped" means "disabled" or "broken". */
    export let initialDelayMilliseconds: number | undefined = undefined;

    /** Signum's `RunningTasks` — the log row of every task running right now, with its context. */
    export const runningTasks = new Map<ScheduledTaskLogEntity, ScheduledTaskContext>();

    export function running(): boolean {
        return started;
    }

    export function machineName(): string {
        try { return hostname(); } catch { return "unknown"; }
    }

    export function applicationName(): string {
        return process.env["ALTEA_APP_NAME"] ?? "eastwind";
    }

    // ---- start / stop -----------------------------------------------------------------------------------

    export async function startScheduledTasks(): Promise<void> {
        if (started)
            throw new Error(`The scheduler is already running in ${machineName()}`);

        started = true;
        await reloadPlan();
    }

    /** Signum's `StartScheduledTaskAfter` — what an app calls at boot so the first tick is not during startup. */
    export function startScheduledTasksAfter(delayMilliseconds: number): void {
        initialDelayMilliseconds = delayMilliseconds;
        setTimeout(() => { void startScheduledTasks().catch(logRunnerError("startScheduledTasksAfter")); }, delayMilliseconds)
            .unref(); // never hold the process open just for the initial delay
    }

    export function stopScheduledTasks(): void {
        if (!started)
            throw new Error(`The scheduler is already stopped in ${machineName()}`);

        started = false;
        clearTimer();
        queue = [];
        nextExecution = undefined;
    }

    /** Signum's `ScheduledTasksLazy_OnReset` — the task list changed, so re-plan (a beat later, so a save's
     *  own transaction has committed). */
    export function scheduledTasksChanged(): void {
        if (!started)
            return;
        setTimeout(() => { void reloadPlan().catch(logRunnerError("scheduledTasksChanged")); }, 1000).unref();
    }

    /** Signum's `StopRunningTasks` — cancel everything in flight (called on shutdown). */
    export function stopRunningTasks(): void {
        for (const ctx of runningTasks.values())
            ctx.cancel();
    }

    // ---- planning ---------------------------------------------------------------------------------------

    /** Signum's `ReloadPlan`: for every active task, when is it next due — given when it last ran. */
    async function reloadPlan(): Promise<void> {
        if (!started)
            return;

        await ExecutionMode.global(async () => {
            // A weekday rule consults its holiday calendar synchronously below, so warm that cache first.
            await HolidayCalendarLogic.warm();

            const tasks = await SchedulerLogic.scheduledTasks.value();
            const lastExecutions = await SchedulerLogic.lastExecutionByTask();
            const now = Clock.now;

            queue = tasks.map(scheduledTask => {
                const previous = lastExecutions.get(String(scheduledTask.id));

                const next = previous == null
                    ? scheduledTask.rule.next(scheduledTask.rule.startingOn)
                    : scheduledTask.rule.next(previous.add({ milliseconds: schedulerMarginMilliseconds }));

                // Signum's `isMiss`: a task whose slot passed while the app was down runs immediately.
                return { scheduledTask, nextDate: Temporal.PlainDateTime.compare(next, now) < 0 ? now : next };
            });

            sortQueue();
            setTimer();
        });
    }

    function sortQueue(): void {
        queue.sort((a, b) => Temporal.PlainDateTime.compare(a.nextDate, b.nextDate));
    }

    function clearTimer(): void {
        if (timer != null)
            clearTimeout(timer);
        timer = undefined;
    }

    // Signum's SetTimer: arm ONE timer for the head of the queue.
    function setTimer(): void {
        clearTimer();

        nextExecution = queue.length === 0 ? undefined : queue[0].nextDate;
        if (nextExecution == null)
            return;

        const milliseconds = Math.min(
            Math.max(0, nextExecution.since(Clock.now).total({ unit: "milliseconds" })) + schedulerMarginMilliseconds,
            // setTimeout silently fires immediately above ~24.8 days, so cap and re-arm.
            2 ** 31 - 1);

        timer = setTimeout(() => { void onTimer().catch(logRunnerError("onTimer")); }, milliseconds);
        timer.unref(); // a pending tick must not keep a CLI process alive
    }

    // Signum's TimerCallback: start everything now due, re-queue each at its following occurrence, re-arm.
    async function onTimer(): Promise<void> {
        if (!started)
            return;

        try {
            await ExecutionMode.global(async () => {
                await HolidayCalendarLogic.warm();

                const now = Clock.now;
                while (queue.length > 0 && Temporal.PlainDateTime.compare(queue[0].nextDate, now) < 0) {
                    const pair = queue.shift()!;

                    // Fire and forget, exactly like Signum's Task.Run — a long task must not delay the
                    // tick, and its own failure is logged inside executeAsync.
                    executeAsync(pair.scheduledTask.task, pair.scheduledTask, pair.scheduledTask.user);

                    pair.nextDate = pair.scheduledTask.rule.next(now);
                    queue.push(pair);
                    sortQueue();
                }
            });
        } finally {
            // Always re-arm, even if a rule threw: otherwise one bad rule stops the whole scheduler.
            if (started)
                setTimer();
        }
    }

    // ---- execution --------------------------------------------------------------------------------------

    /** Signum's `ExecuteAsync` — run a task without waiting for it, logging whatever it throws. */
    export function executeAsync(task: ITaskEntity, scheduledTask: ScheduledTaskEntity | null, user: Lite<IUserEntity>): void {
        void executeSync(task, scheduledTask, user).catch(logRunnerError("executeAsync"));
    }

    /** Signum's `SurroundExecuteTask` — wrap every run (metrics, isolation, …). Each handler returns a
     *  cleanup called when the run finishes, however it finishes. */
    export const surroundExecuteTask: ((task: ITaskEntity, scheduledTask: ScheduledTaskEntity | null, user: Lite<IUserEntity>) => () => void)[] = [];

    /** Signum's `ExecuteSync`: log the start in its OWN transaction (so the row exists while the task runs),
     *  run the task as its user, then close the log — with the exception if it threw. */
    export async function executeSync(
        task: ITaskEntity,
        scheduledTask: ScheduledTaskEntity | null,
        user: Lite<IUserEntity>,
    ): Promise<ScheduledTaskLogEntity> {

        const cleanups = surroundExecuteTask.map(h => h(task, scheduledTask, user));

        try {
            const log = ScheduledTaskLogEntity.create({
                task,
                scheduledTask: scheduledTask?.toLite() ?? null,
                startTime: Clock.now,
                machineName: machineName(),
                applicationName: applicationName(),
                user,
            });

            await ExecutionMode.global(() => Transaction.forceNew(async () => { await log.save(); }));

            const ctx = new ScheduledTaskContext(log);
            runningTasks.set(log, ctx);

            // The task runs AS ITS USER — that is the whole point of ScheduledTask.user: the rules the task
            // is subject to are the user's, not the scheduler's.
            const userEntity = await ExecutionMode.global(() => retrieve(user.entityType as Type<Entity>, user.id!));

            try {
                await UserHolder.withUser(new UserWithClaims(userEntity as IUserEntity), async () => {
                    await Transaction.forceNew(async () => {
                        log.productEntity = await SchedulerLogic.executeTask(task, ctx);
                    });
                });

                await ExecutionMode.global(() => Transaction.forceNew(async () => {
                    log.endTime = Clock.now;
                    log.remarks = remarksOf(ctx);
                    await log.save();
                }));
            } catch (error) {
                await ExecutionMode.global(async () => {
                    const exception = await ExceptionLogic.logException(error, e => {
                        e.controllerName = "SchedulerLogic";
                        e.actionName = "executeSync";
                    });

                    await Transaction.forceNew(async () => {
                        log.exception = exception.toLite();
                        log.endTime = Clock.now;
                        log.remarks = remarksOf(ctx);
                        await log.save();
                    });
                });
                throw error;
            } finally {
                runningTasks.delete(log);
                for (const handler of SchedulerLogic.onFinally)
                    handler(log);
            }

            return log;
        } finally {
            for (const cleanup of cleanups.reverse())
                cleanup();
        }
    }

    function remarksOf(ctx: ScheduledTaskContext): BigStringEmbedded {
        const remarks = new BigStringEmbedded();
        remarks.text = ctx.text() === "" ? null : ctx.text();
        return remarks;
    }

    // Persisting an ExceptionEntity is a WRITE, so it needs a transaction of its own — these callbacks run
    // from timers and un-awaited tasks, where there is none ("Transaction not started" otherwise).
    function logRunnerError(actionName: string): (error: unknown) => void {
        return error => {
            console.error(`[ScheduleTaskRunner] ${actionName}:`, error);
            void ExecutionMode.global(() => Transaction.forceNew(() => ExceptionLogic.logException(error, e => {
                e.controllerName = "SchedulerLogic";
                e.actionName = actionName;
            }))).catch(() => { /* logging the failure failed — nothing left to do but not crash */ });
        };
    }

    // ---- the panel's view ------------------------------------------------------------------------------

    /** Signum's `GetSchedulerState`. */
    export function getSchedulerState(): SchedulerState {
        return {
            running: started,
            initialDelayMilliseconds: initialDelayMilliseconds ?? null,
            schedulerMarginMilliseconds,
            nextExecution: nextExecution?.toString() ?? null,
            machineName: machineName(),
            applicationName: applicationName(),
            serverTimeZone: Temporal.Now.timeZoneId(),
            serverLocalTime: Clock.now.toString(),
            queue: queue.map(pair => ({
                scheduledTask: pair.scheduledTask.toLite(),
                rule: pair.scheduledTask.rule.toString(),
                nextDate: pair.nextDate.toString(),
            })),
            runningTask: [...runningTasks].map(([log, ctx]) => ({
                schedulerTaskLog: log.toLite(),
                startTime: log.startTime.toString(),
                remarks: ctx.text(),
            })),
        };
    }

    /** Signum's `GetHealthStatus`: stopped is only UNHEALTHY when the app meant to start it. */
    export function getHealthStatus(): SchedulerHealth {
        return started ? { status: "Healthy", description: "Running" }
            : initialDelayMilliseconds == null ? { status: "Healthy", description: "Disabled" }
                : { status: "Unhealthy", description: "Not Running!" };
    }
}

/** Port of Signum's ScheduledTaskContext — what a running task is handed: a cancellation signal, a place to
 *  write progress (surfaced live on the panel), and `forEach`, which isolates each element so one failure is
 *  recorded as an exception LINE instead of losing the whole run. */
export class ScheduledTaskContext {

    private readonly lines: string[] = [];
    private readonly controller = new AbortController();

    constructor(readonly log: ScheduledTaskLogEntity) { }

    /** Signum's `CancellationToken` — a task that iterates must check it (forEach does). */
    get signal(): AbortSignal {
        return this.controller.signal;
    }

    cancel(): void {
        this.controller.abort();
    }

    /** Signum's `StringBuilder` — progress the panel shows while the task runs. */
    writeLine(line: string): void {
        this.lines.push(line);
    }

    text(): string {
        return this.lines.join("\n");
    }

    /** Signum's `Foreach`: each element in its own transaction, and a failing element becomes a
     *  SchedulerTaskExceptionLine rather than aborting the run. Cancellation still aborts. */
    async forEach<T>(collection: Iterable<T>, elementId: (item: T) => string, action: (item: T) => Promise<void>): Promise<void> {
        for (const item of collection) {
            this.signal.throwIfAborted();

            using _prof = HeavyProfiler.log("ForEach", () => elementId(item));

            try {
                await Transaction.forceNew(() => action(item));
            } catch (error) {
                if (this.signal.aborted)
                    throw error;

                await ExecutionMode.global(async () => {
                    const exception = await ExceptionLogic.logException(error);
                    await Transaction.forceNew(async () => {
                        const line = SchedulerTaskExceptionLineEntity.create({
                            exception: exception.toLite(),
                            schedulerTaskLog: this.log.toLite(),
                        });
                        line.elementInfo.text = elementId(item);
                        await line.save();
                    });
                });
            }
        }
    }

    /** Signum's `ForeachWriting` — the same, echoing each element (and its error) into the remarks. */
    async forEachWriting<T>(collection: Iterable<T>, elementId: (item: T) => string, action: (item: T) => Promise<void>): Promise<void> {
        await this.forEach(collection, elementId, async item => {
            this.writeLine(elementId(item));
            try {
                await action(item);
            } catch (error) {
                this.writeLine(`   Error: ${error instanceof Error ? error.message : String(error)}`);
                throw error;
            }
        });
    }
}
