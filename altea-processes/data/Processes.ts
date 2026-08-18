import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Symbol } from "@altea/altea/data/symbol";
import {
    entity, implementedBy, implementedByAll, format, stringLengthValidator, fieldValidation,
} from "@altea/altea/data/decorators";
import { Temporal, Decimal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import type { IUserEntity } from "@altea/altea/data/security";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { ExceptionEntity } from "@altea/altea/data/exception";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { UserEntity } from "@altea/altea-auth/data/User";

// Port of Signum.Processes' Process.cs — a PROCESS is one run of a registered ALGORITHM over some DATA,
// tracked through a state machine (Created → Queued → Executing → Finished / Error / Suspended / Canceled)
// with a progress fraction and a status line, so a long job is observable and interruptible.
//
// altea divergences, documented inline:
//  - `DateTime` → `Temporal.PlainDateTime` (server-local wall clock, as in the scheduler port);
//    `decimal? Progress` → `Decimal | null` (altea's decimal.js class).
//  - `ElementInfo` (unbounded in Signum) → `BigStringEmbedded`, like ExceptionEntity's stackTrace. `Status`
//    does NOT: the runner rewrites it on every progress tick with a SET-BASED update (it must not go through
//    the save pipeline — see ExecutingProcess.progressChanged), and a set-based update of a field inside an
//    embedded is not something altea expresses. It is a sized column here, which is what a one-line progress
//    message needs.
//  - `IProcessDataEntity` is a TS marker interface over the `Entity` class (altea has no IEntity), and
//    `ProcessEntity.data` is `@implementedByAll`: what a process runs OVER is app-defined, and core cannot
//    enumerate it. (Signum pins it per app through schema settings.)
//  - Signum's table-driven `StateValidator` (which fields must be null in which state) is NOT ported — it
//    needs its own little framework. The two explicit PropertyValidations ARE ported, and the runner is the
//    only writer of these fields, so the states stay consistent in practice.
//  - `Duration` / `DurationSpan` are in-memory helpers, not queryable columns: the quote-transformer emits a
//    runtime type reference for a quoted member's return type, and there is no value to reference for a
//    number (the same reason ScheduledTaskLog.duration is a plain method).
//  - `TicksColumn(false)` has no altea counterpart yet, so ProcessEntity keeps its ticks column.

/** Signum's ProcessAlgorithmSymbol — names a registered algorithm (ProcessLogic.register). */
@reflect
@entity("SystemString", "Master")
export class ProcessAlgorithmSymbol extends Symbol {
}

/** Signum's IProcessDataEntity — the marker for "an entity a process can run over". */
export interface IProcessDataEntity extends Entity { }

/** Signum's ProcessState. */
export enum ProcessStateEnum {
    Created,
    Planned,
    Canceled,
    Queued,
    Executing,
    Suspending,
    Suspended,
    Finished,
    Error,
}

@reflect
@entity("Main", "Transactional")
export class ProcessEntity extends Entity {

    /** Signum's `public const string None` — "not pinned to a machine", so any host may take it. */
    static readonly None = "none";

    algorithm: ProcessAlgorithmSymbol;

    /** What this run operates on. @implementedByAll because the data types are the APP's (Signum pins them
     *  per application); a PackageEntity is the usual one. */
    @implementedByAll
    data: Lite<Entity> | null = null;

    @stringLengthValidator({ min: 3, max: 100 })
    machineName: string = ProcessEntity.None;

    @stringLengthValidator({ min: 3, max: 100 })
    applicationName: string = ProcessEntity.None;

    @implementedBy(() => [UserEntity])
    user: Lite<IUserEntity>;

    state: ProcessStateEnum = ProcessStateEnum.Created;

    creationDate: Temporal.PlainDateTime = Clock.now;

    plannedDate: Temporal.PlainDateTime | null = null;
    cancelationDate: Temporal.PlainDateTime | null = null;
    queuedDate: Temporal.PlainDateTime | null = null;

    // Signum validates the pair on either property; altea attaches it to the first of them.
    @fieldValidation<ProcessEntity>(p => p.validateExecutionDates())
    executionStart: Temporal.PlainDateTime | null = null;
    executionEnd: Temporal.PlainDateTime | null = null;

    suspendDate: Temporal.PlainDateTime | null = null;
    exceptionDate: Temporal.PlainDateTime | null = null;
    exception: Lite<ExceptionEntity> | null = null;

    /** 0..1 (Signum's [NumberBetweenValidator(0,1), Format("p")]). */
    @fieldValidation<ProcessEntity>(p => p.progress == null || (p.progress.gte(0) && p.progress.lte(1))
        ? null : ProcessMessage.ProgressMustBeBetween0And1.niceToString())
    @format("p")
    progress: Decimal | null = null;

    /** The line the algorithm is on, shown live on the panel (see the header note on why it is sized). */
    @stringLengthValidator({ max: 400, multiLine: true })
    status: string | null = null;

    /** Signum's PropertyValidation on ExecutionStart / ExecutionEnd. */
    validateExecutionDates(): string | null {
        if (this.executionStart != null && this.executionEnd != null
            && Temporal.PlainDateTime.compare(this.executionEnd, this.executionStart) < 0)
            return ProcessMessage.ProcessStartIsGreaterThanProcessEnd.niceToString();

        if (this.executionStart == null && this.executionEnd != null)
            return ProcessMessage.ProcessStartIsNullButProcessEndIsNot.niceToString();

        return null;
    }

    /** Signum's `Duration` (an in-memory helper here — see the header note). */
    durationMilliseconds(): number | null {
        return this.executionEnd == null || this.executionStart == null ? null
            : this.executionEnd.since(this.executionStart).total({ unit: "milliseconds" });
    }

    toString(): string {
        const algorithm = this.algorithm?.toString() ?? "";
        switch (this.state) {
            case ProcessStateEnum.Created: return `${algorithm} Created on ${this.creationDate}`;
            case ProcessStateEnum.Planned: return `${algorithm} Planned for ${this.plannedDate}`;
            case ProcessStateEnum.Canceled: return `${algorithm} Canceled on ${this.cancelationDate}`;
            case ProcessStateEnum.Queued: return `${algorithm} Queued on ${this.queuedDate}`;
            case ProcessStateEnum.Executing: return `${algorithm} Executing since ${this.executionStart}`;
            case ProcessStateEnum.Suspending: return `${algorithm} Suspending since ${this.suspendDate}`;
            case ProcessStateEnum.Suspended: return `${algorithm} Suspended on ${this.suspendDate}`;
            case ProcessStateEnum.Finished: return `${algorithm} Finished on ${this.executionEnd}`;
            case ProcessStateEnum.Error: return `${algorithm} Error on ${this.executionEnd}`;
            default: return `${algorithm} ??`;
        }
    }
}

/** Signum's ProcessExceptionLineEntity — one element a process failed on, so the run continues past it and
 *  the failures stay individually inspectable. */
@reflect
@entity("System", "Transactional")
export class ProcessExceptionLineEntity extends Entity {

    elementInfo: BigStringEmbedded = new BigStringEmbedded();

    /** The line (usually a PackageLine) that failed. */
    @implementedByAll
    line: Lite<Entity> | null = null;

    process: Lite<ProcessEntity>;

    exception: Lite<ExceptionEntity>;

    toString(): string {
        return `ProcessExceptionLine (${this.id ?? "New"})`;
    }
}

export namespace ProcessOperation {
    export const Save: ExecuteSymbol<ProcessEntity> = init();
    export const Execute: ExecuteSymbol<ProcessEntity> = init();
    export const Suspend: ExecuteSymbol<ProcessEntity> = init();
    export const Cancel: ExecuteSymbol<ProcessEntity> = init();
    export const Plan: ExecuteSymbol<ProcessEntity> = init();
    export const Retry: ConstructSymbol<ProcessEntity, From<ProcessEntity>> = init();
}

export namespace ProcessPermission {
    export const ViewProcessPanel: PermissionSymbol = init();
}

export const ProcessMessage = {
    Process0IsNotRunningAnymore: msg("Process {0} is not running anymore"),
    ProcessStartIsGreaterThanProcessEnd: msg("Process Start is greater than Process End"),
    ProcessStartIsNullButProcessEndIsNot: msg("Process Start is null but Process End is not"),
    ProgressMustBeBetween0And1: msg("Progress must be between 0 and 1"),
    Lines: msg(),
    LastProcess: msg("Last process"),
    ExceptionLines: msg("Exception lines"),
    SuspendIsTheSaferWayOfStoppingARunningProcessCancelAnyway:
        msg("Suspend is the safer way of stopping a running process. Cancel anyway?"),
    ProcessSettings: msg("Process settings"),
    OnlyActive: msg("Only active"),
    ProcessLogicStateLoading: msg("ProcessLogic state (loading...)"),
    ProcessPanel: msg("Process panel"),
    Start: msg(),
    Stop: msg(),
    Running: msg("RUNNING"),
    Stopped: msg("STOPPED"),
    SimpleStatus: msg("Simple status"),
    JustMyProcesses: msg("Just my processes"),
    MachineName: msg("Machine name"),
    ApplicationName: msg("Application name"),
    MaxDegreeOfParallelism: msg("Max degree of parallelism"),
    InitialDelayMilliseconds: msg("Initial delay milliseconds"),
    NextPlannedExecution: msg("Next planned execution"),
    None: msg(),
    ExecutingProcesses: msg("Executing processes"),
    Process: msg(),
    State: msg(),
    Progress: msg(),
    IsCancellationRequest: msg("Is cancellation requested"),
    _0ProcessesExcecutingIn1_2: msg("{0} processes executing in {1} / {2}"),
    LatestProcesses: msg("Latest processes"),
    Dates: msg(),
    ProcessExecutingSuspendFirst: msg("Process executing, suspend first"),
};
