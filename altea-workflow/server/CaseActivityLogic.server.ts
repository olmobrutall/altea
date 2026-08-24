import "@altea/altea/server"; // installs Entity.save()/delete()
import { type FluentOperations, type FluentStateMachine } from "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/data/globals/arrayExtensions";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { FluentInclude } from "@altea/altea/server/schema/fluentInclude";
import { table } from "@altea/altea/server/table";
import type { IQuery } from "@altea/altea/data/iquery";
import { Operations } from "@altea/altea/server/operationLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { AutoDynamicQueryCore } from "@altea/altea/server/dynamicQuery/dynamicQueryCore";
import { UserHolder } from "@altea/altea/server/userHolder";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { retrieve } from "@altea/altea/server/Database";
import { reflect, init } from "@altea/altea/data/reflection";
import { withQuoted } from "@altea/altea/data/decorators";
import { Enum } from "@altea/altea/data/enum";
import { Lite } from "@altea/altea/data/lite";
import { Entity, ModelEntity, type Type } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { SimpleTaskLogic } from "@altea/altea-scheduler/server/SimpleTaskLogic.server";
import { PackageEntity, PackageLineEntity } from "@altea/altea-processes/data/Package";
import { ProcessLogic } from "@altea/altea-processes/server/ProcessLogic.server";
import { ProcessOperation } from "@altea/altea-processes/data/Processes";
import type { ExecutingProcess } from "@altea/altea-processes/server/ProcessRunner.server";
import {
    WorkflowEntity, WorkflowMainEntityStrategy, WorkflowMessage, type IWorkflowNodeEntity,
} from "../data/Workflow";
import {
    ConnectionType, WorkflowActivityEntity, WorkflowActivityMessage, WorkflowActivityType,
    WorkflowConnectionEntity, WorkflowEventEntity, WorkflowEventType, WorkflowGatewayDirection,
    WorkflowGatewayEntity, WorkflowGatewayType, WorkflowLaneEntity, isTimer,
} from "../data/WorkflowNodes";
import { WorkflowValidationMessage } from "../data/Workflow";
import {
    ActivityWithRemarks, CaseActivityEntity, CaseActivityExecutedTimerEntity, CaseActivityMessage,
    CaseActivityMixin, CaseActivityOperation, CaseActivityProcessAlgorithm,
    CaseActivityState, CaseActivityTask, DoneType, InboxRowModel, ScriptExecutionEmbedded,
} from "../data/CaseActivity";
import {
    CaseEntity, CaseOperation, CaseTagEntity, CaseTagTypeEntity, CaseTagTypeOperation, CaseTagsModel,
    type ICaseMainEntity,
} from "../data/Case";
import {
    CaseNotificationEntity, CaseNotificationOperation, CaseNotificationState, InboxMessage,
} from "../data/CaseNotification";
import { WorkflowTransitionContext, WorkflowScriptContext } from "../data/WorkflowEval";
import { CaseQueries } from "./CaseQueries.server";
import { WorkflowLogic } from "./WorkflowLogic.server";
import { hasExpired, WorkflowNodeGraph } from "./WorkflowNodeGraph.server";
import { WorkflowActivityInfo } from "./WorkflowActivityInfo.server";
import { setCaseActivityMover } from "./WorkflowBuilder.server";
import { WorkflowScriptRunner } from "./WorkflowScriptRunner.server";

// Port of Signum.Workflow's CaseActivityLogic.cs — the ENGINE. A case walks its workflow one CASE ACTIVITY at
// a time; this file owns the state machine that decides what comes next (conditions, decisions, gateways,
// parallel joins, timers, decompositions and recompositions) and the notifications that tell people about it.
//
// altea divergences:
//  - EVERYTHING here is async (altea's engine is), so Signum's `using (WorkflowActivityInfo.Scope(...))`
//    becomes `WorkflowActivityInfo.withScope(info, async () => …)` and every evaluator call is awaited.
//  - `Alerts` (the Inbox's per-notification alert count) is dropped: no altea counterpart of Signum.Alerts.
//  - `OverrideCaseActivityMixin` — Signum re-registers the SMS / EmailMessage queries to add the mixin's
//    column — is not done here. altea has no SMS module, and re-registering altea-email's query from this
//    module would invert the dependency; the APP declares the mixin and re-registers the query (eastwind
//    does). The mixin's STAMPING does live here: `withCaseActivityMixin` hooks the owner's save.
//  - `ActivityWithRemarks.Tags` IS projected, as in Signum, through a nested collection subquery that
//    altea's provider fills as a lazy child. (The client's InlineCaseTags keeps its fetch-on-mount path,
//    `/api/workflow/tags/{id}`, for the case VIEW, where there is no row to carry them.)
//  - Signum's `PackageExecuteAlgorithm<CaseActivityEntity>(CaseActivityOperation.Timer)` has no altea
//    counterpart (altea-processes ports the Package TABLES but not the generic package-execute algorithm), so
//    the timeout algorithm walks the package's lines itself — see `registerTimeoutProcess`.
//  - Signum's `[Ignore] CaseActivityState.New` is excluded from the enum table with `Enum.markAsNotMapped`.

// ---- Extension expressions ------------------------------------------------------------------------------

declare module "../data/CaseNotification" {
    interface CaseNotificationEntity {
        /** Signum's `IsForMe` expression — is this notification the CURRENT user's? A `@quoted` member, not
         *  a local predicate: the binder expands a quoted method inside a query lambda but cannot translate a
         *  call to an ordinary local function (the gotcha the processes port documented). */
        isForMe(): boolean;
    }
}

declare module "../data/CaseActivity" {
    interface CaseActivityEntity {
        notifications(): IQuery<CaseNotificationEntity>;
        executedTimers(): IQuery<CaseActivityExecutedTimerEntity>;
        lastExecutedTimer(we: Lite<WorkflowEventEntity>): Promise<CaseActivityExecutedTimerEntity | null>;
        nextActivities(): IQuery<CaseActivityEntity>;
        /** Signum's `ca.Workflow()`. */
        workflow(): WorkflowEntity;
    }
}

declare module "../data/Case" {
    interface CaseEntity {
        caseActivities(): IQuery<CaseActivityEntity>;
        tags(): IQuery<CaseTagEntity>;
        subCases(): IQuery<CaseEntity>;
        /** The activity of the PARENT case that spawned this one (Signum's DecompositionSurrogateActivity). */
        decompositionSurrogateActivity(): Promise<CaseActivityEntity>;
    }
}

declare module "../data/Workflow" {
    interface WorkflowEntity {
        cases(): IQuery<CaseEntity>;
    }
}

declare module "../data/WorkflowNodes" {
    interface WorkflowActivityEntity {
        caseActivities(): IQuery<CaseActivityEntity>;
        averageDuration(): Promise<number | null>;
    }
    interface WorkflowEventEntity {
        caseActivities(): IQuery<CaseActivityEntity>;
        averageDuration(): Promise<number | null>;
    }
}

CaseNotificationEntity.prototype.isForMe = withQuoted(function (this: CaseNotificationEntity): boolean {
    return this.user.is(UserHolder.currentUserLite() as Lite<UserEntity>);
});

CaseActivityEntity.prototype.notifications = withQuoted(function (this: CaseActivityEntity): IQuery<CaseNotificationEntity> {
    return table(CaseNotificationEntity).filter(a => a.caseActivity.is(this));
});

CaseActivityEntity.prototype.executedTimers = withQuoted(function (this: CaseActivityEntity): IQuery<CaseActivityExecutedTimerEntity> {
    return table(CaseActivityExecutedTimerEntity).filter(a => a.caseActivity.is(this));
});

CaseActivityEntity.prototype.lastExecutedTimer = withQuoted(function (this: CaseActivityEntity, we: Lite<WorkflowEventEntity>): Promise<CaseActivityExecutedTimerEntity | null> {
    return this.executedTimers().filter(a => a.boundaryEvent.is(we)).orderByDescending(a => a.creationDate).firstOrNull();
});

CaseActivityEntity.prototype.nextActivities = withQuoted(function (this: CaseActivityEntity): IQuery<CaseActivityEntity> {
    return table(CaseActivityEntity).filter(a => a.previous!.is(this));
});

CaseActivityEntity.prototype.workflow = withQuoted(function (this: CaseActivityEntity): WorkflowEntity {
    return this.case.workflow;
});

CaseEntity.prototype.caseActivities = withQuoted(function (this: CaseEntity): IQuery<CaseActivityEntity> {
    return table(CaseActivityEntity).filter(a => a.case.is(this));
});

CaseEntity.prototype.tags = withQuoted(function (this: CaseEntity): IQuery<CaseTagEntity> {
    return table(CaseTagEntity).filter(a => a.case.is(this));
});

CaseEntity.prototype.subCases = withQuoted(function (this: CaseEntity): IQuery<CaseEntity> {
    return table(CaseEntity).filter(c => c.parentCase!.is(this));
});

CaseEntity.prototype.decompositionSurrogateActivity = withQuoted(function (this: CaseEntity): Promise<CaseActivityEntity> {
    return this.caseActivities().orderBy(ca => ca.startDate).map(a => a.previous!.entity).first();
});

WorkflowEntity.prototype.cases = withQuoted(function (this: WorkflowEntity): IQuery<CaseEntity> {
    return table(CaseEntity).filter(a => a.workflow.is(this));
});

WorkflowActivityEntity.prototype.caseActivities = withQuoted(function (this: WorkflowActivityEntity): IQuery<CaseActivityEntity> {
    return table(CaseActivityEntity).filter(a => a.workflowActivity.is(this));
});

WorkflowActivityEntity.prototype.averageDuration = withQuoted(function (this: WorkflowActivityEntity): Promise<number | null> {
    return this.caseActivities().avg(a => a.duration);
});

WorkflowEventEntity.prototype.caseActivities = withQuoted(function (this: WorkflowEventEntity): IQuery<CaseActivityEntity> {
    return table(CaseActivityEntity).filter(a => a.workflowActivity.is(this));
});

WorkflowEventEntity.prototype.averageDuration = withQuoted(function (this: WorkflowEventEntity): Promise<number | null> {
    return this.caseActivities().avg(a => a.duration);
});

// ---- Options per main-entity type -----------------------------------------------------------------------

/** Signum's CaseActivityLogic.WorkflowOptions — what the engine needs to know about ONE main-entity type. */
export interface WorkflowOptions<T extends Entity = Entity> {
    /** Signum's Constructor — required by the `CreateNew` main-entity strategy. */
    constructor?: () => T | Promise<T>;
    /** How to save the main entity at each step (usually its own Save operation). */
    saveEntity: (entity: T) => Promise<void>;
    cancel?: (entity: T, caseEntity: CaseEntity) => Promise<void>;
    reactivate?: (entity: T, caseEntity: CaseEntity) => Promise<void>;
}

declare module "@altea/altea/server/schema/fluentInclude" {
    interface FluentInclude<T extends Entity> {
        /** Signum's `WithWorkflow(constructor, save, cancel, reactivate)` — make T a case main entity. */
        withWorkflow(options: WorkflowOptions<T>): this;
        /** altea-only: declare the CaseActivityMixin on T and stamp it from the ambient activity (Signum does
         *  the stamping in the mixin's constructor, which altea's mixin defaults cannot do — see
         *  data/CaseActivity.ts). */
        withCaseActivityMixin(): this;
    }
}

export namespace CaseActivityLogic {

    /** Signum's `static Dictionary<Type, WorkflowOptions> Options`, keyed by the clean type name. */
    export const options = new Map<string, WorkflowOptions>();

    // ---- start -------------------------------------------------------------------------------------

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum marks `CaseActivityState.New` `[Ignore]` — it is a client-only state (an unsaved activity),
        // so it must not become a row of the enum table.
        Enum.markAsNotMapped(CaseActivityState, CaseActivityState.New);

        sb.include(CaseEntity)
            .withOperations(registerCaseOperations)
            .withExpressionFrom(WorkflowEntity, w => w.cases())
            .withQuery();

        sb.include(CaseTagTypeEntity)
            .withSave(CaseTagTypeOperation.Save)
            .withQuery();

        sb.include(CaseTagEntity)
            .withExpressionFrom(CaseEntity, ce => ce.tags())
            .withQuery();

        sb.include(CaseActivityEntity)
            .withStateMachine(ca => ca.getState(), registerCaseActivityOperations)
            .withExpressionFrom(WorkflowActivityEntity, c => c.caseActivities())
            .withExpressionFrom(WorkflowEventEntity, c => c.caseActivities())
            .withExpressionFrom(CaseEntity, c => c.caseActivities())
            .withExpressionFrom(CaseActivityEntity, c => c.nextActivities())
            .withQuery();

        sb.include(CaseActivityExecutedTimerEntity)
            .withExpressionFrom(CaseActivityEntity, ca => ca.executedTimers())
            .withQuery();

        sb.include(CaseNotificationEntity)
            .withOperations(registerCaseNotificationOperations)
            .withExpressionFrom(CaseActivityEntity, c => c.notifications())
            .withQuery();

        QueryLogic.expressions.register(WorkflowActivityEntity, (a: WorkflowActivityEntity) => a.averageDuration(),
            { niceName: () => WorkflowActivityMessage.AverageDuration.niceToString() });
        QueryLogic.expressions.register(CaseEntity, (c: CaseEntity) => c.decompositionSurrogateActivity());

        // A script activity's row is what the runner picks up, so a fresh one must wake it (Signum hooks the
        // same `Saved` event).
        sb.schema.entityEvents(CaseActivityEntity).saved.push((e, args) => {
            if (args.wasNew && e.workflowActivity instanceof WorkflowActivityEntity
                && e.workflowActivity.type === WorkflowActivityType.Script)
                WorkflowScriptRunner.wakeUpOnCommit();
        });

        // Signum's `CaseActivityEntity.PreSaving` override — altea's hook is a schema event, not an entity
        // method (see data/CaseActivity.ts). Keeps `duration` (minutes) in step with startDate/doneDate.
        sb.schema.entityEvents(CaseActivityEntity).preSaving.push(ca => {
            ca.duration = ca.doneDate == null ? null
                : ca.startDate.until(ca.doneDate, { largestUnit: "minute" }).total({ unit: "minute" });
        });

        registerInboxQuery();
        registerTimeoutTask();

        // The builder needs to know how to move / drop the case activities of a node the designer deleted.
        setCaseActivityMover({
            hasCaseActivities: node => caseActivitiesOf(node).some(),
            deleteCaseActivities: node => deleteCaseActivities(node),
            moveCaseActivities: (node, replacement) => moveCaseActivities(node, replacement),
            deleteCasesOfWorkflow: workflow => deleteCasesOfWorkflow(workflow),
        });

        WorkflowLogic.hasConstructor = typeName => options.get(typeName)?.constructor != null;

        WorkflowLogic.workflowHasPendingActivities = async w =>
            await table(CaseActivityEntity).some(ca => ca.case.workflow.is(w) && ca.doneDate == null);

        WorkflowLogic.workflowUsedAsSubWorkflow = async w => {
            const parents = await table(CaseEntity)
                .filter(c => c.workflow.is(w) && c.parentCase != null)
                .map(c => c.parentCase!.entity.workflow.toLite())
                .distinct()
                .toArray();
            return parents;
        };
    }

    // ---- withWorkflow / withCaseActivityMixin -------------------------------------------------------

    /** Signum's `WithWorkflow<T>` — plus the per-type expressions Signum registers on ICaseMainEntity (altea
     *  cannot key an extension token on an interface, so they are registered per concrete type here). */
    export function registerMainEntity<T extends Entity & ICaseMainEntity>(fi: FluentInclude<T>, opts: WorkflowOptions<T>): void {
        const type = fi.type as unknown as Type<T>;
        const cleanName = (type as unknown as { cleanName: string }).cleanName ?? type.name.replace(/Entity$/, "");

        // Signum notifies "in progress" from the entity's `Saved` event; same hook here.
        fi.schemaBuilder.schema.entityEvents(type).saved.push(entity => {
            if (avoidNotifyInProgress)
                return;
            void notifyInProgress(entity as unknown as ICaseMainEntity);
        });

        options.set(cleanName, opts as unknown as WorkflowOptions);

        // The four expressions Signum registers ONCE on ICaseMainEntity. altea cannot key an extension token
        // on an interface (the token walk follows the concrete prototype chain), so both the implementation
        // and the registration are per main-entity type — the accommodation MusicLogic makes for
        // IAuthorEntity.Albums.
        const proto = (type as unknown as { prototype: Record<string, unknown> }).prototype;

        proto.caseActivities = withQuoted(function (this: Entity): IQuery<CaseActivityEntity> {
            return table(CaseActivityEntity).filter(a => a.case.mainEntity.is(this));
        });
        proto.cases = withQuoted(function (this: Entity): IQuery<CaseEntity> {
            return table(CaseEntity).filter(a => a.mainEntity.is(this));
        });
        proto.lastCaseActivity = withQuoted(function (this: Entity): Promise<CaseActivityEntity | null> {
            return table(CaseActivityEntity).filter(a => a.case.mainEntity.is(this))
                .orderByDescending(a => a.startDate).firstOrNull();
        });
        proto.currentUserHasNotification = withQuoted(function (this: Entity): Promise<boolean> {
            return table(CaseNotificationEntity)
                .some(cn => cn.caseActivity.entity.case.mainEntity.is(this) && cn.isForMe());
        });

        QueryLogic.expressions.register(type, (e: T) => e.caseActivities!(),
            { niceName: () => CaseActivityEntity.nicePluralName() });
        QueryLogic.expressions.register(type, (e: T) => e.cases!(),
            { niceName: () => CaseEntity.nicePluralName() });
        QueryLogic.expressions.register(type, (e: T) => e.lastCaseActivity!(),
            { niceName: () => CaseActivityMessage.LastCaseActivity.niceToString() });
        QueryLogic.expressions.register(type, (e: T) => e.currentUserHasNotification!(),
            { niceName: () => CaseActivityMessage.CurrentUserHasNotification.niceToString() });
    }

    let avoidNotifyInProgress = false;

    /** Signum's `AvoidNotifyInProgress()` scope — the engine's own saves must not mark a notification read. */
    async function withoutNotifyInProgress<R>(fn: () => Promise<R>): Promise<R> {
        const old = avoidNotifyInProgress;
        avoidNotifyInProgress = true;
        try {
            return await fn();
        } finally {
            avoidNotifyInProgress = old;
        }
    }

    /** Signum's NotifyInProgress — opening / saving the main entity marks the current user's notification as
     *  InProgress, so colleagues see that somebody is on it. */
    export async function notifyInProgress(mainEntity: ICaseMainEntity): Promise<number> {
        return await ExecutionMode.global(() => table(CaseNotificationEntity)
            .filter(n => n.caseActivity.entity.case.mainEntity.is(mainEntity) && n.caseActivity.entity.doneDate == null)
            .filter(n => n.isForMe() && (n.state === CaseNotificationState.New || n.state === CaseNotificationState.Opened))
            .executeUpdate(() => ({ state: CaseNotificationState.InProgress })));
    }

    // ---- Retrieval for viewing ---------------------------------------------------------------------

    /** Signum's RetrieveForViewing — reading an activity marks its New notification as Opened. */
    export async function retrieveForViewing(lite: Lite<CaseActivityEntity>): Promise<CaseActivityEntity> {
        const ca = await retrieve(CaseActivityEntity, lite.id!);

        if (ca.doneBy == null)
            await table(CaseNotificationEntity)
                .filter(n => n.caseActivity.is(ca) && n.isForMe() && n.state === CaseNotificationState.New)
                .executeUpdate(() => ({ state: CaseNotificationState.Opened }));

        return ca;
    }

    // ---- Actors ------------------------------------------------------------------------------------

    /** Signum's `lane.GetActors(caseActivity)`. */
    export async function getActors(lane: WorkflowLaneEntity, caseActivity: CaseActivityEntity | null): Promise<Lite<Entity>[]> {
        if (caseActivity != null) {
            if (lane.actorsEval == null)
                return lane.actors.map(a => a.actor);

            const ctx = new WorkflowTransitionContext(caseActivity.case, caseActivity, null);
            const newActors = await WorkflowLogic.evaluateLaneActors(lane.actorsEval, caseActivity.case.mainEntity, ctx);

            const all = lane.combineActorAndActorEvalWhenContinuing
                ? [...newActors, ...lane.actors.map(a => a.actor)]
                : [...newActors];

            return distinctLites(all);
        }

        if (lane.useActorEvalForStart) {
            const ctx = new WorkflowTransitionContext(null, null, null);
            return distinctLites(await WorkflowLogic.evaluateLaneActors(lane.actorsEval!, null, ctx));
        }

        return lane.actors.map(a => a.actor);
    }

    /** Signum's `lane.GetActorUsers(caseActivity)` — the actors expanded to real users. */
    export async function getActorUsers(lane: WorkflowLaneEntity, caseActivity: CaseActivityEntity | null): Promise<Lite<UserEntity>[]> {
        const actors = await getActors(lane, caseActivity);
        const result: Lite<UserEntity>[] = [];

        for (const a of actors)
            result.push(...await usersOfActor(a));

        return distinctLites(result) as Lite<UserEntity>[];
    }

    /** Signum's `IsUserActorForNotifications` — the users an actor stands for. */
    async function usersOfActor(actor: Lite<Entity>): Promise<Lite<UserEntity>[]> {
        if (actor.entityType === UserEntity)
            return [actor as Lite<UserEntity>];

        if (actor.entityType === RoleEntity) {
            // Signum's `AuthLogic.InverseIndirectlyRelated(role).Contains(user.Role)` — every role that
            // (transitively) INHERITS the actor role, then every user in one of them.
            const roles = await AuthLogic.rolesInheritingFrom(actor as Lite<RoleEntity>);
            const keys = roles.map(r => r.id!);
            return await table(UserEntity).filter(u => keys.includes(u.role.id!)).map(u => u.toLite()).toArray();
        }

        return [];
    }

    /** Signum's InsertCaseActivityNotifications. */
    export async function insertCaseActivityNotifications(caseActivity: CaseActivityEntity): Promise<void> {
        const wa = caseActivity.workflowActivity;
        if (!(wa instanceof WorkflowActivityEntity))
            return;
        if (wa.type !== WorkflowActivityType.Task && wa.type !== WorkflowActivityType.Decision)
            return;

        await ExecutionMode.global(async () => {
            const lane = wa.lane;
            const actors = await getActors(lane, caseActivity);

            const pairs: { actor: Lite<Entity>; user: Lite<UserEntity> }[] = [];
            for (const a of actors)
                for (const u of await usersOfActor(a))
                    pairs.push({ actor: a, user: u });

            const notifications = pairs
                .distinctBy(p => p.user.key())
                .map(p => CaseNotificationEntity.create({
                    caseActivity: caseActivity.toLite(),
                    actor: p.actor,
                    state: CaseNotificationState.New,
                    user: p.user,
                }));

            if (notifications.length === 0)
                throw new Error(CaseActivityMessage.NoActorsFoundToInsertCaseActivityNotifications.niceToString());

            for (const n of notifications)
                await n.save();
        });
    }

    // ---- The step context --------------------------------------------------------------------------

    /** Signum's WorkflowExecuteStepContext — what one step accumulates before it commits. */
    export class WorkflowExecuteStepContext {
        toActivities: WorkflowActivityEntity[] = [];
        toIntermediateEvents: WorkflowEventEntity[] = [];
        isFinished = false;
        connections: WorkflowConnectionEntity[] = [];
        transitionContextToNotify: WorkflowTransitionContext[] = [];

        constructor(public case_: CaseEntity, public previousCaseActivity: CaseActivityEntity | null) { }

        async executeConnection(connection: WorkflowConnectionEntity): Promise<void> {
            const wctx = this.newTransitionContext(connection);

            for (const hook of WorkflowLogic.onTransition)
                await hook(this.case_.mainEntity, wctx);

            if (connection.action != null)
                await WorkflowLogic.executeAction(connection.action, this.case_.mainEntity, wctx);

            this.connections.push(connection);
        }

        newTransitionContext(connection: WorkflowConnectionEntity): WorkflowTransitionContext {
            const wtc = new WorkflowTransitionContext(this.case_, this.previousCaseActivity, connection);
            this.transitionContextToNotify.push(wtc);
            return wtc;
        }

        /** Signum's NotifyTransitionContext — tell the actions that installed a hook which activity their
         *  transition produced. */
        async notifyTransitionContext(newCaseActivity: CaseActivityEntity): Promise<void> {
            const g = await WorkflowLogic.getWorkflowNodeGraph(this.case_.workflow.toLite());

            for (const tctx of this.transitionContextToNotify) {
                if (tctx.onNextCaseActivityCreated == null || tctx.previousCaseActivity == null || tctx.connection == null)
                    continue;

                let from: IWorkflowNodeEntity = tctx.previousCaseActivity.workflowActivity;
                const to = newCaseActivity.workflowActivity;

                if (!from.lane.pool.workflow.is(this.case_.workflow)) // the previous activity is in a SUB-workflow
                    from = [...g.events.values()].single(a => a.type === WorkflowEventType.Start);

                const direct = g.getAllConnections(from, to, () => true).has(tctx.connection);
                const viaBoundary = !direct && from instanceof WorkflowActivityEntity
                    && from.boundaryTimers.some(e => g.getAllConnections(e, to, () => true).has(tctx.connection!));

                if (direct || viaBoundary)
                    await tctx.onNextCaseActivityCreated(newCaseActivity);
            }
        }
    }

    /** Signum's `wc.Applicable(ctx)` — does this connection's guard let the case through? */
    async function applicable(wc: WorkflowConnectionEntity, ctx: WorkflowExecuteStepContext): Promise<boolean> {
        const doneDecision = wc.doneDecision();

        if (doneDecision != null && doneDecision !== ctx.previousCaseActivity?.doneDecision)
            return false;

        if (wc.condition != null)
            return await WorkflowLogic.evaluateCondition(wc.condition, ctx.case_.mainEntity, ctx.newTransitionContext(wc));

        return true;
    }

    async function saveEntity(mainEntity: ICaseMainEntity): Promise<void> {
        const opts = optionsOf(mainEntity);
        await withoutNotifyInProgress(() => opts.saveEntity(mainEntity as Entity));
    }

    async function cancelEntity(mainEntity: ICaseMainEntity, caseEntity: CaseEntity): Promise<void> {
        const opts = optionsOf(mainEntity);
        if (opts.cancel != null)
            await withoutNotifyInProgress(() => opts.cancel!(mainEntity as Entity, caseEntity));
    }

    async function reactivateEntity(mainEntity: ICaseMainEntity, caseEntity: CaseEntity): Promise<void> {
        const opts = optionsOf(mainEntity);
        if (opts.reactivate != null)
            await withoutNotifyInProgress(() => opts.reactivate!(mainEntity as Entity, caseEntity));
    }

    function optionsOf(mainEntity: ICaseMainEntity): WorkflowOptions {
        const cleanName = cleanNameOf(mainEntity.constructor);
        const opts = options.get(cleanName);
        if (opts == null)
            throw new Error(`'${cleanName}' is not registered as a case main entity `
                + `(sb.include(${cleanName}Entity).withWorkflow({ … }))`);
        return opts;
    }

    async function createMainEntity(typeCleanName: string): Promise<ICaseMainEntity> {
        const opts = options.get(typeCleanName);
        if (opts == null)
            throw new Error(`'${typeCleanName}' is not registered as a case main entity`);
        if (opts.constructor == null)
            throw new Error(`The WorkflowOptions for ${typeCleanName} doesn't have a constructor. `
                + `Consider adding one in sb.include(${typeCleanName}).withWorkflow(…)`);
        return await opts.constructor() as unknown as ICaseMainEntity;
    }

    /** Signum's `workflow.CreateCaseActivity(mainEntity)` — the app-facing "start a case" helper. */
    export async function createCaseActivity(workflow: WorkflowEntity, mainEntity: ICaseMainEntity): Promise<CaseActivityEntity> {
        const ca = await Operations.constructFrom(workflow, CaseActivityOperation.CreateCaseActivityFromWorkflow, mainEntity);
        return await Operations.execute(ca, CaseActivityOperation.Register);
    }

    // ---- The Case graph ----------------------------------------------------------------------------

    /** Signum's `CanceledCase.ToString()` marker written into `doneDecision`. */
    function canceledCaseMarker(): string {
        return "CanceledCase";
    }

    /** Signum's CancelledCases(c). */
    function cancelledActivities(c: CaseEntity): IQuery<CaseActivityEntity> {
        const marker = canceledCaseMarker();
        const nice = CaseActivityMessage.CanceledCase.niceToString();
        return CaseQueries.caseActivities(c).filter(a => a.doneBy != null && a.doneType === DoneType.Jump
            && (a.doneDecision === marker || a.doneDecision === nice));
    }

    async function deleteCase(c: CaseEntity): Promise<void> {
        for (const sc of await CaseQueries.subCases(c).toArray())
            await deleteCase(sc);

        await table(CaseNotificationEntity).filter(n => n.caseActivity.entity.case.is(c)).executeDelete();
        await table(CaseActivityEntity).filter(a => a.case.is(c)).executeDelete();
        await c.delete();
    }

    async function deleteCasesOfWorkflow(workflow: WorkflowEntity): Promise<void> {
        for (const c of await table(CaseEntity).filter(a => a.workflow.is(workflow)).toArray())
            await deleteCase(c);
    }

    // ---- The CaseNotification graph -----------------------------------------------------------------

    // ---- The Inbox ---------------------------------------------------------------------------------

    function registerInboxQuery(): void {
        QueryLogic.queries.register(InboxRowModel, () => new AutoDynamicQueryCore(() => {
            return table(CaseNotificationEntity)
                .filter(cn => cn.isForMe())
                .map(cn => InboxRowModel.create({
                    entity: cn.caseActivity,
                    startDate: cn.caseActivity.entity.startDate,
                    workflow: cn.caseActivity.entity.case.workflow.toLite(),
                    activity: ActivityWithRemarks.create({
                        workflowActivity: (cn.caseActivity.entity.workflowActivity as WorkflowActivityEntity).toLite(),
                        case: cn.caseActivity.entity.case.toLite(),
                        caseActivity: cn.caseActivity,
                        notification: cn.toLite(),
                        remarks: cn.remarks,
                        // Signum's `Tags = ca.Case.Tags().Select(a => a.TagType).ToList()` — a collection
                        // subquery inside the projection, which altea's provider fills as a lazy child.
                        // `.$v` is altea's marker for a NESTED collection projection: it unwraps the eager
                        // method's Promise type, and the provider fills it as a lazy child query.
                        tags: table(CaseTagEntity)
                            .filter(t => t.case.is(cn.caseActivity.entity.case))
                            .map(t => t.tagType)
                            .toArray().$v,
                    }),
                    mainEntity: cn.caseActivity.entity.case.mainEntity.toLite(),
                    sender: cn.caseActivity.entity.previous!.entity.doneBy,
                    senderNote: cn.caseActivity.entity.previous!.entity.note,
                    state: cn.state,
                    actor: cn.actor,
                    user: cn.user,
                }));
        }));
    }

    // ---- The timeout sweep --------------------------------------------------------------------------

    function registerTimeoutTask(): void {
        SimpleTaskLogic.register(CaseActivityTask.Timeout, async () => {
            const now = Clock.now;

            // Signum builds the two candidate sets with one query each; the boundary one uses the virtual
            // MList (`from we in ((WorkflowActivityEntity)ca.WorkflowActivity).BoundaryTimers`), which altea
            // does not have — so it JOINS WorkflowEventEntity on `boundaryOf` instead (the same rows).
            const boundaryCandidates = await table(CaseActivityEntity)
                .filter(ca => !ca.workflow().hasExpired() && ca.doneDate == null)
                .flatMap(ca => table(WorkflowEventEntity)
                    .filter(we => we.boundaryOf!.is(ca.workflowActivity as WorkflowActivityEntity))
                    .map(we => ({ activity: ca, event: we })))
                .toArray();

            const intermediateCandidates = await table(CaseActivityEntity)
                .filter(ca => !ca.workflow().hasExpired() && ca.doneDate == null)
                .filter(ca => (ca.workflowActivity as WorkflowEventEntity).type === WorkflowEventType.IntermediateTimer)
                .map(ca => ({ activity: ca, event: ca.workflowActivity as WorkflowEventEntity }))
                .toArray();

            // The "has this fork timer already fired (and may it fire again)" filter Signum expresses inside
            // the query; done in memory here because it needs the timer's own type.
            const usable: { activity: CaseActivityEntity; event: WorkflowEventEntity }[] = [];
            for (const c of boundaryCandidates) {
                if (c.event.type === WorkflowEventType.BoundaryInterruptingTimer) {
                    usable.push(c);
                }
                else if (c.event.type === WorkflowEventType.BoundaryForkTimer) {
                    if (c.event.runRepeatedly || !await CaseQueries.executedTimers(c.activity)
                        .some(t => t.boundaryEvent.is(c.event)))
                        usable.push(c);
                }
            }

            const candidates = [...usable, ...intermediateCandidates];
            const activities: Lite<CaseActivityEntity>[] = [];

            for (const c of candidates) {
                const timer = c.event.timer!;
                if (timer.condition == null) {
                    if (timer.duration == null)
                        continue;
                    const last = await CaseQueries.lastExecutedTimer(c.activity, c.event.toLite());
                    const startDate = last?.creationDate ?? c.activity.startDate;
                    if (Temporal.PlainDateTime.compare(timer.duration.add(startDate), now) < 0)
                        activities.push(c.activity.toLite());
                }
                else if (!timer.avoidExecuteConditionByTimer) {
                    if (await WorkflowLogic.evaluateTimerCondition(timer.condition, c.activity, now))
                        activities.push(c.activity.toLite());
                }
            }

            const distinct = activities.distinctBy(a => a.key());
            if (distinct.length === 0)
                return null;

            const pkg = PackageEntity.create({ name: CaseActivityTask.Timeout.key });
            await pkg.save();
            for (const a of distinct)
                await PackageLineEntity.create({ package: pkg.toLite(), target: a }).save();

            const process = await ProcessLogic.create(CaseActivityProcessAlgorithm.Timeout, pkg.toLite());
            await Operations.execute(process, ProcessOperation.Execute);
            return process.toLite();
        });

        // Signum: `ProcessLogic.Register(Timeout, new PackageExecuteAlgorithm<CaseActivityEntity>(Timer))`.
        // altea-processes has no generic package-execute algorithm (see the header), so the walk is here.
        ProcessLogic.registerAction(CaseActivityProcessAlgorithm.Timeout, async (ep: ExecutingProcess) => {
            const pkg = ep.data as Lite<PackageEntity> | null;
            if (pkg == null)
                throw new Error("The Timeout process has no PackageEntity");

            const lines = await table(PackageLineEntity)
                .filter(l => l.package.is(pkg) && l.finishTime == null)
                .toArray();

            await ep.forEach(lines, l => String(l.target), async line => {
                const ca = await retrieve(CaseActivityEntity, line.target.id!);
                await Operations.execute(ca, CaseActivityOperation.Timer);
                line.finishTime = Clock.now;
                await line.save();
            }, line => line.toLite());
        });
    }

    // ---- Case-activity moves (used by the designer) -------------------------------------------------

    function caseActivitiesOf(node: IWorkflowNodeEntity): IQuery<CaseActivityEntity> {
        return table(CaseActivityEntity).filter(a => a.workflowActivity.is(node));
    }

    /** Does this node still hold any case activity? (the XML importer's refusal check) */
    export async function hasCaseActivities(node: IWorkflowNodeEntity): Promise<boolean> {
        return await caseActivitiesOf(node).some();
    }

    /** Signum's LaneBuilder.DeleteCaseActivities(node, filter) with an always-true filter. */
    async function deleteCaseActivities(node: IWorkflowNodeEntity): Promise<void> {
        if (node instanceof WorkflowActivityEntity
            && (node.type === WorkflowActivityType.DecompositionWorkflow || node.type === WorkflowActivityType.CallWorkflow)) {
            // The subcases go with the decomposition that created them.
            const sub = node.subWorkflow!.workflow;
            for (const c of await CaseQueries.cases(sub).filter(c => c.parentCase != null).toArray())
                await deleteCase(c);
        }

        if (!await caseActivitiesOf(node).some())
            return;

        await table(CaseNotificationEntity)
            .filter(n => n.caseActivity.entity.workflowActivity.is(node))
            .executeDelete();

        // Re-point the `previous` chain PAST the activities that are about to go.
        await table(CaseActivityEntity)
            .filter(ca => ca.previous!.entity.workflowActivity.is(node))
            .executeUpdate(ca => ({ previous: ca.previous!.entity.previous }));

        const running = await caseActivitiesOf(node).filter(a => a.doneDate == null).toArray();
        for (const a of running) {
            if (a.previous == null)
                throw new Error(CaseActivityMessage
                    .ImpossibleToDeleteCaseActivity0OnWorkflowActivity1BecauseHasNoPreviousActivity
                    .niceToString(a.id, a.workflowActivity));

            const previous = await retrieve(CaseActivityEntity, a.previous.id!);
            await Operations.execute(previous, CaseActivityOperation.Undo);
        }

        await table(CaseActivityEntity).filter(a => a.workflowActivity.is(node)).executeDelete();
    }

    /** Signum's MoveCasesAndDelete's replacement half. */
    async function moveCaseActivities(node: IWorkflowNodeEntity, replacement: IWorkflowNodeEntity): Promise<void> {
        await table(CaseActivityEntity).filter(a => a.workflowActivity.is(node) && a.doneDate != null)
            .executeUpdate(() => ({ workflowActivity: replacement }));

        const running = await caseActivitiesOf(node).filter(a => a.doneDate == null).toArray();
        for (const a of running) {
            await table(CaseNotificationEntity).filter(n => n.caseActivity.is(a)).executeDelete();
            a.workflowActivity = replacement;
            await a.save();
            await insertCaseActivityNotifications(a);
        }
    }

    async function assertCurrentUserHasNotification(ca: CaseActivityEntity): Promise<void> {
        const any = await CaseQueries.notifications(ca).some(cn => cn.isForMe()
            && (cn.state === CaseNotificationState.New
                || cn.state === CaseNotificationState.Opened
                || cn.state === CaseNotificationState.InProgress));
        if (!any)
            throw new Error(CaseActivityMessage.NoNewOrOpenedOrInProgressNotificationsFound.niceToString());
    }

    async function isFreshNew(ca: CaseActivityEntity): Promise<boolean> {
        return ca.doneDate == null
            && await CaseQueries.notifications(ca).every(n => n.state === CaseNotificationState.New);
    }

    async function checkRequiresOpen(ca: CaseActivityEntity): Promise<void> {
        if (!(ca.workflowActivity as WorkflowActivityEntity).requiresOpen)
            return;

        if (!await CaseQueries.notifications(ca).some(cn => cn.isForMe() && cn.state !== CaseNotificationState.New))
            throw new Error(CaseActivityMessage.TheActivity0RequiresToBeOpened.niceToString(ca.workflowActivity));
    }

    function getScriptExecution(workflowActivity: IWorkflowNodeEntity): ScriptExecutionEmbedded | null {
        return workflowActivity instanceof WorkflowActivityEntity && workflowActivity.type === WorkflowActivityType.Script
            ? ScriptExecutionEmbedded.create({ nextExecution: Clock.now, retryCount: 0 as never })
            : null;
    }

    async function makeDone(ca: CaseActivityEntity, doneType: DoneType, decision: string | null): Promise<void> {
        ca.doneBy = UserHolder.currentUserLite() as Lite<UserEntity> | null;
        ca.doneDate = Clock.now;
        ca.doneType = doneType;
        ca.doneDecision = decision;
        ca.case.description = etc((ca.case.mainEntity as Entity).toString().trim(), 100);
        await ca.save();

        await ExecutionMode.global(() => table(CaseNotificationEntity)
            .filter(cn => cn.caseActivity.is(ca))
            .executeUpdate(cn => ({
                state: cn.isForMe() ? CaseNotificationState.Done : CaseNotificationState.DoneByOther,
            })));
    }

    // ---- ExecuteStep and friends -------------------------------------------------------------------

    export async function executeStep(ca: CaseActivityEntity, doneType: DoneType, decision: string | null,
        firstConnection: WorkflowConnectionEntity | null): Promise<void> {

        await WorkflowActivityInfo.withScope({ caseActivity: ca, connection: firstConnection, decision },
            () => saveEntity(ca.case.mainEntity));

        await makeDone(ca, doneType, decision);

        const ctx = new WorkflowExecuteStepContext(ca.case, ca);

        if (firstConnection != null) {
            if (firstConnection.condition != null) {
                const jumpCtx = ctx.newTransitionContext(firstConnection);
                const result = await WorkflowLogic.evaluateCondition(firstConnection.condition, ca.case.mainEntity, jumpCtx);
                if (!result)
                    throw new Error(WorkflowMessage.JumpTo0FailedBecause1
                        .niceToString(firstConnection.to, firstConnection.condition));
            }

            await ctx.executeConnection(firstConnection);
            if (!await findNextNode(firstConnection.to, ctx))
                return;
        }
        else {
            const connection = (await WorkflowLogic.nextConnectionsFromCache(ca.workflowActivity, ConnectionType.Normal)).single();
            if (!await findNextConnection(connection, ctx))
                return;
        }

        await finishStep(ca.case, ctx, ca);
    }

    async function finishStep(caseEntity: CaseEntity, ctx: WorkflowExecuteStepContext,
        ca: CaseActivityEntity | null): Promise<void> {

        caseEntity.description = etc((caseEntity.mainEntity as Entity).toString().trim(), 100);

        if (ctx.isFinished) {
            if (ctx.toActivities.length > 0 || ctx.toIntermediateEvents.length > 0)
                throw new Error("toActivities and toIntermediateEvents should be empty when finishing");

            if (await CaseQueries.caseActivities(caseEntity).some(a => a.doneDate == null))
                return;

            await WorkflowActivityInfo.withScope({ caseActivity: ca, connection: null },
                () => saveEntity(ca!.case.mainEntity));

            caseEntity.finishDate = ca!.doneDate!;
            await caseEntity.save();

            if (caseEntity.parentCase != null)
                await tryToRecompose(caseEntity);
        }
        else {
            await createNextActivities(caseEntity, ctx, ca);
        }
    }

    export async function createNextActivities(caseEntity: CaseEntity, ctx: WorkflowExecuteStepContext,
        previous: CaseActivityEntity | null): Promise<void> {

        await caseEntity.save();

        for (const twa of ctx.toActivities) {
            if (twa.type === WorkflowActivityType.DecompositionWorkflow || twa.type === WorkflowActivityType.CallWorkflow) {
                const lastConn = ctx.connections.single(a => a.to.is(twa));
                await decompose(caseEntity, previous, twa, lastConn, ctx);
            }
            else {
                const nca = await insertNewCaseActivity(caseEntity, twa, previous);
                await insertCaseActivityNotifications(nca);
                await ctx.notifyTransitionContext(nca);
            }
        }

        for (const twe of ctx.toIntermediateEvents)
            await insertNewCaseActivity(caseEntity, twe, previous);
    }

    async function executeBoundaryTimer(ca: CaseActivityEntity, boundaryEvent: WorkflowEventEntity): Promise<void> {
        switch (boundaryEvent.type) {
            case WorkflowEventType.BoundaryForkTimer:
                await CaseActivityExecutedTimerEntity.create({
                    boundaryEvent: boundaryEvent.toLite(),
                    caseActivity: ca.toLite(),
                }).save();
                break;
            case WorkflowEventType.BoundaryInterruptingTimer:
                await makeDone(ca, DoneType.Timeout, boundaryEvent.decisionOptionName);
                break;
            default:
                throw new Error("Unexpected Boundary Timer Type " + Enum.niceName(WorkflowEventType, boundaryEvent.type));
        }

        const connection = (await WorkflowLogic.nextConnectionsFromCache(boundaryEvent, ConnectionType.Normal)).single();

        const ctx = new WorkflowExecuteStepContext(ca.case, ca);
        await ctx.executeConnection(connection);

        if (!await findNextNode(connection.to, ctx))
            return;

        await finishStep(ca.case, ctx, ca);
    }

    /** Signum's ExecuteInitialStep — the first step of a case a SCHEDULED START opened (there is no
     *  previous activity, so the walk begins at the start event's outgoing connection). */
    export async function executeInitialStep(caseEntity: CaseEntity, event: WorkflowEventEntity,
        transition: WorkflowConnectionEntity): Promise<void> {

        await saveEntity(caseEntity.mainEntity);

        caseEntity.description = etc((caseEntity.mainEntity as Entity).toString().trim(), 100);
        await caseEntity.save();

        const ctx = new WorkflowExecuteStepContext(caseEntity, null);

        if (transition.condition != null) {
            const jumpCtx = new WorkflowTransitionContext(caseEntity, null, transition);
            const result = await WorkflowLogic.evaluateCondition(transition.condition, caseEntity.mainEntity, jumpCtx);
            if (!result)
                throw new Error(WorkflowMessage.JumpTo0FailedBecause1.niceToString(transition, transition.condition));
        }

        await ctx.executeConnection(transition);
        if (!await findNextNode(transition.to, ctx))
            return;

        await finishStep(caseEntity, ctx, null);
    }

    async function insertNewCaseActivity(caseEntity: CaseEntity, workflowActivity: IWorkflowNodeEntity,
        previous: CaseActivityEntity | null): Promise<CaseActivityEntity> {

        const ca = CaseActivityEntity.create({
            startDate: previous?.doneDate ?? Clock.now,
            previous: previous?.toLite() ?? null,
            workflowActivity,
            originalWorkflowActivityName: workflowActivity.getName()!,
            case: caseEntity,
            scriptExecution: getScriptExecution(workflowActivity),
        });
        await ca.save();
        return ca;
    }

    /** Signum's TryToRecompose — when every sibling subcase has finished, finish the surrogate. */
    export async function tryToRecompose(childCase: CaseEntity): Promise<void> {
        // Type conditions may not give access to the parent case, so this runs ungated (as in Signum).
        await ExecutionMode.global(async () => {
            const allFinished = await table(CaseEntity)
                .filter(cc => cc.parentCase!.is(childCase.parentCase!) && cc.workflow.is(childCase.workflow))
                .every(a => a.finishDate != null);

            if (!allFinished)
                return;

            const decompositionCaseActivity = await CaseQueries.decompositionSurrogateActivity(childCase);
            if (decompositionCaseActivity.doneDate != null)
                throw new Error("The DecompositionCaseActivity is already finished");

            const siblings = await table(CaseEntity).filter(c => c.parentCase!.is(childCase.parentCase!)).toArray();
            const notes: string[] = [];
            for (const c of siblings) {
                const last = await CaseQueries.caseActivities(c).orderByDescending(ca => ca.doneDate).firstOrNull();
                if (last != null && (last.note ?? "") !== "")
                    notes.push(`${last.doneBy}: ${last.note}`);
            }

            decompositionCaseActivity.note = notes.join("\n");
            await executeStep(decompositionCaseActivity, DoneType.Recompose, null, null);
        });
    }

    async function decompose(caseEntity: CaseEntity, previous: CaseActivityEntity | null,
        decActivity: WorkflowActivityEntity, conn: WorkflowConnectionEntity,
        ctx: WorkflowExecuteStepContext): Promise<void> {

        await ExecutionMode.global(async () => {
            const surrogate = await insertNewCaseActivity(caseEntity, decActivity, previous);
            await ctx.notifyTransitionContext(surrogate);

            const subEntities = await WorkflowLogic.evaluateSubEntities(
                decActivity.subWorkflow!.subEntitiesEval, caseEntity.mainEntity,
                new WorkflowTransitionContext(caseEntity, previous, conn));

            if (decActivity.type === WorkflowActivityType.CallWorkflow && subEntities.length > 1)
                throw new Error("More than one entity generated using CallWorkflow. Use DecompositionWorkflow instead.");

            if (subEntities.length === 0) {
                await executeStep(surrogate, DoneType.Recompose, null, null);
            }
            else {
                const subWorkflow = decActivity.subWorkflow!.workflow;
                for (const se of subEntities) {
                    const caseActivity = await Operations.constructFrom(subWorkflow,
                        CaseActivityOperation.CreateCaseActivityFromWorkflow, se, caseEntity.toLite());
                    caseActivity.previous = surrogate.toLite();
                    await Operations.execute(caseActivity, CaseActivityOperation.Register);
                }
            }
        });
    }

    async function findNextConnection(connection: WorkflowConnectionEntity, ctx: WorkflowExecuteStepContext): Promise<boolean> {
        await ctx.executeConnection(connection);
        return await findNextNode(connection.to, ctx);
    }

    /** Signum's FindNext(node, ctx) — the heart of the walk. */
    async function findNextNode(next: IWorkflowNodeEntity, ctx: WorkflowExecuteStepContext): Promise<boolean> {
        if (next instanceof WorkflowEventEntity) {
            if (next.type === WorkflowEventType.Finish) {
                ctx.isFinished = true;
                return true;
            }
            if (next.type === WorkflowEventType.IntermediateTimer) {
                ctx.toIntermediateEvents.push(next);
                return true;
            }
            throw new Error(`Unexpected WorkflowEventType ${Enum.niceName(WorkflowEventType, next.type)}`);
        }

        if (next instanceof WorkflowActivityEntity) {
            ctx.toActivities.push(next);
            return true;
        }

        const gateway = next as WorkflowGatewayEntity;

        switch (gateway.type) {
            case WorkflowGatewayType.Exclusive: {
                if (gateway.direction === WorkflowGatewayDirection.Split) {
                    const all = await WorkflowLogic.nextConnectionsFromCache(gateway, null);
                    const groups = all
                        .filter(a => a.type === ConnectionType.Normal || a.type === ConnectionType.Decision)
                        .groupBy(c => String(c.order))
                        .orderBy(gr => Number(gr.key));

                    for (const gr of groups) {
                        const applicableOnes: WorkflowConnectionEntity[] = [];
                        for (const c of gr.elements)
                            if (await applicable(c, ctx))
                                applicableOnes.push(c);
                        if (applicableOnes.length > 1)
                            throw new Error(`More than one applicable connection on gateway '${gateway}'`);
                        if (applicableOnes.length === 1)
                            return await findNextConnection(applicableOnes[0], ctx);
                    }

                    throw new Error(CaseActivityMessage.NoNextConnectionThatSatisfiesTheConditionsFound.niceToString());
                }

                const singleConnection = (await WorkflowLogic.nextConnectionsFromCache(gateway, ConnectionType.Normal)).single();
                return await findNextConnection(singleConnection, ctx);
            }

            case WorkflowGatewayType.Parallel:
            case WorkflowGatewayType.Inclusive: {
                if (gateway.direction === WorkflowGatewayDirection.Split) {
                    const all = await WorkflowLogic.nextConnectionsFromCache(gateway, null);
                    const candidates = all.filter(a => a.type === ConnectionType.Decision
                        || (a.type === ConnectionType.Normal
                            && (gateway.type === WorkflowGatewayType.Parallel || a.condition != null)));

                    const applicableOnes: WorkflowConnectionEntity[] = [];
                    for (const c of candidates) {
                        const app = await applicable(c, ctx);
                        if (!app && gateway.type === WorkflowGatewayType.Parallel)
                            throw new Error(`Conditions not allowed in `
                                + `${Enum.niceName(WorkflowGatewayType, WorkflowGatewayType.Parallel)} `
                                + `${Enum.niceName(WorkflowGatewayDirection, WorkflowGatewayDirection.Split)}!`);
                        if (app)
                            applicableOnes.push(c);
                    }

                    if (applicableOnes.length === 0) {
                        if (gateway.type === WorkflowGatewayType.Parallel)
                            throw new Error(WorkflowValidationMessage
                                .ParallelSplit0ShouldHaveAtLeastOneConnection.niceToString(gateway));

                        const fallback = all.singleOrNull(a => a.condition == null && a.type === ConnectionType.Normal);
                        if (fallback == null)
                            throw new Error(WorkflowValidationMessage
                                .InclusiveGateway0ShouldHaveOneConnectionWithoutCondition.niceToString(gateway));

                        return await findNextConnection(fallback, ctx);
                    }

                    for (const con of applicableOnes)
                        await findNextConnection(con, ctx);
                    return true;
                }

                if (!(await allTrackCompleted(0, gateway, ctx, new Set())).isCompleted)
                    return false;

                const singleConnection = (await WorkflowLogic.nextConnectionsFromCache(gateway, ConnectionType.Normal)).single();
                return await findNextConnection(singleConnection, ctx);
            }

            default:
                throw new Error("Unexpected gateway type");
        }
    }

    /** Signum's BoolBox — "is this track complete, and which activity completed it?" */
    class BoolBox {
        private constructor(readonly isCompleted: boolean, readonly caseActivity: CaseActivityEntity | null) {
            if (caseActivity != null && !isCompleted)
                throw new Error("Not completed should not have caseActivities");
            if (caseActivity != null && caseActivity.doneDate == null)
                throw new Error("caseActivity is not completed");
        }

        static get False(): BoolBox { return new BoolBox(false, null); }
        static True(ca: CaseActivityEntity | null): BoolBox { return new BoolBox(true, ca); }

        /** Signum's IsCompatible — the done-type / decision / condition must match the connection taken. */
        async isCompatible(wc: WorkflowConnectionEntity): Promise<boolean> {
            if (!this.isCompleted)
                return false;

            const ca = this.caseActivity;
            if (ca == null)
                return true;

            let doneTypeOk: boolean;
            switch (ca.doneType!) {
                case DoneType.Next:
                    doneTypeOk = wc.type === ConnectionType.Normal
                        && (wc.doneDecision() == null || wc.doneDecision() === ca.doneDecision);
                    break;
                case DoneType.Jump:
                    doneTypeOk = wc.from.is(ca.workflowActivity)
                        ? wc.type === ConnectionType.Jump : wc.type === ConnectionType.Normal;
                    break;
                case DoneType.ScriptFailure:
                    doneTypeOk = wc.from.is(ca.workflowActivity)
                        ? wc.type === ConnectionType.ScriptException : wc.type === ConnectionType.Normal;
                    break;
                case DoneType.ScriptSuccess:
                    doneTypeOk = wc.type === ConnectionType.Normal;
                    break;
                case DoneType.Timeout:
                    doneTypeOk = ca.workflowActivity instanceof WorkflowActivityEntity
                        ? !wc.from.is(ca.workflowActivity) && wc.type === ConnectionType.Normal
                        : ca.workflowActivity instanceof WorkflowEventEntity && ca.workflowActivity.is(wc.from)
                            ? wc.type === ConnectionType.Normal
                            : false;
                    break;
                case DoneType.Recompose:
                    doneTypeOk = wc.type === ConnectionType.Normal;
                    break;
                default:
                    throw new Error("Unexpected DoneType");
            }

            if (!doneTypeOk)
                return false;

            if (wc.condition != null)
                return await WorkflowLogic.evaluateCondition(wc.condition, ca.case.mainEntity,
                    new WorkflowTransitionContext(ca.case, ca, wc));

            return true;
        }
    }

    /**
     * Signum's AllTrackCompleted — the recursive "has every branch feeding this join finished?" walk.
     * Ported structure-for-structure; `depth` is Signum's split/join nesting counter.
     */
    async function allTrackCompleted(depth: number, node: IWorkflowNodeEntity, ctx: WorkflowExecuteStepContext,
        visited: Set<IWorkflowNodeEntity>): Promise<BoolBox> {

        const lastCaseActivityOf = async (n: IWorkflowNodeEntity): Promise<CaseActivityEntity | null> =>
            await CaseQueries.caseActivities(ctx.case_).filter(a => a.workflowActivity.is(n))
                .orderBy(a => a.startDate).lastOrNull();

        if (node instanceof WorkflowActivityEntity
            || (node instanceof WorkflowEventEntity && node.type === WorkflowEventType.IntermediateTimer)) {

            let caseActivity = await lastCaseActivityOf(node);

            if (caseActivity != null) {
                if (node.is(ctx.previousCaseActivity!.workflowActivity))
                    caseActivity = ctx.previousCaseActivity;

                return caseActivity!.doneDate != null ? BoolBox.True(caseActivity) : BoolBox.False;
            }

            if (visited.has(node))
                return BoolBox.False;

            const previous = await WorkflowLogic.previousConnectionsFromCache(node);
            visited.add(node);
            try {
                for (const wc of previous)
                    if (await (await allTrackCompleted(depth, wc.from, ctx, visited)).isCompatible(wc))
                        return BoolBox.True(caseActivity);
                return BoolBox.False;
            } finally {
                visited.delete(node);
            }
        }

        if (node instanceof WorkflowEventEntity
            && (node.type === WorkflowEventType.BoundaryForkTimer || node.type === WorkflowEventType.BoundaryInterruptingTimer)) {

            const g = await WorkflowLogic.getWorkflowNodeGraph(node.lane.pool.workflow.toLite());
            const parentActivity = g.getActivity(node.boundaryOf!);

            const caseActivity = await lastCaseActivityOf(parentActivity);

            if (caseActivity != null) {
                if (node.is(ctx.previousCaseActivity!.workflowActivity))
                    throw new Error("Unexpected BoundaryTimer with WorkflowEvent in CaseActivity");

                return caseActivity.doneDate != null ? BoolBox.True(caseActivity) : BoolBox.False;
            }

            if (visited.has(parentActivity))
                return BoolBox.False;

            visited.add(parentActivity);
            try {
                const connections = await WorkflowLogic.previousConnectionsFromCache(parentActivity);
                if (parentActivity.boundaryTimers.some(a => a.type === WorkflowEventType.BoundaryForkTimer)) {
                    if (depth <= 1)
                        return BoolBox.True(null);

                    for (const wc of connections)
                        if (await (await allTrackCompleted(depth - 1, wc.from, ctx, visited)).isCompatible(wc))
                            return BoolBox.True(caseActivity);
                    return BoolBox.False;
                }

                for (const wc of connections)
                    if (await (await allTrackCompleted(depth, wc.from, ctx, visited)).isCompatible(wc))
                        return BoolBox.True(caseActivity);
                return BoolBox.False;
            } finally {
                visited.delete(parentActivity);
            }
        }

        if (node instanceof WorkflowGatewayEntity) {
            if (node.direction === WorkflowGatewayDirection.Split) {
                const wc = (await WorkflowLogic.previousConnectionsFromCache(node)).single();
                switch (node.type) {
                    case WorkflowGatewayType.Exclusive: {
                        const bb = await allTrackCompleted(depth, wc.from, ctx, visited);
                        return await bb.isCompatible(wc) ? BoolBox.True(bb.caseActivity) : BoolBox.False;
                    }
                    case WorkflowGatewayType.Inclusive:
                    case WorkflowGatewayType.Parallel: {
                        if (depth <= 1)
                            return BoolBox.True(null);
                        const bb = await allTrackCompleted(depth - 1, wc.from, ctx, visited);
                        return await bb.isCompatible(wc) ? BoolBox.True(bb.caseActivity) : BoolBox.False;
                    }
                    default:
                        throw new Error("Unexpected gateway type");
                }
            }

            const connections = await WorkflowLogic.previousConnectionsFromCache(node);

            switch (node.type) {
                case WorkflowGatewayType.Exclusive: {
                    for (const wc of connections) {
                        const tuple = await allTrackCompleted(depth, wc.from, ctx, visited);
                        if (await tuple.isCompatible(wc))
                            return tuple;
                    }
                    return BoolBox.False;
                }
                case WorkflowGatewayType.Inclusive:
                case WorkflowGatewayType.Parallel: {
                    const g = await WorkflowLogic.getWorkflowNodeGraph(node.lane.pool.workflow.toLite());

                    // Every parallel join behaves as an implicit EXCLUSIVE join within each track group.
                    const groups = connections.groupBy(wc =>
                        String(g.trackId!.get(WorkflowNodeGraph.nodeKey(wc.from))));
                    for (const gr of groups) {
                        let anyCompatible = false;
                        for (const wc of gr.elements)
                            if (await (await allTrackCompleted(depth + 1, wc.from, ctx, visited)).isCompatible(wc)) {
                                anyCompatible = true;
                                break;
                            }
                        if (!anyCompatible)
                            return BoolBox.False;
                    }
                    return BoolBox.True(null);
                }
                default:
                    throw new Error("Unexpected gateway type");
            }
        }

        throw new Error("Unexpected node " + node);
    }

    function registerCaseOperations(op: FluentOperations<CaseEntity>): void {
        op.withExecute(CaseOperation.SetTags, {
            execute: async (e, args) => {
                const current = await CaseQueries.tags(e).toArray();
                const model = args[0] as CaseTagsModel;

                const toDelete = current.filter(ct =>
                    model.oldCaseTags.some(t => t.is(ct.tagType)) && !model.caseTags.some(t => t.is(ct.tagType)));

                for (const ct of toDelete)
                    await ct.delete();

                const createdBy = UserHolder.currentUserLite();
                for (const ctt of model.caseTags.filter(ctt => !current.some(ct => ct.tagType.is(ctt))))
                    await CaseTagEntity.create({ case: e.toLite(), tagType: ctt, createdBy: createdBy! }).save();
            },
        });

        op.withExecute(CaseOperation.Cancel, {
            canExecute: c => c.finishDate == null ? null : CaseActivityMessage.AlreadyFinished.niceToString(),
            execute: async (c, args) => {
                const avoidRecompose = (args[0] as boolean | undefined) ?? false;

                for (const sc of await CaseQueries.subCases(c).filter(a => a.finishDate == null).toArray())
                    await Operations.execute(sc, CaseOperation.Cancel, true);

                const currentActivities = await CaseQueries.caseActivities(c).filter(a => a.doneBy == null).toArray();
                const me = UserHolder.currentUserLite() as Lite<UserEntity> | null;

                for (const ca of currentActivities) {
                    ca.doneBy = me;
                    ca.doneDate = Clock.now;
                    ca.doneType = DoneType.Jump;
                    ca.doneDecision = canceledCaseMarker();
                    await ca.save();

                    for (const notification of await table(CaseNotificationEntity).filter(n => n.caseActivity.is(ca)).toArray()) {
                        notification.state = CaseNotificationState.DoneByOther;
                        await notification.save();
                    }
                }

                c.finishDate = Clock.now;
                await cancelEntity(c.mainEntity, c);
                await c.save();

                if (c.parentCase != null && !avoidRecompose)
                    await tryToRecompose(c);
            },
        });

        op.withDelete(CaseOperation.Delete, {
            canDelete: e => e.parentCase == null ? null
                : CaseActivityMessage.CaseIsADecompositionOf0.niceToString(e.parentCase),
            delete: async (c, args) => {
                await deleteCase(c);
                if (args[0] === true)
                    await (c.mainEntity as Entity).delete();
            },
        });

        op.withExecute(CaseOperation.Reactivate, {
            canExecute: c => c.finishDate != null ? null : CaseActivityMessage.NotCanceled.niceToString(),
            execute: async c => {
                const cancelled = await cancelledActivities(c).toArray();
                if (cancelled.length === 0)
                    throw new Error(CaseActivityMessage.NotCanceled.niceToString());

                await reactivateEntity(c.mainEntity, c);

                const rejected = await table(CaseActivityEntity)
                    .filter(a => a.case.is(c) && a.doneBy != null
                        && (a.doneType === DoneType.Next || a.doneType === DoneType.Recompose))
                    .orderByDescending(a => a.doneDate).top(1).toArray();

                for (const ca of [...cancelled, ...rejected]) {
                    ca.doneBy = null;
                    ca.doneDate = null;
                    ca.doneType = null;
                    ca.doneDecision = null;
                    await ca.save();

                    for (const notification of await table(CaseNotificationEntity).filter(n => n.caseActivity.is(ca)).toArray()) {
                        notification.state = CaseNotificationState.New;
                        await notification.save();
                    }
                }

                c.finishDate = null;
                await c.save();

                for (const sc of await CaseQueries.subCases(c).filter(a => a.finishDate != null).toArray())
                    await Operations.execute(sc, CaseOperation.Reactivate, true);
            },
        });
    }

    function registerCaseNotificationOperations(op: FluentOperations<CaseNotificationEntity>): void {
        op.withExecute(CaseNotificationOperation.SetRemarks, {
            execute: (e, args) => { e.remarks = args[0] as string; },
        });

        op.withDelete(CaseNotificationOperation.Delete);

        op.withConstructFrom(CaseActivityEntity, CaseNotificationOperation.CreateCaseNotificationFromCaseActivity, {
            construct: async (e, args) => {
                const user = args[0] as Lite<UserEntity>;
                const n = CaseNotificationEntity.create({
                    caseActivity: e.toLite(),
                    actor: user,
                    user,
                    state: CaseNotificationState.New,
                });
                await n.save();
                return n;
            },
            resultIsSaved: true,
        });
    }

    function registerCaseActivityOperations(sm: FluentStateMachine<CaseActivityEntity, CaseActivityState>): void {
        sm.withConstructFrom(WorkflowEntity, CaseActivityOperation.CreateCaseActivityFromWorkflow, {
            toStates: [CaseActivityState.New],
            construct: async (w, args) => {
                if (hasExpired(w))
                    throw new Error(WorkflowMessage.Workflow0HasExpiredOn1
                        .niceToString(w, w.expirationDate!.toString()));

                const parentCase = args.firstOrNull(a => a instanceof Lite
                    && (a as Lite<Entity>).entityType === CaseEntity) as Lite<CaseEntity> | null;

                const wfGraph = await WorkflowLogic.getWorkflowNodeGraph(w.toLite());
                if (parentCase == null && !await wfGraph.isStartCurrentUser(
                    WorkflowLogic.isCurrentUserActor as never, ((lane: WorkflowLaneEntity) => getActors(lane, null)) as never))
                    throw new Error(WorkflowMessage
                        .YouAreNotMemberOfAnyLaneContainingAnStartEventInWorkflow0.niceToString(wfGraph.workflow));

                const mainEntity = (args.firstOrNull(a => a instanceof Entity) as ICaseMainEntity | null)
                    ?? await createMainEntity(w.mainEntityType.cleanName);

                const caseEntity = CaseEntity.create({
                    parentCase,
                    workflow: w,
                    description: w.name,
                    mainEntity,
                });

                const start = [...wfGraph.events.values()].single(a => a.type === WorkflowEventType.Start);
                const connection = (await WorkflowLogic.nextConnectionsFromCache(start, ConnectionType.Normal)).single();
                const next = connection.to as WorkflowActivityEntity;

                return CaseActivityEntity.create({
                    workflowActivity: next,
                    originalWorkflowActivityName: next.name,
                    case: caseEntity,
                    scriptExecution: getScriptExecution(next),
                });
            },
        });

        sm.withExecute(CaseActivityOperation.Register, {
            canExecute: ca => !(ca.workflowActivity instanceof WorkflowActivityEntity)
                ? CaseActivityMessage.NoWorkflowActivity.niceToString() : null,
            fromStates: [CaseActivityState.New],
            toStates: [CaseActivityState.Pending],
            canBeNew: true,
            canBeModified: true,
            execute: async ca => {
                const wfGraph = await WorkflowLogic.getWorkflowNodeGraph(ca.workflowActivity.lane.pool.workflow.toLite());
                if (ca.case.parentCase == null && !await wfGraph.isStartCurrentUser(
                    WorkflowLogic.isCurrentUserActor as never, ((lane: WorkflowLaneEntity) => getActors(lane, null)) as never))
                    throw new Error(WorkflowMessage
                        .YouAreNotMemberOfAnyLaneContainingAnStartEventInWorkflow0.niceToString(wfGraph.workflow));

                await saveEntity(ca.case.mainEntity);
                const now = Clock.now;
                const c = ca.case;
                c.startDate = now;
                c.description = etc((c.mainEntity as Entity).toString().trim(), 100);
                await c.save();

                const prevConns = await WorkflowLogic.previousConnectionsFromCache(ca.workflowActivity);
                const prevConn = prevConns.single(a => a.from instanceof WorkflowEventEntity
                    && (a.from as WorkflowEventEntity).type === WorkflowEventType.Start);

                const wec = new WorkflowExecuteStepContext(ca.case,
                    ca.previous == null ? null : await retrieve(CaseActivityEntity, ca.previous.id!));

                await wec.executeConnection(prevConn);

                ca.startDate = now;
                await ca.save();

                await insertCaseActivityNotifications(ca);

                await wec.notifyTransitionContext(ca);
            },
        });

        sm.withExecute(CaseActivityOperation.Next, {
            canExecute: ca => !(ca.workflowActivity instanceof WorkflowActivityEntity)
                ? CaseActivityMessage.NoWorkflowActivity.niceToString() : null,
            fromStates: [CaseActivityState.Pending],
            toStates: [CaseActivityState.Done],
            canBeModified: true,
            execute: async (ca, args) => {
                await assertCurrentUserHasNotification(ca);
                await checkRequiresOpen(ca);
                await executeStep(ca, DoneType.Next, (args[0] as string | undefined) ?? null, null);
            },
        });

        sm.withExecute(CaseActivityOperation.Jump, {
            canExecute: ca => !(ca.workflowActivity instanceof WorkflowActivityEntity)
                ? CaseActivityMessage.NoWorkflowActivity.niceToString() : null,
            fromStates: [CaseActivityState.Pending],
            toStates: [CaseActivityState.Done],
            canBeModified: true,
            execute: async (ca, args) => {
                await assertCurrentUserHasNotification(ca);
                await checkRequiresOpen(ca);
                const to = args[0] as Lite<IWorkflowNodeEntity>;
                const jumps = await WorkflowLogic.nextConnectionsFromCache(ca.workflowActivity, ConnectionType.Jump);
                if (jumps.length === 0)
                    throw new Error(CaseActivityMessage.Activity0HasNoJumps.niceToString(ca.workflowActivity));
                const jump = jumps.single(c => to.is(c.to));
                await executeStep(ca, DoneType.Jump, null, jump);
            },
        });

        sm.withExecute(CaseActivityOperation.FreeJump, {
            fromStates: [CaseActivityState.Pending],
            toStates: [CaseActivityState.Done],
            canBeModified: true,
            execute: async (ca, args) => {
                const toLite = args[0] as Lite<WorkflowActivityEntity>;
                const to = await retrieve(WorkflowActivityEntity, toLite.id!);
                if (!to.lane.pool.workflow.is(ca.case.workflow))
                    throw new Error(`Activity ${to} does not belong to workflow ${ca.case.workflow}`);

                await WorkflowActivityInfo.withScope({ caseActivity: ca, connection: null },
                    () => saveEntity(ca.case.mainEntity));

                await makeDone(ca, DoneType.Jump, null);

                const ctx = new WorkflowExecuteStepContext(ca.case, ca);
                ctx.toActivities.push(to);
                await createNextActivities(ca.case, ctx, ca);
            },
        });

        sm.withExecute(CaseActivityOperation.Timer, {
            fromStates: [CaseActivityState.Pending],
            toStates: [CaseActivityState.Done, CaseActivityState.Pending],
            canExecute: ca => (ca.workflowActivity instanceof WorkflowEventEntity && isTimer(ca.workflowActivity.type))
                || (ca.workflowActivity instanceof WorkflowActivityEntity && ca.workflowActivity.boundaryTimers.length > 0)
                ? null : CaseActivityMessage.Activity0HasNoTimers.niceToString(ca.workflowActivity),
            execute: async (ca, args) => {
                const now = Clock.now;

                // The graph's copy of the activity carries the boundary timers (they are not persisted).
                const g2 = await WorkflowLogic.getWorkflowNodeGraph(ca.case.workflow.toLite());
                const node = g2.getNode(ca.workflowActivity.toLite());

                let candidateEvents = node instanceof WorkflowEventEntity ? [node]
                    : (node as WorkflowActivityEntity).boundaryTimers;

                const specific = args.firstOrNull(a => Array.isArray(a)) as Lite<WorkflowEventEntity>[] | null;
                if (specific != null)
                    candidateEvents = candidateEvents.filter(ce => specific.some(e => e.is(ce)));

                const executed = await CaseQueries.executedTimers(ca).toArray();
                const lastByEvent = new Map<string, CaseActivityExecutedTimerEntity>(executed
                    .groupBy(t => t.boundaryEvent.key())
                    .map(gr => [gr.key, gr.elements.orderByDescending(a => a.creationDate)[0]]));

                let timer: WorkflowEventEntity | null = null;
                for (const t of candidateEvents) {
                    const fireable = t.type === WorkflowEventType.BoundaryInterruptingTimer
                        || t.runRepeatedly || !lastByEvent.has(t.toLite().key());
                    if (!fireable)
                        continue;

                    if (t.timer!.duration != null) {
                        const startDate = lastByEvent.get(t.toLite().key())?.creationDate ?? ca.startDate;
                        if (Temporal.PlainDateTime.compare(t.timer!.duration.add(startDate), now) < 0) {
                            timer = t;
                            break;
                        }
                    }
                    else if (await WorkflowLogic.evaluateTimerCondition(t.timer!.condition!, ca, now)) {
                        timer = t;
                        break;
                    }
                }

                if (timer == null) {
                    // Evaluating a SPECIFIC timer by hand and finding none due is not an error.
                    if (specific == null)
                        throw new Error(WorkflowActivityMessage.NoActiveTimerFound.niceToString());
                    return;
                }

                switch (timer.type) {
                    case WorkflowEventType.BoundaryForkTimer:
                    case WorkflowEventType.BoundaryInterruptingTimer:
                        await executeBoundaryTimer(ca, timer);
                        break;
                    case WorkflowEventType.IntermediateTimer:
                        await executeStep(ca, DoneType.Timeout, null,
                            (await WorkflowLogic.nextConnectionsFromCache(timer, ConnectionType.Normal)).single());
                        break;
                    default:
                        throw new Error("Unexpected Timer Type " + Enum.niceName(WorkflowEventType, timer.type));
                }
            },
        });

        sm.withExecute(CaseActivityOperation.MarkAsUnread, {
            fromStates: [CaseActivityState.Pending],
            toStates: [CaseActivityState.Pending],
            execute: async ca => {
                const changed = await table(CaseNotificationEntity)
                    .filter(cn => cn.caseActivity.is(ca) && cn.isForMe()
                        && (cn.state === CaseNotificationState.InProgress
                            || cn.state === CaseNotificationState.Opened))
                    .executeUpdate(() => ({ state: CaseNotificationState.New }));

                if (changed === 0)
                    throw new Error(CaseActivityMessage.NoOpenedOrInProgressNotificationsFound.niceToString());
            },
        });

        sm.withExecute(CaseActivityOperation.Undo, {
            fromStates: [CaseActivityState.Done],
            toStates: [CaseActivityState.Pending],
            canExecute: ca => (ca.doneBy?.is(UserHolder.currentUserLite()) ?? false) ? null
                : CaseActivityMessage.Only0CanUndoThisOperation.niceToString(ca.doneBy),
            execute: async ca => {
                const nextActivities = await CaseQueries.nextActivities(ca).toArray();
                for (const na of nextActivities)
                    if (!await isFreshNew(na))
                        throw new Error(CaseActivityMessage.NextActivityAlreadyInProgress.niceToString());

                if (ca.case.parentCase != null) {
                    const surrogate = await CaseQueries.decompositionSurrogateActivity(ca.case);
                    for (const na of await CaseQueries.nextActivities(surrogate).toArray())
                        if (!await isFreshNew(na))
                            throw new Error(CaseActivityMessage
                                .NextActivityOfDecompositionSurrogateAlreadyInProgress.niceToString());
                }

                await table(CaseNotificationEntity)
                    .filter(n => n.caseActivity.entity.previous!.is(ca)).executeDelete();

                const cases = nextActivities.map(a => a.case).filter(c => !c.is(ca.case)).distinctBy(c => String(c.id));
                await table(CaseActivityEntity).filter(a => a.previous!.is(ca)).executeDelete();

                // A decomposition's subcases, now childless, go too.
                for (const c of cases)
                    if (!await CaseQueries.caseActivities(c).some())
                        await c.delete();

                // A recomposition must be undone on the PARENT side as well.
                if (ca.case.parentCase != null && ca.case.finishDate != null) {
                    const surrogate = await CaseQueries.decompositionSurrogateActivity(ca.case);
                    await table(CaseNotificationEntity)
                        .filter(n => n.caseActivity.entity.previous!.is(surrogate)).executeDelete();
                    await table(CaseActivityEntity).filter(a => a.previous!.is(surrogate)).executeDelete();

                    surrogate.doneBy = null;
                    surrogate.doneDate = null;
                    surrogate.doneType = null;
                    surrogate.case.finishDate = null;
                    await surrogate.save();
                }

                ca.doneBy = null;
                ca.doneDate = null;
                ca.doneType = null;
                ca.case.finishDate = null;
                await table(CaseNotificationEntity).filter(n => n.caseActivity.is(ca))
                    .executeUpdate(() => ({ state: CaseNotificationState.New }));
            },
        });

        sm.withExecute(CaseActivityOperation.ResetToCaseActivity, {
            fromStates: [CaseActivityState.Done],
            toStates: [CaseActivityState.Done, CaseActivityState.Pending],
            execute: async ca => {
                const caseEntity = ca.case;

                // Everything that FOLLOWS the target inside THIS case must be undone. The walk stays in
                // the same case: a subcase's first activity points back (through `previous`) at a
                // decomposition surrogate here, so staying inside `case` never touches a subcase.
                // Keyed by ID, not by object: each `nextActivities` call is its own retrieval, so the
                // same row can come back as two instances and an identity Set would loop.
                const following = new Map<string, CaseActivityEntity>();
                const queue = await CaseQueries.nextActivities(ca).filter(a => a.case.is(caseEntity)).toArray();
                while (queue.length > 0) {
                    const cur = queue.shift()!;
                    if (!following.has(String(cur.id))) {
                        following.set(String(cur.id), cur);
                        queue.push(...await CaseQueries.nextActivities(cur).filter(a => a.case.is(caseEntity)).toArray());
                    }
                }

                const followingIds = new Set(following.keys());

                // Resetting to BEFORE a decomposition that already spawned subcases is not supported.
                const subCases = await CaseQueries.subCases(caseEntity).toArray();
                for (const sc of subCases) {
                    const surrogate = await CaseQueries.decompositionSurrogateActivity(sc);
                    if (followingIds.has(String(surrogate.id)))
                        throw new Error(CaseActivityMessage
                            .ResetToCaseActivityIsNotSupportedForDecomposedCases.niceToString());
                }

                const isDecomposition = ca.workflowActivity instanceof WorkflowActivityEntity
                    && (ca.workflowActivity.type === WorkflowActivityType.DecompositionWorkflow
                        || ca.workflowActivity.type === WorkflowActivityType.CallWorkflow);

                if (isDecomposition) {
                    // Only makes sense while a subcase is still open — finishing it is what recomposes.
                    const subcasesOpen = await table(CaseActivityEntity)
                        .filter(a => a.previous!.is(ca) && !a.case.is(caseEntity))
                        .map(a => a.case)
                        .some(c => c.finishDate == null);

                    if (!subcasesOpen)
                        throw new Error(CaseActivityMessage.ResetToCaseActivityRequiresAnOpenSubCase.niceToString());
                }

                if (following.size > 0) {
                    const ids = [...following.values()].map(a => a.id!);
                    await table(CaseNotificationEntity)
                        .filter(n => ids.includes(n.caseActivity.id!)).executeDelete();
                    await table(CaseActivityEntity).filter(a => ids.includes(a.id!)).executeDelete();
                }

                caseEntity.finishDate = null;
                await caseEntity.save();

                ca.doneBy = null;
                ca.doneDate = null;
                ca.doneType = null;
                ca.doneDecision = null;
                await ca.save();

                if (!isDecomposition)
                    await insertCaseActivityNotifications(ca);
            },
        });

        sm.withDelete(CaseActivityOperation.Delete, {
            fromStates: [CaseActivityState.Pending],
            canDelete: ca => ca.case.parentCase != null
                ? CaseActivityMessage.CaseIsADecompositionOf0.niceToString(ca.case.parentCase) : null,
            delete: async (ca, args) => {
                const c = ca.case;
                if (await CaseQueries.caseActivities(c).some(a => !a.is(ca)))
                    throw new Error(CaseActivityMessage.CaseContainsOtherActivities.niceToString());

                await table(CaseNotificationEntity).filter(n => n.caseActivity.is(ca)).executeDelete();
                await ca.delete();
                await c.delete();
                if (args[0] === true)
                    await (c.mainEntity as Entity).delete();
            },
        });

        sm.withExecute(CaseActivityOperation.ScriptExecute, {
            canExecute: s => s.workflowActivity instanceof WorkflowActivityEntity
                && s.workflowActivity.type === WorkflowActivityType.Script ? null
                : CaseActivityMessage.OnlyForScriptWorkflowActivities.niceToString(),
            fromStates: [CaseActivityState.Pending],
            toStates: [CaseActivityState.Done],
            execute: async ca => {
                await WorkflowActivityInfo.withScope({ caseActivity: ca }, async () => {
                    const part = (ca.workflowActivity as WorkflowActivityEntity).script!;

                    if (ca.scriptExecution == null)
                        ca.scriptExecution = getScriptExecution(ca.workflowActivity);

                    await WorkflowLogic.executeScript(part.script, ca.case.mainEntity,
                        new WorkflowScriptContext(ca, ca.scriptExecution!.retryCount));
                });

                await executeStep(ca, DoneType.ScriptSuccess, null, null);
            },
        });

        sm.withExecute(CaseActivityOperation.ScriptScheduleRetry, {
            canExecute: s => s.workflowActivity instanceof WorkflowActivityEntity
                && s.workflowActivity.type === WorkflowActivityType.Script ? null
                : CaseActivityMessage.OnlyForScriptWorkflowActivities.niceToString(),
            fromStates: [CaseActivityState.Pending],
            toStates: [CaseActivityState.Pending],
            execute: async (ca, args) => {
                const se = ca.scriptExecution!;
                se.retryCount = (se.retryCount + 1) as typeof se.retryCount;
                se.nextExecution = args[0] as Temporal.PlainDateTime;
                se.processIdentifier = null;
            },
        });

        sm.withExecute(CaseActivityOperation.ScriptFailureJump, {
            canExecute: s => s.workflowActivity instanceof WorkflowActivityEntity
                && s.workflowActivity.type === WorkflowActivityType.Script ? null
                : CaseActivityMessage.OnlyForScriptWorkflowActivities.niceToString(),
            fromStates: [CaseActivityState.Pending],
            toStates: [CaseActivityState.Done],
            execute: async ca => {
                await executeStep(ca, DoneType.ScriptFailure, null,
                    (await WorkflowLogic.nextConnectionsFromCache(ca.workflowActivity, ConnectionType.ScriptException)).single());
            },
        });
    }
}

// ---- FluentInclude wiring -------------------------------------------------------------------------------

FluentInclude.prototype.withWorkflow = function <T extends Entity>(this: FluentInclude<T>, options: WorkflowOptions<T>): FluentInclude<T> {
    CaseActivityLogic.registerMainEntity(this as never, options as never);
    return this;
};

FluentInclude.prototype.withCaseActivityMixin = function <T extends Entity>(this: FluentInclude<T>): FluentInclude<T> {
    CaseActivityMixin.declareOn(this.type as never);
    // Signum stamps the mixin in its CONSTRUCTOR from the ambient activity; altea's mixin field initializers
    // only run in `create()`, and the ambient activity is a server concept, so the stamping is a preSaving
    // hook on the owner: whatever an activity produces gets tagged with it.
    this.schemaBuilder.schema.entityEvents(this.type).preSaving.push(entity => {
            const mixin = (entity as Entity).mixin(CaseActivityMixin as never) as unknown as CaseActivityMixin;
            if (mixin.caseActivity == null)
                mixin.caseActivity = WorkflowActivityInfo.current().caseActivity?.toLite() ?? null;
        });
    return this;
};

// ---- Small helpers ------------------------------------------------------------------------------------

/** Signum's `string.Etc(100)` — truncate with an ellipsis. */
function etc(text: string, max: number): string {
    return text.length <= max ? text : text.substring(0, max - 3) + "...";
}

function cleanNameOf(ctor: Function): string {
    return ctor.name.replace(/Entity$/, "");
}

function distinctLites<T extends Lite<Entity>>(lites: T[]): T[] {
    return lites.distinctBy(a => a.key());
}