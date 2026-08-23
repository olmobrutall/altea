import "@altea/altea/server"; // installs Entity.save()/delete()
import { hostname } from "node:os";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { table } from "@altea/altea/server/table";
import type { Query } from "@altea/altea/server/query";
import { retrieve } from "@altea/altea/server/Database";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import type { Type } from "@altea/altea/data/entity";
import { Temporal, Decimal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { UserWithClaims, type IUserEntity } from "@altea/altea/data/security";
import { ProcessEntity, ProcessExceptionLineEntity, ProcessStateEnum } from "../data/Processes";
import type { ProcessLogicState, ProcessHealth } from "../data/ProcessLogicState";
import { ProcessLogic, type IProcessAlgorithm } from "./ProcessLogic.server";

// Port of Signum.Processes' ProcessRunner.cs — the IN-PROCESS process runner: a pump that promotes due
// PLANNED processes to QUEUED, starts up to `maxDegreeOfParallelism` of them, and suspends the ones asked to
// stop. Unlike the scheduler's single timer, this one is driven by three things: an explicit wake-up (an
// operation just queued something), a periodic poll (another host may have queued something), and a timer for
// the next planned date.
//
// altea divergences, documented inline:
//  - Signum blocks a dedicated thread on an `AutoResetEvent` and loops. Node has one event loop, so `wakeUp`
//    COALESCES into a single pending `pump()` (an extra wake-up while a pump is in flight sets a flag and the
//    pump runs again), which gives the same "never miss a signal, never run two loops" property without a
//    thread or a lock. `lock (executing)` is likewise unnecessary — the map is only touched between awaits.
//  - `CacheLogic.ServerBroadcast` / SqlDependency invalidation (Signum's cross-host push) is NOT ported: the
//    periodic poll is what notices another host's work. `poolingPeriodMilliseconds` is therefore the latency
//    for a shared process, exactly as in a Signum deployment without SqlDependency.
//  - `Task.Run` → an un-awaited async call whose rejection is logged, so a failing algorithm cannot take the
//    process down; timers are `unref()`d so a pending poll never holds a CLI process open.
//  - `AuthLogic.Disable()` → `ExecutionMode.global`; `UserHolder.UserSession(user)` → `UserHolder.withUser`.
//  - `SystemEventLogLogic` is not ported; the in-memory `log` the panel shows takes its place.

export namespace ProcessRunner {

    /** Signum's `MaxDegreeOfParallelism` — how many processes may execute at once on this host. */
    export let maxDegreeOfParallelism = 2;
    /** Signum's `PoolingPeriodMilliseconds` — how often to look for work queued by another host. */
    export let poolingPeriodMilliseconds = 30 * 1000;
    /** Signum's `OnFinally` — every finished process notifies these, however it ended. */
    export const onFinally: ((executing: ExecutingProcess) => void)[] = [];

    const executing = new Map<string, ExecutingProcess>();

    let started = false;
    let initialDelayMilliseconds: number | undefined = undefined;
    let nextPlannedExecution: Temporal.PlainDateTime | undefined = undefined;
    let plannedTimer: NodeJS.Timeout | undefined;
    let periodicTimer: NodeJS.Timeout | undefined;

    // The coalescing wake-up (see the header note).
    let pumping = false;
    let pumpAgain = false;

    // Signum's LogStringBuilder — a bounded in-memory trace of the runner's decisions, shown on the panel.
    const logLines: string[] = [];
    let logEnabled = false;

    export function running(): boolean {
        return started;
    }

    export function machineName(): string {
        try { return hostname(); } catch { return "unknown"; }
    }

    export function applicationName(): string {
        return process.env["ALTEA_APP_NAME"] ?? "eastwind";
    }

    export function enableLog(enabled: boolean): void {
        logEnabled = enabled;
        if (!enabled)
            logLines.length = 0;
    }

    export function log(line: string, ep?: ExecutingProcess): void {
        if (!logEnabled)
            return;
        logLines.push(`${Clock.now.toString()}${ep == null ? "" : " " + ep.currentProcess.toString()} ${line}`);
        if (logLines.length > 500)
            logLines.splice(0, logLines.length - 500);
    }

    // ---- start / stop -----------------------------------------------------------------------------------

    export async function startRunningProcesses(): Promise<void> {
        if (started)
            throw new Error(`The process runner is already running in ${machineName()}`);

        started = true;
        log("startRunningProcesses");

        // Signum's first act: anything this host claims to be running cannot be (the process just started),
        // so re-queue it. A SHARED suspended process is re-queued too — any host may pick it up.
        // The host identity is CAPTURED into consts: a call inside a query lambda has no SQL translation.
        const machine = machineName();
        const application = applicationName();
        const none = ProcessEntity.None;

        await ExecutionMode.global(() => Transaction.forceNew(async () => {
            await setAsQueued(table(ProcessEntity).filter(p =>
                (p.machineName == machine && p.applicationName == application
                    && (p.state == ProcessStateEnum.Executing || p.state == ProcessStateEnum.Suspending || p.state == ProcessStateEnum.Suspended))
                || (p.machineName == none && p.state == ProcessStateEnum.Suspended)));
        }));

        periodicTimer = setInterval(() => wakeUp("timerPeriodic"), poolingPeriodMilliseconds);
        periodicTimer.unref();

        wakeUp("startRunningProcesses");
    }

    /** Signum's `StartRunningProcessesAfter` — what an app calls at boot. */
    export function startRunningProcessesAfter(delayMilliseconds: number): void {
        initialDelayMilliseconds = delayMilliseconds;
        setTimeout(() => { void startRunningProcesses().catch(logRunnerError("startRunningProcessesAfter")); }, delayMilliseconds)
            .unref();
    }

    export function stopRunningProcesses(): void {
        if (!started)
            throw new Error(`The process runner is already stopped in ${machineName()}`);

        started = false;
        log("stopRunningProcesses");

        if (periodicTimer != null) clearInterval(periodicTimer);
        if (plannedTimer != null) clearTimeout(plannedTimer);
        periodicTimer = undefined;
        plannedTimer = undefined;
        nextPlannedExecution = undefined;

        // Signum cancels the token that gates NEW processes and leaves the running ones to notice; here the
        // running ones are cancelled outright, which is what a host shutting down wants.
        for (const ep of executing.values())
            ep.cancel();
    }

    /** Signum's `WakeUp` — something changed, look for work. Coalesced: at most one pump at a time. */
    export function wakeUp(reason: string): void {
        if (!started)
            return;

        log(`wakeUp: ${reason}`);

        if (pumping) {
            pumpAgain = true;
            return;
        }

        pumping = true;
        void (async () => {
            try {
                do {
                    pumpAgain = false;
                    await pump();
                } while (pumpAgain && started);
            } catch (error) {
                logRunnerError("pump")(error);
            } finally {
                pumping = false;
            }
        })();
    }

    /** Signum's `IsExecutingInThisMachien` — the Cancel operation refuses while the process is in flight. */
    export function isExecutingInThisMachine(process: Lite<ProcessEntity>): boolean {
        return executing.has(process.key());
    }

    // ---- the pump ---------------------------------------------------------------------------------------

    async function pump(): Promise<void> {
        using _prof = HeavyProfiler.log("ProcessRunner.pump");

        // Captured, not called inside the lambdas below — see startRunningProcesses. `isMineOrShared` is
        // likewise INLINED into each filter rather than factored out: the LINQ provider translates the
        // lambda's own expression tree, and a call to a local predicate is not part of it.
        const machine = machineName();
        const application = applicationName();
        const none = ProcessEntity.None;
        const shared = !ProcessLogic.justMyProcesses;

        await ExecutionMode.global(async () => {
            // 1. Planned processes whose time has come become Queued.
            const now = Clock.now;
            await Transaction.forceNew(async () => {
                await setAsQueued(table(ProcessEntity)
                    .filter(p => p.state == ProcessStateEnum.Planned && p.plannedDate! <= now));
            });

            // 2. Arm the timer for the next planned date that is still in the future.
            const plannedDates = await table(ProcessEntity)
                .filter(p => p.state == ProcessStateEnum.Planned
                    && ((p.machineName == machine && p.applicationName == application) || (shared && p.machineName == none)))
                .map(p => p.plannedDate)
                .toArray();

            setNextPlannedExecution(plannedDates.filter((d): d is Temporal.PlainDateTime => d != null));

            // 3. Anything asked to suspend: tell the in-flight run to stop cooperatively.
            const suspending = await table(ProcessEntity)
                .filter(p => p.state == ProcessStateEnum.Suspending
                    && p.machineName == machine && p.applicationName == application)
                .toArray();

            for (const process of suspending) {
                const ep = executing.get(process.toLite().key());
                if (ep != null && ep.currentProcess.state !== ProcessStateEnum.Finished)
                    ep.cancel();
                else if (ep == null)
                    // Nothing is running it here (a restart lost it) — it is safe to re-queue.
                    await Transaction.forceNew(async () => {
                        await setAsQueued(table(ProcessEntity).filter(p => p.id == process.id));
                    });
            }

            // 4. Fill the remaining capacity from the queue.
            const remaining = maxDegreeOfParallelism - executing.size;
            if (remaining <= 0)
                return;

            const queued = await table(ProcessEntity)
                .filter(p => p.state == ProcessStateEnum.Queued
                    && ((p.machineName == machine && p.applicationName == application) || (shared && p.machineName == none)))
                .toArray();

            // An algorithm that forbids parallel execution blocks its OWN kind, not the others.
            const busyNonParallel = new Set([...executing.values()]
                .filter(ep => !ep.algorithm.allowParallelExecution)
                .map(ep => ep.currentProcess.algorithm.key));

            const affordable = queued
                .filter(p => ProcessLogic.getProcessAlgorithm(p.algorithm).allowParallelExecution
                    || !busyNonParallel.has(p.algorithm.key))
                // Prefer the ones already pinned to this host, then oldest first (Signum's ordering).
                .sort((a, b) => Number(b.machineName === machine) - Number(a.machineName === machine)
                    || compareNullableDates(a.queuedDate, b.queuedDate))
                .slice(0, remaining);

            log(`queued=${queued.length} affordable=${affordable.length} executing=${executing.size}`);

            for (const process of affordable)
                await startOne(process);
        });
    }

    async function startOne(process: ProcessEntity): Promise<void> {
        const algorithm = ProcessLogic.getProcessAlgorithm(process.algorithm);
        const ep = new ExecutingProcess(algorithm, process);

        executing.set(process.toLite().key(), ep);
        log("created", ep);

        try {
            // Claims the row for this host IN THE DATABASE — the guard that stops two hosts running one
            // process (Signum's TakeForThisMachine, which also refuses if it is already Executing).
            await ep.takeForThisMachine();
        } catch (error) {
            executing.delete(process.toLite().key());
            logRunnerError("takeForThisMachine")(error);
            return;
        }

        // Fire and forget: the pump must not wait for a process that runs for an hour.
        void ep.execute()
            .catch(logRunnerError("execute"))
            .finally(() => {
                executing.delete(process.toLite().key());
                for (const handler of onFinally)
                    handler(ep);
                // Capacity freed — see whether anything else is waiting.
                wakeUp("process finished");
            });
    }

    function setNextPlannedExecution(dates: Temporal.PlainDateTime[]): void {
        if (plannedTimer != null)
            clearTimeout(plannedTimer);
        plannedTimer = undefined;

        const now = Clock.now;
        const future = dates.filter(d => Temporal.PlainDateTime.compare(d, now) > 0)
            .sort((a, b) => Temporal.PlainDateTime.compare(a, b));

        nextPlannedExecution = future[0];
        if (nextPlannedExecution == null)
            return;

        const milliseconds = Math.min(
            Math.max(0, nextPlannedExecution.since(now).total({ unit: "milliseconds" })),
            2 ** 31 - 1);

        plannedTimer = setTimeout(() => wakeUp("timerNextExecution"), milliseconds);
        plannedTimer.unref();
    }

    // ---- the panel's view -------------------------------------------------------------------------------

    export function executionState(): ProcessLogicState {
        return {
            running: started,
            initialDelayMilliseconds: initialDelayMilliseconds ?? null,
            maxDegreeOfParallelism,
            nextPlannedExecution: nextPlannedExecution?.toString() ?? null,
            justMyProcesses: ProcessLogic.justMyProcesses,
            machineName: machineName(),
            applicationName: applicationName(),
            log: logEnabled ? logLines.join("\n") : null,
            executing: [...executing.values()].map(ep => ({
                process: ep.currentProcess.toLite(),
                state: ep.currentProcess.state,
                progress: ep.currentProcess.progress?.toString() ?? null,
                isCancellationRequested: ep.signal.aborted,
                machineName: ep.currentProcess.machineName,
                applicationName: ep.currentProcess.applicationName,
            })),
        };
    }

    export function getHealthStatus(): ProcessHealth {
        return started ? { status: "Healthy", description: "Running" }
            : initialDelayMilliseconds == null ? { status: "Healthy", description: "Disabled" }
                : { status: "Unhealthy", description: "Not Running!" };
    }

    // ---- helpers ----------------------------------------------------------------------------------------

    /** Signum's set-based `SetAsQueued` — reset every run-specific field in ONE statement.
     *  The parameter is typed `Query<ProcessEntity>`, not a structural shape: the quote-transformer only
     *  rewrites a lambda when it can see the receiver is a Query, and a duck-typed parameter defeats that
     *  ("The following lambda has not been quoted" at runtime). */
    async function setAsQueued(query: Query<ProcessEntity>): Promise<number> {
        const now = Clock.now;
        const mine = ProcessLogic.justMyProcesses;
        return await query.executeUpdate(() => ({
            state: ProcessStateEnum.Queued,
            queuedDate: now,
            executionStart: null,
            executionEnd: null,
            suspendDate: null,
            progress: null,
            exception: null,
            exceptionDate: null,
            machineName: mine ? machineName() : ProcessEntity.None,
            applicationName: mine ? applicationName() : ProcessEntity.None,
        }));
    }

    function compareNullableDates(a: Temporal.PlainDateTime | null, b: Temporal.PlainDateTime | null): number {
        if (a == null) return b == null ? 0 : 1;
        if (b == null) return -1;
        return Temporal.PlainDateTime.compare(a, b);
    }

    // Persisting an ExceptionEntity is a WRITE, so it needs a transaction of its own — these callbacks run
    // from timers and un-awaited tasks, where there is none ("Transaction not started" otherwise).
    function logRunnerError(actionName: string): (error: unknown) => void {
        return error => {
            console.error(`[ProcessRunner] ${actionName}:`, error);
            log(`ERROR in ${actionName}: ${error instanceof Error ? error.message : String(error)}`);
            void ExecutionMode.global(() => Transaction.forceNew(() => ExceptionLogic.logException(error, e => {
                e.controllerName = "ProcessRunner";
                e.actionName = actionName;
            }))).catch(() => { /* logging the failure failed — nothing left to do but not crash */ });
        };
    }
}

/** Port of Signum's ExecutingProcess — the handle an algorithm gets: what it runs over, how to report
 *  progress, and whether it has been asked to stop. */
export class ExecutingProcess {

    private readonly controller = new AbortController();

    constructor(readonly algorithm: IProcessAlgorithm, public currentProcess: ProcessEntity) { }

    get data(): Lite<Entity> | null {
        return this.currentProcess.data;
    }

    /** Signum's `CancellationToken` — a long algorithm must check it (forEachLine does). */
    get signal(): AbortSignal {
        return this.controller.signal;
    }

    cancel(): void {
        this.controller.abort();
    }

    /** Signum's `ProgressChanged(position, count, status)`. */
    async progressChanged(position: number, count: number, status?: string): Promise<void> {
        if (position > count)
            throw new Error(`Position (${position}) should not be greater than count (${count}). Maybe the process is not making progress.`);

        // Signum rounds to 3 decimals so an update is skipped unless the fraction actually moved.
        const progress = count === 0 ? new Decimal(0) : new Decimal(position).div(count).toDecimalPlaces(3);
        await this.progressChangedDecimal(progress, status);
    }

    async progressChangedDecimal(progress: Decimal, status?: string): Promise<void> {
        const sameProgress = this.currentProcess.progress != null && this.currentProcess.progress.eq(progress);
        const sameStatus = (this.currentProcess.status ?? undefined) === status;
        if (sameProgress && sameStatus)
            return;

        this.currentProcess.progress = progress;
        this.currentProcess.status = status ?? null;

        // A set-based UPDATE, like Signum: it must not go through the save pipeline (no ticks conflict with
        // the operation that may be suspending this very row) and must be visible to the panel immediately.
        await ExecutionMode.global(() => Transaction.forceNew(async () => {
            await table(ProcessEntity).filter(p => p.id == this.currentProcess.id)
                .executeUpdate(() => ({ progress, status: status ?? null }));
        }));
    }

    /** Signum's `WriteMessage` — status only, no progress. */
    async writeMessage(status: string | null): Promise<void> {
        if ((this.currentProcess.status ?? null) === status)
            return;

        this.currentProcess.status = status;
        await ExecutionMode.global(() => Transaction.forceNew(async () => {
            await table(ProcessEntity).filter(p => p.id == this.currentProcess.id)
                .executeUpdate(() => ({ status }));
        }));
    }

    /** Signum's `TakeForThisMachine` — claim the row, refusing if another host already runs it. */
    async takeForThisMachine(): Promise<void> {
        await ExecutionMode.global(() => Transaction.forceNew(async () => {
            const alreadyExecuting = await table(ProcessEntity)
                .filter(p => p.id == this.currentProcess.id && p.state == ProcessStateEnum.Executing)
                .toArray();

            if (alreadyExecuting.length > 0)
                throw new Error(`The process ${this.currentProcess.id} is already Executing!`);

            this.currentProcess.state = ProcessStateEnum.Executing;
            this.currentProcess.executionStart = Clock.now;
            this.currentProcess.executionEnd = null;
            this.currentProcess.progress = new Decimal(0);
            this.currentProcess.machineName = ProcessRunner.machineName();
            this.currentProcess.applicationName = ProcessRunner.applicationName();

            await this.currentProcess.save();
        }));
    }

    /** Signum's `Execute` — run the algorithm as the process's user and record how it ended. */
    async execute(): Promise<void> {
        const user = await ExecutionMode.global(() =>
            retrieve(this.currentProcess.user.entityType as Type<Entity>, this.currentProcess.user.id!));

        // Signum's `using (ExecutionMode.SetIsolation(CurrentProcess) ?? (CurrentProcess.Data != null ?
        // ExecutionMode.SetIsolation(CurrentProcess.Data) : null))`: a background runner has no request to
        // inherit an ambient scope from, so it takes one from the process row — or, when the process itself
        // is not scoped, from the entity it was created for. No-op unless @altea/altea-isolation is
        // installed. The `data` lite is resolved to its row first: the scope is read off the entity.
        const scopeCandidates = await this.isolationCandidates(this.currentProcess);

        await UserHolder.withUser(new UserWithClaims(user as IUserEntity), () => ExecutionMode.withIsolationOf(scopeCandidates, async () => {
            try {
                await this.algorithm.execute(this);

                this.currentProcess.executionEnd = Clock.now;
                this.currentProcess.state = ProcessStateEnum.Finished;
                this.currentProcess.progress = null;
                await ExecutionMode.global(() => Transaction.forceNew(() => this.currentProcess.save()));
            } catch (error) {
                if (this.signal.aborted) {
                    // A cooperative stop, not a failure (Signum's OperationCanceledException branch).
                    this.currentProcess.suspendDate = Clock.now;
                    this.currentProcess.state = ProcessStateEnum.Suspended;
                    await ExecutionMode.global(() => Transaction.forceNew(() => this.currentProcess.save()));
                    return;
                }

                await ExecutionMode.global(async () => {
                    const exception = await ExceptionLogic.logException(error, e => {
                        e.controllerName = "ProcessRunner";
                        e.actionName = this.currentProcess.algorithm.key;
                    });

                    await Transaction.forceNew(async () => {
                        this.currentProcess.state = ProcessStateEnum.Error;
                        this.currentProcess.exceptionDate = Clock.now;
                        this.currentProcess.exception = exception.toLite();
                        this.currentProcess.executionEnd = Clock.now;
                        await this.currentProcess.save();
                    });
                });
            }
        }));
    }

    /**
     * The entities whose ambient scope this run may adopt, in Signum's order: the process row, then — when
     * the process itself carries none — the entity it was created for (`CurrentProcess.Data`, whose lite has
     * to be retrieved, since the scope is a field of the row).
     */
    private async isolationCandidates(process: ProcessEntity): Promise<Entity[]> {
        if (ExecutionMode.onSetIsolation.length === 0 || process.data == null)
            return [process];
        try {
            const data = await ExecutionMode.global(() =>
                retrieve(process.data!.entityType as Type<Entity>, process.data!.id!)) as Entity;
            return [process, data];
        } catch {
            return [process]; // the row is gone, or its type is not queryable — nothing to adopt
        }
    }

    /** Signum's `ForEach` — each element in its own transaction, reporting progress, and a failing element
     *  becomes a ProcessExceptionLine instead of losing the whole run. Cancellation still stops it. */
    async forEach<T>(
        collection: readonly T[],
        elementInfo: (item: T) => string,
        action: (item: T) => Promise<void>,
        lineOf?: (item: T) => Lite<Entity> | null,
    ): Promise<void> {
        await this.progressChanged(0, collection.length);

        for (let i = 0; i < collection.length; i++) {
            this.signal.throwIfAborted();

            const item = collection[i];
            using _prof = HeavyProfiler.log("ProcessLine", () => elementInfo(item));

            try {
                await Transaction.forceNew(() => action(item));
            } catch (error) {
                if (this.signal.aborted)
                    throw error;

                await ExecutionMode.global(async () => {
                    const exception = await ExceptionLogic.logException(error);
                    await Transaction.forceNew(async () => {
                        const line = ProcessExceptionLineEntity.create({
                            exception: exception.toLite(),
                            line: lineOf?.(item) ?? null,
                            process: this.currentProcess.toLite(),
                        });
                        line.elementInfo.text = elementInfo(item);
                        await line.save();
                    });
                });
            }

            await this.progressChanged(i + 1, collection.length);
        }
    }
}
