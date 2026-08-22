import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity, MixinEntity, ModelEntity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { cleanTypeName } from "@altea/altea/data/registration";
import { entity, implementedBy, unit, stringLengthValidator, quoted, index } from "@altea/altea/data/decorators";
import { Temporal, type int, type uuid } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import { registerEnum } from "@altea/altea/data/registration";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { SimpleTaskSymbol } from "@altea/altea-scheduler/data/Scheduler";
import { ProcessAlgorithmSymbol } from "@altea/altea-processes/data/Processes";
import { UserEntity } from "@altea/altea-auth/data/User";
import { WorkflowEntity, type IWorkflowNodeEntity } from "./Workflow";
import { WorkflowActivityEntity, WorkflowEventEntity } from "./WorkflowNodes";
import { CaseEntity, CaseTagTypeEntity, type ICaseMainEntity } from "./Case";
// A value import, and a real ESM cycle (CaseNotification.ts needs CaseActivityEntity back): the transformer
// needs the runtime binding to emit `() => CaseNotificationEntity` for the field type, so `import type` is
// not an option. Safe because nothing dereferences it at module-evaluation time.
import { CaseNotificationEntity, CaseNotificationState } from "./CaseNotification";
import type { WorkflowEventTaskEntity } from "./WorkflowEventTask";

// Port of Signum.Workflow's CaseActivity.cs + CaseActivityMixin.cs — a CASE ACTIVITY is one STEP of a case:
// which workflow node it is at, when it started, and (once done) who finished it, how and with what decision.
// The chain of `previous` links is the case's history and what the case-flow diagram draws.
//
// altea divergences:
//  - Signum's `State` is a C# PROPERTY with an `[ExpressionField]` twin so it can be both queried and read
//    in memory (and it answers `New` for an unsaved entity, which no SQL expression could). altea splits the
//    two explicitly: `state()` is the `@quoted` DB-translatable expression, and `getState()` adds the `New`
//    case for the operation state machine. See the members.
//  - `Duration` stays a `double?` of MINUTES, as in Signum (it is an average-able number, not a Duration).
//  - Signum computes it in the entity's `protected override void PreSaving(…)`. altea has no entity-level
//    PreSaving OVERRIDE — the hook is a schema event list (`entityEvents(T).preSaving`) — so the same body is
//    registered in CaseActivityLogic.start. An entity `preSaving()` method here would simply never run.

@reflect
export class ScriptExecutionEmbedded extends EmbeddedEntity {
    nextExecution: Temporal.PlainDateTime;
    retryCount: int;
    /** Which script-runner pass claimed this activity (Signum's Guid stamp, so two runners cannot both take
     *  the same row). */
    processIdentifier: uuid | null;
}

export enum DoneType {
    Next,
    Jump = 3,
    Timeout,
    ScriptSuccess,
    ScriptFailure,
    Recompose,
}
registerEnum(DoneType);

export enum CaseActivityState {
    /** Never stored — an unsaved activity. Signum marks it `[Ignore]`; altea excludes it from the enum table
     *  with `Enum.markAsNotMapped` in CaseActivityLogic. */
    New,
    Pending,
    Done,
}
registerEnum(CaseActivityState);

// Signum's two filtered indexes on the include (`.WithIndex(a => new { a.ScriptExecution!.ProcessIdentifier },
// a => a.DoneDate == null)` and the same for NextExecution) — the two lookups the script runner does on
// every pass, over the tiny slice of rows that are still pending.
@reflect
@index<CaseActivityEntity>(a => [a.scriptExecution!.processIdentifier], a => a.doneDate == null)
@index<CaseActivityEntity>(a => [a.scriptExecution!.nextExecution], a => a.doneDate == null)
@entity("System", "Transactional")
export class CaseActivityEntity extends Entity {

    case: CaseEntity;

    @implementedBy(() => [WorkflowActivityEntity, WorkflowEventEntity])
    workflowActivity: IWorkflowNodeEntity;

    /** The node's name AT THE TIME — kept so history survives a rename or a replacement. */
    @stringLengthValidator({ min: 3, max: 255 })
    originalWorkflowActivityName: string;

    startDate: Temporal.PlainDateTime = Clock.now;

    previous: Lite<CaseActivityEntity> | null;

    @stringLengthValidator({ multiLine: true })
    note: string | null;

    doneDate: Temporal.PlainDateTime | null;

    @unit("min")
    duration: number | null;

    doneBy: Lite<UserEntity> | null;

    doneType: DoneType | null;

    doneDecision: string | null;

    scriptExecution: ScriptExecutionEmbedded | null;

    /** Signum's `DurationRealTime` — the duration so far for an activity that is still pending. */
    @quoted
    durationRealTime(): number | null {
        return this.duration ?? this.startDate.until(Clock.now, { largestUnit: "minute" }).total({ unit: "minute" });
    }

    @quoted
    durationRatio(): number | null {
        return this.duration == null ? null
            : this.duration / (this.workflowActivity as WorkflowActivityEntity).estimatedDuration!;
    }

    @quoted
    durationRealTimeRatio(): number | null {
        return this.durationRealTime() == null ? null
            : this.durationRealTime()! / (this.workflowActivity as WorkflowActivityEntity).estimatedDuration!;
    }

    /**
     * Signum's `StateExpression` — the state as the DATABASE sees it. `@quoted`, so it is both a query token
     * (registered in CaseActivityLogic) and the in-memory answer for a saved activity.
     */
    @quoted
    state(): CaseActivityState {
        return this.doneDate != null ? CaseActivityState.Done : CaseActivityState.Pending;
    }

    /**
     * Signum's `State` PROPERTY: the same, plus `New` for an unsaved activity. Not `@quoted` — "is this row
     * saved" has no SQL translation. This is what the operation state machine reads (`g.GetState`).
     */
    getState(): CaseActivityState {
        return this.isNew ? CaseActivityState.New : this.state();
    }

    @quoted
    toString(): string {
        return (this.workflowActivity + " " + this.doneBy).trim();
    }
}

export namespace CaseActivityOperation {
    export const CreateCaseActivityFromWorkflow: ConstructSymbol<CaseActivityEntity, From<WorkflowEntity>> = init();
    export const CreateCaseFromWorkflowEventTask: ConstructSymbol<CaseEntity, From<WorkflowEventTaskEntity>> = init();
    export const Register: ExecuteSymbol<CaseActivityEntity> = init();
    export const Delete: DeleteSymbol<CaseActivityEntity> = init();
    export const Next: ExecuteSymbol<CaseActivityEntity> = init();
    export const Jump: ExecuteSymbol<CaseActivityEntity> = init();
    export const FreeJump: ExecuteSymbol<CaseActivityEntity> = init();
    export const Timer: ExecuteSymbol<CaseActivityEntity> = init();
    export const MarkAsUnread: ExecuteSymbol<CaseActivityEntity> = init();
    export const Undo: ExecuteSymbol<CaseActivityEntity> = init();
    export const ResetToCaseActivity: ExecuteSymbol<CaseActivityEntity> = init();
    export const ScriptExecute: ExecuteSymbol<CaseActivityEntity> = init();
    export const ScriptScheduleRetry: ExecuteSymbol<CaseActivityEntity> = init();
    export const ScriptFailureJump: ExecuteSymbol<CaseActivityEntity> = init();
}

export namespace CaseActivityTask {
    /** The scheduled sweep that fires whatever timer is due (Signum's SimpleTaskSymbol). */
    export const Timeout: SimpleTaskSymbol = init();
}

export namespace CaseActivityProcessAlgorithm {
    /** The process that actually executes the timers the sweep found, one activity per line. */
    export const Timeout: ProcessAlgorithmSymbol = init();
}

/** Signum's CaseActivityExecutedTimerEntity — one row per firing of a BoundaryForkTimer, which is how
 *  `runRepeatedly` knows when it last fired. */
@reflect
@entity("System", "Transactional")
export class CaseActivityExecutedTimerEntity extends Entity {

    creationDate: Temporal.PlainDateTime = Clock.now;

    caseActivity: Lite<CaseActivityEntity>;

    boundaryEvent: Lite<WorkflowEventEntity>;
}

/**
 * Signum's ActivityWithRemarks — the composite the Inbox's "Activity" column renders: the activity, its
 * notification's personal remarks and the case's tags, in one cell.
 *
 * altea divergence: Signum's `int Alerts` (the count of the current user's active alerts on the activity) is
 * dropped — there is no altea counterpart of Signum.Alerts.
 */
@reflect
export class ActivityWithRemarks extends ModelEntity {
    workflowActivity: Lite<WorkflowActivityEntity> | null;
    case: Lite<CaseEntity>;
    caseActivity: Lite<CaseActivityEntity> | null;
    notification: Lite<CaseNotificationEntity> | null;
    remarks: string | null;
    tags: CaseTagTypeEntity[];
}

// ---- The mixin ------------------------------------------------------------------------------------------

/**
 * Signum's CaseActivityMixin — stamps whatever an activity produces (an email, an SMS) with the activity it
 * was produced in, so a message can be traced back to its step.
 *
 * altea divergences:
 *  - a mixin's fields are INLINED onto the owner (see @altea/altea-diff-log's DiffLogMixin), so the column is
 *    the owner's own `case_activity_id`; reading it through `entity.mixin(CaseActivityMixin)` still works and
 *    is what the port does.
 *  - Signum sets the field in the mixin's CONSTRUCTOR from `WorkflowActivityInfo.Current`; altea's mixin
 *    field initializers only run in the `create()` FACTORY (a `new Owner()` leaves them undefined), and the
 *    ambient activity lives in the SERVER's WorkflowActivityInfo, which the data layer cannot see. So the
 *    stamping is done by CaseActivityLogic, which hooks the owner type's save.
 */
@reflect
export class CaseActivityMixin extends MixinEntity {
    caseActivity: Lite<CaseActivityEntity> | null = null;
}

export namespace CaseActivityMixin {
    const declaredOn = new Set<string>();

    /**
     * Declare the mixin on an owner type (Signum's `MixinDeclarations.Register<EmailMessageEntity,
     * CaseActivityMixin>()`, which Southwind calls in its Starter). Idempotent, and it must run on BOTH TIERS
     * before anything is (de)serialized or the schema is built — put the call in the module the client and
     * the server both load, next to the app's other entity overrides.
     */
    export function declareOn<T extends Entity>(type: Type<T>): void {
        if (declaredOn.has(cleanTypeName(type)))
            return;
        declaredOn.add(cleanTypeName(type));

        MixinDeclarations.register(type, CaseActivityMixin as unknown as Type<CaseActivityMixin>);
    }

    export function isDeclaredOn<T extends Entity>(type: Type<T>): boolean {
        return declaredOn.has(cleanTypeName(type));
    }

    export function declaredTypes(): string[] {
        return [...declaredOn];
    }
}

// ---- The Inbox row model ---------------------------------------------------------------------------------

/**
 * The Inbox's row shape. Signum projects an ANONYMOUS type (`DynamicQueryCore.Auto(from cn in … select new
 * { … })`); altea's projected queries need a declared ModelEntity, the shape the RemoteEmails port
 * established. Its `entity` member is the row identity — the CASE ACTIVITY, not the notification, so opening
 * a row opens the activity (as in Signum).
 *
 * It lives in data/ rather than beside the query registration (server/CaseActivityLogic), because the CLIENT
 * needs its property routes: the Inbox's Finder settings name columns by token, and a token is resolved from
 * the row model's own reflection metadata.
 *
 * It is ALSO the query's NAME. Signum names the Inbox with an enum member (`CaseActivityQuery.Inbox`) and
 * describes its columns through an anonymous `Select` + `ColumnDisplayName` calls; altea has no
 * QueryDescription, so a manual query's name IS its row type and each caption is the field's own
 * `@niceName` — the shape altea-auth-azuread's two directory searches established. The URL is therefore
 * `/find/InboxRowModel` rather than Signum's `/find/Inbox`.
 */
@reflect
export class InboxRowModel extends ModelEntity {
    entity: Lite<CaseActivityEntity>;
    startDate: Temporal.PlainDateTime;
    workflow: Lite<WorkflowEntity>;
    activity: ActivityWithRemarks;
    mainEntity: Lite<ICaseMainEntity>;
    sender: Lite<UserEntity> | null;
    senderNote: string | null;
    state: CaseNotificationState;
    actor: Lite<Entity>;
    user: Lite<UserEntity>;
}

// ---- Messages -------------------------------------------------------------------------------------------

export const CaseActivityMessage = {
    CaseContainsOtherActivities: msg(),
    NoNextConnectionThatSatisfiesTheConditionsFound: msg(),
    CaseIsADecompositionOf0: msg("Case is a decomposition of {0}"),
    From0On1: msg("From {0} on {1}"),
    DoneBy0On1: msg("Done by {0} on {1}"),
    PersonalRemarksForThisNotification: msg(),
    TheActivity0RequiresToBeOpened: msg("The activity '{0}' requires to be opened"),
    NoOpenedOrInProgressNotificationsFound: msg(),
    NextActivityAlreadyInProgress: msg(),
    NextActivityOfDecompositionSurrogateAlreadyInProgress: msg(),
    Only0CanUndoThisOperation: msg("Only '{0}' can undo this operation"),
    Activity0HasNoJumps: msg("Activity '{0}' has no jumps"),
    Activity0HasNoTimers: msg("Activity '{0}' has no timeout"),
    ThereIsNoPreviousActivity: msg(),
    OnlyForScriptWorkflowActivities: msg(),
    Pending: msg(),
    NoWorkflowActivity: msg(),
    ImpossibleToDeleteCaseActivity0OnWorkflowActivity1BecauseHasNoPreviousActivity:
        msg("Impossible to delete Case Activity {0} (on Workflow Activity '{1}') because has no previouos activity"),
    LastCaseActivity: msg(),
    CurrentUserHasNotification: msg(),
    NoNewOrOpenedOrInProgressNotificationsFound: msg(),
    NoActorsFoundToInsertCaseActivityNotifications: msg(),
    ThereAreInprogressActivities: msg(),
    ShowHelp: msg(),
    HideHelp: msg(),
    CanceledCase: msg(),
    AlreadyFinished: msg(),
    NotCanceled: msg(),
    ResetToCaseActivityIsNotSupportedForDecomposedCases:
        msg("Reset to this activity is not supported because a decomposition that already created subcases "
            + "comes after it. Reset to an activity at or after the decomposition instead."),
    ResetToCaseActivityRequiresAnOpenSubCase:
        msg("Reset to a decomposition is only possible while at least one of its subcases is not finished."),
    AreYouSureYouWantToResetTheCaseBackToTheSelectedActivity:
        msg("Are you sure you want to reset the case back to the selected activity? The case will be reopened "
            + "if closed, all later activities will be undone (kept as history) and a new pending activity "
            + "will be created."),
};
