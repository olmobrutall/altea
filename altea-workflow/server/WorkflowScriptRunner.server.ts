import "@altea/altea/server";
import "@altea/altea/data/globals/arrayExtensions";
import { table } from "@altea/altea/server/table";
import { Operations } from "@altea/altea/server/operationLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserWithClaims } from "@altea/altea/data/security";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { retrieve } from "@altea/altea/server/Database";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal, type uuid } from "@altea/altea/data/basics";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { WorkflowActivityEntity } from "../data/WorkflowNodes";
import { CaseActivityEntity, CaseActivityOperation } from "../data/CaseActivity";
import type { WorkflowScriptRunnerState } from "../data/WorkflowDtos";
import { WorkflowLogic } from "./WorkflowLogic.server";

// Port of Signum.Workflow's WorkflowScriptRunner.cs — the background loop that executes SCRIPT activities:
// claim a batch of pending ones, run each in its own transaction, and back off (or take the ScriptException
// connection) when one throws.
//
// altea divergences — the same three the altea-processes / altea-scheduler runners document:
//  - Signum's `Thread` + `AutoResetEvent` + `Timer` become ONE in-process pump: `wakeUp()` sets a flag and
//    schedules a pass, and a pass that is already running just marks "run again". No lock, no thread.
//  - `CacheLogic.WithSqlDependency` / `SetSqlDependency` do NOT port: Node's SQL Server driver has no query
//    notifications (the reason altea-cache broadcasts instead). The periodic timer plus `wakeUpOnCommit` (a
//    fresh script activity was just saved) covers the same ground.
//  - `SystemEventLogLogic.Log` has no altea counterpart; the two lines are console-logged.
//  - `HealthCheckResult` is not ported (no health-check endpoint in altea yet) — `executionState()` carries
//    the same facts and the panel shows them.

export namespace WorkflowScriptRunner {

    let timer: NodeJS.Timeout | null = null;
    let nextPlannedExecution: Temporal.PlainDateTime | null = null;
    let running = false;
    let cancelRequested = false;
    let queuedItems = 0;
    let processIdentifier: uuid = newGuid();
    let initialDelayMilliseconds: number | null = null;

    /** True while a pass is executing; a wakeUp during a pass sets `runAgain` instead of starting a second. */
    let pumping = false;
    let runAgain = false;

    export function executionState(): WorkflowScriptRunnerState {
        return {
            running,
            initialDelayMilliseconds,
            currentProcessIdentifier: processIdentifier,
            scriptRunnerPeriod: WorkflowLogic.configuration().scriptRunnerPeriod,
            nextPlannedExecution: nextPlannedExecution?.toString() ?? null,
            isCancelationRequested: cancelRequested,
            queuedItems,
        };
    }

    /** Signum's StartRunningScriptsAfter — used by the host so a boot-time restart does not run scripts
     *  before the schema is ready. */
    export function startRunningScriptsAfter(delayMilliseconds: number): void {
        initialDelayMilliseconds = delayMilliseconds;
        const t = setTimeout(() => startRunningScripts(), delayMilliseconds);
        t.unref?.();
    }

    export function startRunningScripts(): void {
        if (running)
            throw new Error("WorkflowScriptRunner process is already running");

        console.log("Start WorkflowScriptRunner");
        running = true;
        cancelRequested = false;
        wakeUp("StartRunningScripts");
        setTimer();
    }

    export function stop(): void {
        if (!running)
            throw new Error("WorkflowScriptRunner is not running");

        using _prof = HeavyProfiler.log("WorkflowScriptRunner", () => "Stopping process");
        cancelRequested = true;
        running = false;
        nextPlannedExecution = null;
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
        console.log("Stop WorkflowScriptRunner");
    }

    /** Signum's WakeupOnCommit — a fresh script activity was saved, so run as soon as the transaction lands. */
    export function wakeUpOnCommit(): void {
        Transaction.postRealCommit(async () => { wakeUp("Save Transaction Commit"); });
    }

    export function wakeUp(reason: string): void {
        if (!running)
            return;

        using _prof = HeavyProfiler.log("WorkflowScriptRunner WakeUp", () => "WakeUp! " + reason);

        if (pumping) {
            runAgain = true;
            return;
        }

        void pump();
    }

    async function pump(): Promise<void> {
        pumping = true;
        try {
            do {
                runAgain = false;
                try {
                    await onePass();
                } catch (error) {
                    await ExceptionLogic.logException(error, e => {
                        e.controllerName = "WorkflowScriptRunner";
                        e.actionName = "ExecuteProcess";
                    }).catch(() => { /* logging must never break the loop */ });
                }
            } while (runAgain && !cancelRequested);
        } finally {
            pumping = false;
            if (running)
                setTimer();
        }
    }

    /** Signum's inner `while (queuedItems > 0 || RecruitQueuedItems())` body. */
    async function onePass(): Promise<void> {
        using _prof = HeavyProfiler.log("WorkflowScriptRunner", () => "Execute process");

        const systemUser = await AuthLogic.systemUser();
        if (systemUser == null)
            throw new Error("WorkflowScriptRunner needs AuthLogic.systemUserName to be set");

        await UserHolder.withUser(new UserWithClaims(systemUser), async () => {
            nextPlannedExecution = null;

            // A fresh identifier per pass, so a row claimed by a previous pass is not picked up twice.
            const previousIdentifier = processIdentifier;
            processIdentifier = newGuid();

            if (!await recruitQueuedItems())
                return;

            const chunkSize = WorkflowLogic.configuration().chunkSizeRunningScripts;

            while (queuedItems > 0) {
                if (cancelRequested)
                    return;

                const items = await pendingQuery(previousIdentifier).top(chunkSize).toArray();
                queuedItems = items.length;

                for (const caseActivity of items) {
                    if (cancelRequested)
                        return;

                    try {
                        await Transaction.forceNew(async () =>
                            await Operations.execute(caseActivity, CaseActivityOperation.ScriptExecute));
                    } catch {
                        // Signum: on failure, either schedule a retry per the strategy, or take the
                        // ScriptException connection when the strategy is exhausted.
                        try {
                            const ca = await retrieve(CaseActivityEntity, caseActivity.id!);
                            const retry = (ca.workflowActivity as WorkflowActivityEntity).script!.retryStrategy;
                            const nextDate = retry?.nextDate(ca.scriptExecution!.retryCount) ?? null;
                            if (nextDate == null)
                                await Transaction.forceNew(() =>
                                    Operations.execute(ca, CaseActivityOperation.ScriptFailureJump));
                            else
                                await Transaction.forceNew(() =>
                                    Operations.execute(ca, CaseActivityOperation.ScriptScheduleRetry, nextDate));
                        } catch (inner) {
                            await ExceptionLogic.logException(inner).catch(() => { });
                            throw inner;
                        }
                    }
                    queuedItems--;
                }

                queuedItems = await pendingQuery(previousIdentifier).count();
            }
        });
    }

    function pendingQuery(identifier: uuid) {
        return table(CaseActivityEntity).filter(m =>
            !m.workflow().hasExpired()
            && m.doneDate == null
            && m.scriptExecution!.processIdentifier === identifier);
    }

    /** Signum's RecruitQueuedItems — CLAIM the due rows by stamping this pass's identifier on them. */
    async function recruitQueuedItems(): Promise<boolean> {
        const config = WorkflowLogic.configuration();
        const firstDate = config.avoidExecutingScriptsOlderThan == null ? null
            : Clock.now.add({ hours: -config.avoidExecutingScriptsOlderThan });
        const now = Clock.now;
        const identifier = processIdentifier;

        queuedItems = await ExecutionMode.global(() => table(CaseActivityEntity)
            .filter(ca => !ca.workflow().hasExpired()
                && ca.doneDate == null
                && (firstDate == null || Temporal.PlainDateTime.compare(firstDate, ca.scriptExecution!.nextExecution) < 0)
                && Temporal.PlainDateTime.compare(ca.scriptExecution!.nextExecution, now) < 0)
            .executeUpdatePart(ca => ca.scriptExecution!, () => ({ processIdentifier: identifier })));

        return queuedItems > 0;
    }

    function setTimer(): void {
        if (timer != null)
            clearTimeout(timer);

        const periodSeconds = WorkflowLogic.configuration().scriptRunnerPeriod;
        nextPlannedExecution = Clock.now.add({ seconds: periodSeconds });
        timer = setTimeout(() => wakeUp("TimerNextExecution"), periodSeconds * 1000);
        timer.unref?.();
    }
}

function newGuid(): uuid {
    return (globalThis as { crypto?: { randomUUID(): string } }).crypto!.randomUUID() as uuid;
}
