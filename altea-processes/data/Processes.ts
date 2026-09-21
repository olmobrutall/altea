import { init, MAX_SIZE } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Symbol } from "@altea/altea/data/symbol";
import { column, entity, implementedBy, implementedByAll, format, legacyPropertyRoute, quoted, ticksColumn } from "@altea/altea/data/decorators";
import { stringLengthValidator, validate, dateTimePrecisionValidator, DateTimePrecision, numberBetweenValidator } from "@altea/altea/data/validators";
import { Temporal, Decimal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import type { IUserEntity } from "@altea/altea/data/security";
import { ExceptionEntity } from "@altea/altea/data/exception";
import { PermissionSymbol } from "@altea/altea/data/permissionSymbol";
import { UserEntity } from "@altea/altea-auth/data/User";

// A PROCESS is one run of a registered ALGORITHM over some DATA, tracked through a state machine
// (Created → Queued → Executing → Finished / Error / Suspended / Canceled) with a progress fraction and a
// status line, so a long job is observable and interruptible.
//
// **`status` is a sized COLUMN, not a BigString.** The runner rewrites it on every progress tick with a
// SET-BASED update — it must not go through the save pipeline (see `ExecutingProcess.progressChanged`) —
// and a set-based update of a field inside an embedded is not something altea expresses.
//
// Signum's `Duration` (double?, ms) IS ported, as the `@quoted durationMilliseconds()` below plus the
// `Duration` token ProcessLogic registers over it — a note here used to say a quoted duration was
// impossible, which it is not: `end.since(start).total({ unit })` lowers to DATEDIFF / EXTRACT(EPOCH …).
//
// Signum's second expression, `DurationSpan` (TimeSpan?), is NOT ported. altea's LINQ provider carries a
// `since()` difference as an internal marker that only `Duration.total(unit)` consumes; there is no
// lowering that leaves an INTERVAL standing as a column, so a member returning a raw `Temporal.Duration`
// would emit the marker into the SELECT and fail at query time. `Duration` in milliseconds is the same
// information, and it is what Signum's own default columns use.
//
// Port of Signum.Processes' Process.cs — see port/Processes.md.

/** Names a registered algorithm (ProcessLogic.register). */
@entity("SystemString", "Master")
export class ProcessAlgorithmSymbol extends Symbol {
}

/** The marker for "an entity a process can run over". */
export interface IProcessDataEntity extends Entity { }

export enum ProcessState {
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

@entity("Main", "Transactional")
// The engine writes these rows, never a person editing one, so there is
// nothing for a concurrency stamp to protect.
@ticksColumn(false)
export class ProcessEntity extends Entity {

    /** "not pinned to a machine", so any host may take it. */
    static readonly None = "none";

    algorithm: ProcessAlgorithmSymbol;

    /** What this run operates on. There is no runtime interface to reference, so this is an
     *  INTERFACE one column per implementor in the schema (`Data_ID_Package`, `Data_ID_EmailPackage`, …);
     *  altea has no runtime interface, so the field declares an empty @implementedBy the APPLICATION widens
     *  to the process-data types its modules install — the `ChangeLogViewLogEntity.user` accommodation.
     *  It used to be @implementedByAll, which costs FOUR columns (one per PK type plus the discriminator)
     *  widened by the app rather than a column per implementor. */
    @implementedBy(() => [])
    data: Lite<Entity> | null = null;

    @stringLengthValidator({ min: 3, max: 100 })
    machineName: string = ProcessEntity.None;

    @stringLengthValidator({ min: 3, max: 100 })
    applicationName: string = ProcessEntity.None;

    // Signum's `[ImplementedBy(typeof(UserEntity))] Lite<IUserEntity>`. No implementations are named
    // here, so this module needs no reference to altea-auth; the app widens it in its EntityOverrides
    // (the same accommodation ExceptionEntity.user and OperationLogEntity.user make).
    @implementedBy(() => [])
    user: Lite<IUserEntity>;

    state: ProcessState = ProcessState.Created;

    creationDate: Temporal.PlainDateTime = Clock.now;

    // Signum declares [DateTimePrecisionValidator(Milliseconds)] on these five and on no other date
    // here, which is a statement about the SCHEDULE rather than about storage: a process is planned,
    // queued and timed to the millisecond, so that is what the columns show and how far the date
    // sub-tokens go. `Clock.now` reads milliseconds exactly (Temporal.Now is millisecond-resolution),
    // so nothing has to be truncated to satisfy it.
    @dateTimePrecisionValidator(DateTimePrecision.Milliseconds)
    plannedDate: Temporal.PlainDateTime | null = null;
    @dateTimePrecisionValidator(DateTimePrecision.Milliseconds)
    cancelationDate: Temporal.PlainDateTime | null = null;
    @dateTimePrecisionValidator(DateTimePrecision.Milliseconds)
    queuedDate: Temporal.PlainDateTime | null = null;

    // The pair is validated on the FIRST of the two properties.
    @validate<ProcessEntity>(p => p.validateExecutionDates())
    @dateTimePrecisionValidator(DateTimePrecision.Milliseconds)
    executionStart: Temporal.PlainDateTime | null = null;
    @dateTimePrecisionValidator(DateTimePrecision.Milliseconds)
    executionEnd: Temporal.PlainDateTime | null = null;

    suspendDate: Temporal.PlainDateTime | null = null;
    exceptionDate: Temporal.PlainDateTime | null = null;
    exception: Lite<ExceptionEntity> | null = null;

    /** 0..1, formatted as a percentage. */
    @validate<ProcessEntity>(p => p.progress == null || (p.progress.gte(0) && p.progress.lte(1))
        ? null : ProcessMessage.ProgressMustBeBetween0And1.niceToString())
    @format("p")
    @numberBetweenValidator(0, 1)
    progress: Decimal | null = null;

    /** The line the algorithm is on, shown live on the panel (see the header note on why it is sized). */
    @stringLengthValidator({ max: 400, multiLine: true })
    status: string | null = null;

    /** Execution start and end must be set together. */
    validateExecutionDates(): string | null {
        if (this.executionStart != null && this.executionEnd != null
            && Temporal.PlainDateTime.compare(this.executionEnd, this.executionStart) < 0)
            return ProcessMessage.ProcessStartIsGreaterThanProcessEnd.niceToString();

        if (this.executionStart == null && this.executionEnd != null)
            return ProcessMessage.ProcessStartIsNullButProcessEndIsNot.niceToString();

        return null;
    }

    /**
     * Signum's `[ExpressionField("DurationExpression")] public double? Duration` — how long the run took,
     * in milliseconds. `@quoted`, so the process search page and the panel's grid can order by it.
     *
     * BOTH bounds are guarded, unlike Signum, which tests only `ExecutionEnd` and relies on C# lifted
     * `-` to null-propagate the other side. Here the guard is explicit, so a row that somehow carries an
     * end without a start reads as "unknown" instead of a difference against NULL. The ternary lowers to
     * a CASE WHEN; `since().total({ unit })` is the shape the nominator turns into a real DATEDIFF.
     *
     * It must be written VALUE-FIRST (`!= null ? … : null`, not `== null ? null : …`):
     * `ConditionalExpression.calculateType` is `whenTrue.type || whenFalse.type` and the `null` literal
     * HAS a type, so a null-first ternary types the whole expression as null and the registration then
     * rejects it as "neither @quoted nor @resultType".
     *
     * `@legacyPropertyRoute("Duration")`: Signum's member is a C# PROPERTY, so a Signum database holds a
     * `basics.property_route` row named `Duration` that a legacy sync must not drop.
     */
    @legacyPropertyRoute("Duration")
    @quoted durationMilliseconds(): number | null {
        return this.executionEnd != null && this.executionStart != null
            ? this.executionEnd.since(this.executionStart).total({ unit: "milliseconds" }) : null;
    }

    toString(): string {
        const algorithm = this.algorithm?.toString() ?? "";
        switch (this.state) {
            case ProcessState.Created: return `${algorithm} Created on ${this.creationDate}`;
            case ProcessState.Planned: return `${algorithm} Planned for ${this.plannedDate}`;
            case ProcessState.Canceled: return `${algorithm} Canceled on ${this.cancelationDate}`;
            case ProcessState.Queued: return `${algorithm} Queued on ${this.queuedDate}`;
            case ProcessState.Executing: return `${algorithm} Executing since ${this.executionStart}`;
            case ProcessState.Suspending: return `${algorithm} Suspending since ${this.suspendDate}`;
            case ProcessState.Suspended: return `${algorithm} Suspended on ${this.suspendDate}`;
            case ProcessState.Finished: return `${algorithm} Finished on ${this.executionEnd}`;
            case ProcessState.Error: return `${algorithm} Error on ${this.executionEnd}`;
            default: return `${algorithm} ??`;
        }
    }
}

/** One element a process failed on, so the run continues past it and
 *  the failures stay individually inspectable. */
@entity("System", "Transactional")
export class ProcessExceptionLineEntity extends Entity {

    // Signum's [DbType(Size = int.MaxValue)] — whatever identifies the element that failed, and it is
    // written by an algorithm, not typed by anyone. Said outright: no size means the default of 200.
    @column({ size: MAX_SIZE })
    elementInfo: string | null;

    /** The line (usually a PackageLine) that failed. There is no runtime interface, so
     *  one column per implementor; the app widens it (see ProcessEntity.data). */
    @implementedBy(() => [])
    line: Lite<Entity> | null = null;

    process: Lite<ProcessEntity>;

    exception: Lite<ExceptionEntity>;

    // + ")"` — an EXPRESSION, so the display string is expanded inline in queries and its table has no
    // `@quoted`, so the string is expanded inline by the query provider and no `to_str` column is
    // materialised. (The `?? "New"` is the in-memory half.)
    @quoted
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
    // The caption of the `Duration` token over ProcessEntity.durationMilliseconds() (registered in
    // ProcessLogic). Signum translates it as that entity's `Duration` PROPERTY; a `@quoted` method is not
    // a PropertyRoute, so it has no <Member> entry to hold a translation and the caption has to be a
    // message — the same move OperationLogic makes for its system-time tokens.
    Duration: msg(),
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
