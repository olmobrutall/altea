import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery / withExpressionFrom
import "@altea/altea/data/globals/arrayExtensions";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import type { IQuery } from "@altea/altea/data/iquery";
import { graph } from "@altea/altea/server/graphBuilder";
import { Operations } from "@altea/altea/server/operationLogic";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { ObjectDumper } from "@altea/altea/data/objectDumper";
import { withQuoted } from "@altea/altea/data/decorators";
import { Enum } from "@altea/altea/data/enum";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { UserHolder } from "@altea/altea/server/userHolder";
import { ValidationMessage } from "@altea/altea/data/validators";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { UserAssetLogic } from "@altea/altea-user-assets/server/UserAssetLogic.server";
import { EvalLogic } from "@altea/altea-eval/server/EvalLogic.server"; // + FluentInclude.withEvals
import {
    WorkflowEntity, WorkflowIssueType, WorkflowMessage, WorkflowOperation, WorkflowPermission,
    WorkflowXmlEmbedded, WorkflowMainEntityStrategy, WorkflowModel, WorkflowReplacementModel,
    WorkflowConfigurationEmbedded, type IWorkflowNodeEntity,
} from "../data/Workflow";
import {
    ConnectionType, WorkflowActivityEntity, WorkflowActivityOperation, WorkflowConnectionEntity,
    WorkflowConnectionOperation, WorkflowEventEntity, WorkflowEventOperation, WorkflowEventType,
    WorkflowGatewayEntity, WorkflowGatewayOperation, WorkflowLaneEntity, WorkflowLaneOperation,
    WorkflowGatewayDirection, WorkflowPoolEntity, WorkflowPoolOperation, isScheduledStart, isTimer,
} from "../data/WorkflowNodes";
import { WorkflowConditionEntity, WorkflowConditionEval, WorkflowConditionOperation } from "../data/WorkflowCondition";
import { WorkflowActionEntity, WorkflowActionEval, WorkflowActionOperation } from "../data/WorkflowAction";
import { WorkflowTimerConditionEntity, WorkflowTimerConditionEval, WorkflowTimerConditionOperation } from "../data/WorkflowTimerCondition";
import {
    WorkflowScriptEntity, WorkflowScriptEval, WorkflowScriptOperation, WorkflowScriptRetryStrategyEntity,
    WorkflowScriptRetryStrategyOperation,
} from "../data/WorkflowScript";
import { WorkflowTransitionContext, WorkflowScriptContext } from "../data/WorkflowEval";
import type { SubEntitiesEval, WorkflowLaneActorsEval } from "../data/WorkflowNodes";
import type { WorkflowEventTaskActionEval, WorkflowEventTaskConditionEval } from "../data/WorkflowEventTask";
import type { ICaseMainEntity } from "../data/Case";
import { CaseActivityEntity, CaseActivityMessage } from "../data/CaseActivity";
import type { WorkflowIssue } from "../data/WorkflowDtos";
import { WorkflowNodeGraph, hasExpired, issueToString } from "./WorkflowNodeGraph.server";
import { WorkflowBuilder } from "./WorkflowBuilder.server";
import { registerWorkflowXml } from "./WorkflowXml.server";

// Port of Signum.Workflow's WorkflowLogic.cs — the module's registration: the workflow-definition tables and
// their operations, the in-memory WorkflowNodeGraph cache, and the EIGHT evaluator registries that replace
// Signum's Roslyn evals (see data/WorkflowEval.ts).
//
// altea divergences beyond the module-wide ones:
//  - Signum's `[AutoExpressionField]` extension methods become `withQuoted` prototype members declared here
//    (the logic layer), the shape altea's MusicLogic established: the bodies need `table(...)`, which the
//    isomorphic layer must not import.
//  - `PropertyRouteTranslationLogic.RegisterRoute` (instance translation of a workflow / activity name) has
//    no altea counterpart yet, as in the toolbar and dashboard ports.
//  - `EvalLogic.GetCustomErrors` / `EvalLogic.OnInvalidated` go with the Eval deferral.
//  - `AuthLogic.HasRuleOverridesEvent` (does this role appear as a lane actor?) has no altea hook yet.
//  - Signum's `.WithQuery(() => e => new { … })` becomes a parameterless `withQuery()`: altea derives the
//    columns from the entity and the CLIENT chooses the default ones (`withQuerySettings`).
//  - the CACHES are arrays / Maps keyed by the lite's key string — a Lite is not a value key in JS.

// ---- Extension expressions (Signum's [AutoExpressionField] statics) -------------------------------------

declare module "../data/Workflow" {
    interface WorkflowEntity {
        /** Signum's `HasExpired()`. */
        hasExpired(): boolean;
        workflowPools(): IQuery<WorkflowPoolEntity>;
        workflowActivities(): IQuery<WorkflowActivityEntity>;
        workflowEvents(): IQuery<WorkflowEventEntity>;
        workflowGateways(): IQuery<WorkflowGatewayEntity>;
        workflowStartEvent(): Promise<WorkflowEventEntity | null>;
        workflowConnections(): IQuery<WorkflowConnectionEntity>;
        /** The connections that CROSS two pools (Signum's WorkflowMessageConnections). */
        workflowMessageConnections(): IQuery<WorkflowConnectionEntity>;
    }
}

declare module "../data/WorkflowNodes" {
    interface WorkflowPoolEntity {
        workflowLanes(): IQuery<WorkflowLaneEntity>;
        workflowConnections(): IQuery<WorkflowConnectionEntity>;
    }
    interface WorkflowLaneEntity {
        workflowActivities(): IQuery<WorkflowActivityEntity>;
        workflowEvents(): IQuery<WorkflowEventEntity>;
        workflowGateways(): IQuery<WorkflowGatewayEntity>;
    }
    interface WorkflowActivityEntity {
        nextConnections(): IQuery<WorkflowConnectionEntity>;
        previousConnections(): IQuery<WorkflowConnectionEntity>;
    }
    interface WorkflowEventEntity {
        nextConnections(): IQuery<WorkflowConnectionEntity>;
        previousConnections(): IQuery<WorkflowConnectionEntity>;
    }
    interface WorkflowGatewayEntity {
        nextConnections(): IQuery<WorkflowConnectionEntity>;
        previousConnections(): IQuery<WorkflowConnectionEntity>;
    }
}

WorkflowEntity.prototype.hasExpired = withQuoted(function (this: WorkflowEntity): boolean {
    return this.expirationDate != null && Temporal.PlainDateTime.compare(this.expirationDate, Clock.now) < 0;
});

WorkflowEntity.prototype.workflowPools = withQuoted(function (this: WorkflowEntity): IQuery<WorkflowPoolEntity> {
    return table(WorkflowPoolEntity).filter(a => a.workflow.is(this));
});

WorkflowEntity.prototype.workflowActivities = withQuoted(function (this: WorkflowEntity): IQuery<WorkflowActivityEntity> {
    return table(WorkflowActivityEntity).filter(a => a.lane.pool.workflow.is(this));
});

WorkflowEntity.prototype.workflowEvents = withQuoted(function (this: WorkflowEntity): IQuery<WorkflowEventEntity> {
    return table(WorkflowEventEntity).filter(a => a.lane.pool.workflow.is(this));
});

WorkflowEntity.prototype.workflowGateways = withQuoted(function (this: WorkflowEntity): IQuery<WorkflowGatewayEntity> {
    return table(WorkflowGatewayEntity).filter(a => a.lane.pool.workflow.is(this));
});

WorkflowEntity.prototype.workflowStartEvent = withQuoted(function (this: WorkflowEntity): Promise<WorkflowEventEntity | null> {
    return this.workflowEvents().singleOrNull(we => we.type === WorkflowEventType.Start);
});

WorkflowEntity.prototype.workflowConnections = withQuoted(function (this: WorkflowEntity): IQuery<WorkflowConnectionEntity> {
    return table(WorkflowConnectionEntity)
        .filter(a => a.from.lane.pool.workflow.is(this) && a.to.lane.pool.workflow.is(this));
});

WorkflowEntity.prototype.workflowMessageConnections = withQuoted(function (this: WorkflowEntity): IQuery<WorkflowConnectionEntity> {
    return this.workflowConnections().filter(a => !a.from.lane.pool.is(a.to.lane.pool));
});

WorkflowPoolEntity.prototype.workflowLanes = withQuoted(function (this: WorkflowPoolEntity): IQuery<WorkflowLaneEntity> {
    return table(WorkflowLaneEntity).filter(a => a.pool.is(this));
});

WorkflowPoolEntity.prototype.workflowConnections = withQuoted(function (this: WorkflowPoolEntity): IQuery<WorkflowConnectionEntity> {
    return table(WorkflowConnectionEntity).filter(a => a.from.lane.pool.is(this) && a.to.lane.pool.is(this));
});

WorkflowLaneEntity.prototype.workflowActivities = withQuoted(function (this: WorkflowLaneEntity): IQuery<WorkflowActivityEntity> {
    return table(WorkflowActivityEntity).filter(a => a.lane.is(this));
});

WorkflowLaneEntity.prototype.workflowEvents = withQuoted(function (this: WorkflowLaneEntity): IQuery<WorkflowEventEntity> {
    return table(WorkflowEventEntity).filter(a => a.lane.is(this));
});

WorkflowLaneEntity.prototype.workflowGateways = withQuoted(function (this: WorkflowLaneEntity): IQuery<WorkflowGatewayEntity> {
    return table(WorkflowGatewayEntity).filter(a => a.lane.is(this));
});

// Signum registers ONE pair of expressions on the INTERFACE (`(IWorkflowNodeEntity p) => p.NextConnections()`);
// altea's extension tokens walk the concrete prototype chain, so each of the three node types gets its own
// (the same accommodation MusicLogic makes for IAuthorEntity.Albums).
WorkflowActivityEntity.prototype.nextConnections = withQuoted(function (this: WorkflowActivityEntity): IQuery<WorkflowConnectionEntity> {
    return table(WorkflowConnectionEntity).filter(a => a.from.is(this));
});
WorkflowActivityEntity.prototype.previousConnections = withQuoted(function (this: WorkflowActivityEntity): IQuery<WorkflowConnectionEntity> {
    return table(WorkflowConnectionEntity).filter(a => a.to.is(this));
});
WorkflowEventEntity.prototype.nextConnections = withQuoted(function (this: WorkflowEventEntity): IQuery<WorkflowConnectionEntity> {
    return table(WorkflowConnectionEntity).filter(a => a.from.is(this));
});
WorkflowEventEntity.prototype.previousConnections = withQuoted(function (this: WorkflowEventEntity): IQuery<WorkflowConnectionEntity> {
    return table(WorkflowConnectionEntity).filter(a => a.to.is(this));
});
WorkflowGatewayEntity.prototype.nextConnections = withQuoted(function (this: WorkflowGatewayEntity): IQuery<WorkflowConnectionEntity> {
    return table(WorkflowConnectionEntity).filter(a => a.from.is(this));
});
WorkflowGatewayEntity.prototype.previousConnections = withQuoted(function (this: WorkflowGatewayEntity): IQuery<WorkflowConnectionEntity> {
    return table(WorkflowConnectionEntity).filter(a => a.to.is(this));
});

// ---- The logic ------------------------------------------------------------------------------------------

export namespace WorkflowLogic {

    /** Signum's `Action<ICaseMainEntity, WorkflowTransitionContext>? OnTransition` — an app-wide hook run on
     *  every connection taken, before the connection's own action. */
    export const onTransition: ((mainEntity: ICaseMainEntity, ctx: WorkflowTransitionContext) => void | Promise<void>)[] = [];

    /** Signum's `ResetLazy<FrozenDictionary<Lite<WorkflowEntity>, WorkflowEntity>> Workflows`. */
    export let workflows: ResetLazy<WorkflowEntity[]> = null!;

    /** Signum's `WorkflowGraphLazy` — one WorkflowNodeGraph per workflow, keyed by the lite's key. */
    export let workflowGraphLazy: ResetLazy<Map<string, WorkflowNodeGraph>> = null!;

    export let conditions: ResetLazy<Map<string, WorkflowConditionEntity>> = null!;
    export let actions: ResetLazy<Map<string, WorkflowActionEntity>> = null!;
    export let timerConditions: ResetLazy<Map<string, WorkflowTimerConditionEntity>> = null!;
    export let scripts: ResetLazy<Map<string, WorkflowScriptEntity>> = null!;

    let getConfiguration: () => WorkflowConfigurationEmbedded = null!;

    export function configuration(): WorkflowConfigurationEmbedded {
        return getConfiguration();
    }

    // ---- Evaluating the eight evals (Signum's `wc.Evaluate(...)` / `wa.Execute(...)` extensions) -----
    //
    // A NAMED eval (condition / action / timer condition / script) is reached through its cached entity, so
    // the compiled algorithm is shared by every case that uses it; an INLINE one (lane actors, sub-entities,
    // the event task's two) is called straight off the eval the caller already holds. Either way the
    // `algorithm` getter compiles on first use and throws with the diagnostics if the script does not build
    // (see @altea/altea-eval's data/Eval.ts).

    /** Signum's `Lite<WorkflowConditionEntity>.Evaluate(mainEntity, ctx)`. */
    export async function evaluateCondition(wc: Lite<WorkflowConditionEntity>, mainEntity: ICaseMainEntity,
        ctx: WorkflowTransitionContext): Promise<boolean> {
        const entity = mapGet(await conditions.value(), wc.key(), "WorkflowCondition");
        using _prof = HeavyProfiler.log("WorkflowCondition", () => entity.name);
        return await entity.eval.algorithm(mainEntity, ctx);
    }

    /** Signum's `Lite<WorkflowActionEntity>.Execute(mainEntity, ctx)`. */
    export async function executeAction(wa: Lite<WorkflowActionEntity>, mainEntity: ICaseMainEntity,
        ctx: WorkflowTransitionContext): Promise<void> {
        const entity = mapGet(await actions.value(), wa.key(), "WorkflowAction");
        using _prof = HeavyProfiler.log("WorkflowAction", () => entity.name);
        await entity.eval.algorithm(mainEntity, ctx);
    }

    /** Signum's `Lite<WorkflowTimerConditionEntity>.Evaluate(ca, now)`. */
    export async function evaluateTimerCondition(wc: Lite<WorkflowTimerConditionEntity>, ca: CaseActivityEntity,
        now: Temporal.PlainDateTime): Promise<boolean> {
        const entity = mapGet(await timerConditions.value(), wc.key(), "WorkflowTimerCondition");
        using _prof = HeavyProfiler.log("WorkflowTimerCondition", () => entity.name);
        // Signum's generated wrapper takes (ca, e, now) — the main entity is handed over already cast.
        return await entity.eval.algorithm(ca, ca.case.mainEntity, now);
    }

    /** Signum's `script.Eval.Algorithm.ExecuteUntyped(mainEntity, ctx)`. */
    export async function executeScript(ws: Lite<WorkflowScriptEntity>, mainEntity: ICaseMainEntity,
        ctx: WorkflowScriptContext): Promise<void> {
        const entity = mapGet(await scripts.value(), ws.key(), "WorkflowScript");
        using _prof = HeavyProfiler.log("WorkflowScript", () => entity.name);
        await entity.eval.algorithm(mainEntity, ctx);
    }

    export async function evaluateLaneActors(actorsEval: WorkflowLaneActorsEval,
        mainEntity: ICaseMainEntity | null, ctx: WorkflowTransitionContext): Promise<Lite<Entity>[]> {
        return await actorsEval.algorithm(mainEntity, ctx);
    }

    export async function evaluateSubEntities(subEntitiesEval: SubEntitiesEval, mainEntity: ICaseMainEntity,
        ctx: WorkflowTransitionContext): Promise<ICaseMainEntity[]> {
        return await subEntitiesEval.algorithm(mainEntity, ctx);
    }

    export async function evaluateEventTaskCondition(condition: WorkflowEventTaskConditionEval): Promise<boolean> {
        return await condition.algorithm();
    }

    export async function evaluateEventTaskAction(action: WorkflowEventTaskActionEval): Promise<ICaseMainEntity[]> {
        return await action.algorithm();
    }

    // ---- The graph cache ---------------------------------------------------------------------------

    /**
     * Signum's GetWorkflowNodeGraph — the cached graph, VALIDATED on first use. A workflow with errors is
     * unusable, so this throws rather than handing back a half-analysed graph (the track ids the engine
     * needs are only filled by a clean validation).
     */
    export async function getWorkflowNodeGraph(workflow: Lite<WorkflowEntity>): Promise<WorkflowNodeGraph> {
        const graphs = await workflowGraphLazy.value();
        const g = mapGet(graphs, workflow.key(), "Workflow");
        if (g.trackId != null)
            return g;

        const issues: WorkflowIssue[] = [];
        await g.validate(issues, (gateway, newDirection) => {
            throw new Error(`Unexpected direction of gateway '${gateway}' (should be `
                + `'${Enum.niceName(WorkflowGatewayDirection, newDirection)}'). `
                + `Consider saving Workflow '${workflow}'.`);
        }, e => scheduledStartInfo(e));

        const errors = issues.filter(a => a.type === WorkflowIssueType.Error);
        if (errors.length > 0)
            throw new Error(`Errors in Workflow '${workflow}':\n` + errors.map(e => "    " + issueToString(e)).join("\n"));

        return g;
    }

    /** How `validate` learns about a Scheduled Start's scheduler side; set by WorkflowEventTaskLogic so this
     *  module needs no scheduler import (and so a host without the scheduler still validates). */
    export let scheduledStartInfo: (e: WorkflowEventEntity) =>
        Promise<{ hasSchedule: boolean; hasTask: boolean; conditionMissing: boolean }> =
        async () => ({ hasSchedule: true, hasTask: true, conditionMissing: false });

    /** Signum's AutocompleteNodes — the jump targets the client offers. */
    export async function autocompleteNodes(workflow: Lite<WorkflowEntity>, subString: string, count: number,
        excludes: Lite<IWorkflowNodeEntity>[]): Promise<Lite<IWorkflowNodeEntity>[]> {
        const graphs = await workflowGraphLazy.value();
        return mapGet(graphs, workflow.key(), "Workflow").autocomplete(subString, count, excludes);
    }

    /** Signum's `NextConnectionsFromCache(type)` — the cached counterpart of the DB expression. */
    export async function nextConnectionsFromCache(node: IWorkflowNodeEntity, type: ConnectionType | null): Promise<WorkflowConnectionEntity[]> {
        const g = await getWorkflowNodeGraph(node.lane.pool.workflow.toLite());
        const result = g.nextConnections(node);
        return type == null ? result : result.filter(a => a.type === type);
    }

    export async function previousConnectionsFromCache(node: IWorkflowNodeEntity): Promise<WorkflowConnectionEntity[]> {
        const g = await getWorkflowNodeGraph(node.lane.pool.workflow.toLite());
        return g.previousConnections(node);
    }

    // ---- Actors -----------------------------------------------------------------------------------

    /**
     * Signum's `IsCurrentUserActor` — is this actor (a user or a role) the current user? Async because
     * altea's role expansion is; overridable, as in Signum (a deputy scenario replaces it).
     */
    export let isCurrentUserActor: (actor: Lite<Entity>) => Promise<boolean> = async actor => {
        const current = UserHolder.currentUserLite();
        if (current != null && actor.is(current))
            return true;

        if (actor.entityType === RoleEntity)
            return AuthLogic.currentRoles().some(r => r.is(actor as Lite<RoleEntity>));

        return false;
    };

    /** Signum's `GetAllowedStarts` — the workflows the current user may open a case of. */
    export async function getAllowedStarts(getActors: (lane: WorkflowLaneEntity) => Promise<Lite<Entity>[]>): Promise<WorkflowEntity[]> {
        const graphs = await workflowGraphLazy.value();
        const result: WorkflowEntity[] = [];
        for (const g of graphs.values())
            if (await g.isStartCurrentUser(isCurrentUserActor as never, getActors as never))
                result.push(g.workflow);
        return result;
    }

    /** Signum's `CurrentUserInLaneOf<T>()` — does the current user appear in any lane of a workflow over T? */
    export async function currentUserInLaneOf(mainEntityTypeName: string): Promise<boolean> {
        const graphs = await workflowGraphLazy.value();
        const current = UserHolder.currentUserLite();
        if (current == null)
            return false;

        for (const g of graphs.values()) {
            if (g.workflow.mainEntityType.cleanName !== mainEntityTypeName)
                continue;
            for (const lane of g.lanes)
                if (lane.actors.some(a => a.actor.is(current)))
                    return true;
        }
        return false;
    }

    // ---- start ------------------------------------------------------------------------------------

    export function start(sb: SchemaBuilder, getConfig: () => WorkflowConfigurationEmbedded): void {
        if (sb.alreadyDefined(start))
            return;

        getConfiguration = getConfig;

        // Reaching a PermissionSymbol declared with init() is enough — PermissionAuthLogic seeds the table.
        void WorkflowPermission.ViewWorkflowPanel;
        void WorkflowPermission.ViewCaseFlow;
        void WorkflowPermission.WorkflowToolbarMenu;

        // The shared user-asset infrastructure (the permission + the import/export HTTP surface).
        UserAssetLogic.start(sb);

        // The redundant full-diagram copy is only for the diff log to compare — never worth dumping.
        ObjectDumper.avoidDump.add("WorkflowEntity.fullDiagramXml");
        for (const t of ["WorkflowPoolEntity", "WorkflowLaneEntity", "WorkflowActivityEntity",
            "WorkflowEventEntity", "WorkflowGatewayEntity", "WorkflowConnectionEntity"])
            ObjectDumper.avoidDump.add(t + ".xml");

        // ---- The workflow itself ------------------------------------------------------------------

        sb.include(WorkflowEntity)
            .withExpressionFrom(CaseActivityEntity, ca => ca.workflow())
            .withQuery();

        // Signum's `WorkflowEventEntity.PreSaving` override — clear the two fields that only make sense for
        // one event type. altea's hook is a schema EVENT, not an entity method (an entity `preSaving()` would
        // never run), so it is registered here beside the type's other server-side wiring.
        sb.schema.entityEvents(WorkflowEventEntity).preSaving.push(e => {
            if (e.type !== WorkflowEventType.BoundaryForkTimer && e.runRepeatedly)
                e.runRepeatedly = false;

            if (e.type !== WorkflowEventType.BoundaryInterruptingTimer
                && (e.decisionOptionName ?? "").trim() !== "")
                e.decisionOptionName = null;
        });

        registerWorkflowGraph();
        QueryLogic.expressions.register(WorkflowEntity, (wf: WorkflowEntity) => wf.workflowStartEvent());
        QueryLogic.expressions.register(WorkflowEntity, (wf: WorkflowEntity) => wf.hasExpired(),
            { niceName: () => WorkflowMessage.HasExpired.niceToString() });

        workflows = sb.globalLazy(async () => await table(WorkflowEntity).toArray(),
            { invalidateWith: [WorkflowEntity] });

        sb.include(WorkflowPoolEntity)
            .withSave(WorkflowPoolOperation.Save)
            .withDelete(WorkflowPoolOperation.Delete)
            .withExpressionFrom(WorkflowEntity, p => p.workflowPools())
            .withQuery();

        sb.include(WorkflowLaneEntity)
            .withEvals()
            .withSave(WorkflowLaneOperation.Save)
            .withDelete(WorkflowLaneOperation.Delete)
            .withExpressionFrom(WorkflowPoolEntity, p => p.workflowLanes())
            .withQuery();

        sb.include(WorkflowActivityEntity)
            .withEvals()
            .withSave(WorkflowActivityOperation.Save)
            .withDelete(WorkflowActivityOperation.Delete)
            .withExpressionFrom(WorkflowEntity, p => p.workflowActivities())
            .withExpressionFrom(WorkflowLaneEntity, p => p.workflowActivities())
            .withQuery();

        // Signum's WorkflowEventOperation.Save/Delete are hand-written (they check the timer/boundary
        // invariants and clean up a scheduled task), so they are a graph rather than withSave/withDelete.
        sb.include(WorkflowEventEntity)
            .withExpressionFrom(WorkflowEntity, p => p.workflowEvents())
            .withExpressionFrom(WorkflowLaneEntity, p => p.workflowEvents())
            .withQuery();

        registerWorkflowEventGraph();

        sb.include(WorkflowGatewayEntity)
            .withSave(WorkflowGatewayOperation.Save)
            .withDelete(WorkflowGatewayOperation.Delete)
            .withExpressionFrom(WorkflowEntity, p => p.workflowGateways())
            .withExpressionFrom(WorkflowLaneEntity, p => p.workflowGateways())
            .withQuery();

        sb.include(WorkflowConnectionEntity)
            .withSave(WorkflowConnectionOperation.Save)
            .withDelete(WorkflowConnectionOperation.Delete)
            .withExpressionFrom(WorkflowEntity, p => p.workflowConnections())
            .withExpressionFrom(WorkflowPoolEntity, p => p.workflowConnections())
            .withExpressionFrom(WorkflowActivityEntity, p => p.nextConnections())
            .withExpressionFrom(WorkflowEventEntity, p => p.nextConnections())
            .withExpressionFrom(WorkflowGatewayEntity, p => p.nextConnections())
            .withQuery();

        // Signum's WorkflowGraphLazy: EVERY node of EVERY workflow in one pass, grouped per workflow.
        workflowGraphLazy = sb.globalLazy(async () => {
            const [allWorkflows, events, gateways, activities, connections, lanes] = await Promise.all([
                table(WorkflowEntity).toArray(),
                table(WorkflowEventEntity).toArray(),
                table(WorkflowGatewayEntity).toArray(),
                table(WorkflowActivityEntity).toArray(),
                table(WorkflowConnectionEntity).toArray(),
                table(WorkflowLaneEntity).toArray(),
            ]);

            // Signum's virtual MList fills `activity.BoundaryTimers` on retrieve; altea's list is not
            // persisted (see data/WorkflowNodes.ts), so the graph loader is what fills it.
            const activityByKey = new Map(activities.map(a => [a.toLite().key(), a]));
            for (const a of activities)
                a.boundaryTimers = [];
            for (const e of events)
                if (e.boundaryOf != null)
                    activityByKey.get(e.boundaryOf.key())?.boundaryTimers.push(e);

            const byWorkflow = <T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> => {
                const map = new Map<string, T[]>();
                for (const item of items) {
                    const key = keyOf(item);
                    (map.get(key) ?? map.set(key, []).get(key)!).push(item);
                }
                return map;
            };

            const eventsBy = byWorkflow(events, e => e.lane.pool.workflow.toLite().key());
            const gatewaysBy = byWorkflow(gateways, g => g.lane.pool.workflow.toLite().key());
            const activitiesBy = byWorkflow(activities, a => a.lane.pool.workflow.toLite().key());
            const connectionsBy = byWorkflow(connections, c => c.from.lane.pool.workflow.toLite().key());
            const lanesBy = byWorkflow(lanes, l => l.pool.workflow.toLite().key());

            const result = new Map<string, WorkflowNodeGraph>();
            for (const workflow of allWorkflows) {
                const w = workflow.toLite().key();
                const nodeGraph = new WorkflowNodeGraph();
                nodeGraph.workflow = workflow;
                nodeGraph.events = new Map((eventsBy.get(w) ?? []).map(e => [e.toLite().key(), e]));
                nodeGraph.gateways = new Map((gatewaysBy.get(w) ?? []).map(g => [g.toLite().key(), g]));
                nodeGraph.activities = new Map((activitiesBy.get(w) ?? []).map(a => [a.toLite().key(), a]));
                nodeGraph.connections = new Map((connectionsBy.get(w) ?? []).map(c => [c.toLite().key(), c]));
                nodeGraph.lanes = lanesBy.get(w) ?? [];
                nodeGraph.fillGraphs();
                result.set(w, nodeGraph);
            }
            return result;
        }, { invalidateWith: [WorkflowConnectionEntity, WorkflowActivityEntity, WorkflowEventEntity, WorkflowGatewayEntity, WorkflowLaneEntity, WorkflowPoolEntity, WorkflowEntity] });

        startWorkflowConditions(sb);
        startWorkflowTimerConditions(sb);
        startWorkflowActions(sb);
        startWorkflowScript(sb);

        // The XML (de)serializers + which Save operation the importer runs, for all six asset types.
        registerWorkflowXml();
    }

    // ---- The four named-evaluator entities --------------------------------------------------------

    function startWorkflowConditions(sb: SchemaBuilder): void {
        sb.include(WorkflowConditionEntity).withQuery().withEvals();

        graph(WorkflowConditionEntity, g => {
            g.Execute(WorkflowConditionOperation.Save, {
                canBeNew: true,
                canBeModified: true,
                execute: async e => {
                    if (!e.isNew) {
                        const old = await table(WorkflowConditionEntity)
                            .filter(a => a.id === e.id).map(a => a.mainEntityType).singleOrNull();
                        if (old != null && !old.is(e.mainEntityType))
                            await throwConnectionErrorForConnections(
                                table(WorkflowConnectionEntity).filter(a => a.condition!.is(e)), e, "Save");
                    }
                },
            });

            g.Delete(WorkflowConditionOperation.Delete, {
                delete: async e => {
                    await throwConnectionErrorForConnections(
                        table(WorkflowConnectionEntity).filter(a => a.condition!.is(e)), e, "Delete");
                    await e.delete();
                },
            });

            g.ConstructFrom(WorkflowConditionOperation.Clone, {
                entityType: WorkflowConditionEntity,
                construct: e => WorkflowConditionEntity.create({
                    mainEntityType: e.mainEntityType,
                    // A part has ONE owner, so the clone gets its own copy of the script.
                    eval: WorkflowConditionEval.create({ script: e.eval.script }),
                }),
            });
        }).register();

        conditions = sb.globalLazy(async () => await keyedByLite(table(WorkflowConditionEntity)),
            { invalidateWith: [WorkflowConditionEntity] });
    }

    function startWorkflowActions(sb: SchemaBuilder): void {
        sb.include(WorkflowActionEntity).withQuery().withEvals();

        graph(WorkflowActionEntity, g => {
            g.Execute(WorkflowActionOperation.Save, {
                canBeNew: true,
                canBeModified: true,
                execute: async e => {
                    if (!e.isNew) {
                        const old = await table(WorkflowActionEntity)
                            .filter(a => a.id === e.id).map(a => a.mainEntityType).singleOrNull();
                        if (old != null && !old.is(e.mainEntityType))
                            await throwConnectionErrorForConnections(
                                table(WorkflowConnectionEntity).filter(a => a.action!.is(e)), e, "Save");
                    }
                },
            });

            g.Delete(WorkflowActionOperation.Delete, {
                delete: async e => {
                    await throwConnectionErrorForConnections(
                        table(WorkflowConnectionEntity).filter(a => a.action!.is(e)), e, "Delete");
                    await e.delete();
                },
            });

            g.ConstructFrom(WorkflowActionOperation.Clone, {
                entityType: WorkflowActionEntity,
                construct: e => WorkflowActionEntity.create({
                    mainEntityType: e.mainEntityType,
                    eval: WorkflowActionEval.create({ script: e.eval.script }),
                }),
            });
        }).register();

        actions = sb.globalLazy(async () => await keyedByLite(table(WorkflowActionEntity)),
            { invalidateWith: [WorkflowActionEntity] });
    }

    function startWorkflowTimerConditions(sb: SchemaBuilder): void {
        sb.include(WorkflowTimerConditionEntity).withQuery().withEvals();

        graph(WorkflowTimerConditionEntity, g => {
            g.Execute(WorkflowTimerConditionOperation.Save, {
                canBeNew: true,
                canBeModified: true,
                execute: async e => {
                    if (!e.isNew) {
                        const old = await table(WorkflowTimerConditionEntity)
                            .filter(a => a.id === e.id).map(a => a.mainEntityType).singleOrNull();
                        if (old != null && !old.is(e.mainEntityType))
                            await throwConnectionErrorForNodes(
                                table(WorkflowEventEntity).filter(a => a.timer!.condition!.is(e)), e, "Save",
                                WorkflowEventEntity);
                    }
                },
            });

            g.Delete(WorkflowTimerConditionOperation.Delete, {
                delete: async e => {
                    await throwConnectionErrorForNodes(
                        table(WorkflowEventEntity).filter(a => a.timer!.condition!.is(e)), e, "Delete",
                        WorkflowEventEntity);
                    await e.delete();
                },
            });

            g.ConstructFrom(WorkflowTimerConditionOperation.Clone, {
                entityType: WorkflowTimerConditionEntity,
                construct: e => WorkflowTimerConditionEntity.create({
                    mainEntityType: e.mainEntityType,
                    eval: WorkflowTimerConditionEval.create({ script: e.eval.script }),
                }),
            });
        }).register();

        timerConditions = sb.globalLazy(async () => await keyedByLite(table(WorkflowTimerConditionEntity)),
            { invalidateWith: [WorkflowTimerConditionEntity] });
    }

    function startWorkflowScript(sb: SchemaBuilder): void {
        sb.include(WorkflowScriptEntity).withQuery().withEvals();

        graph(WorkflowScriptEntity, g => {
            g.Execute(WorkflowScriptOperation.Save, {
                canBeNew: true,
                canBeModified: true,
                execute: async e => {
                    if (!e.isNew) {
                        const old = await table(WorkflowScriptEntity)
                            .filter(a => a.id === e.id).map(a => a.mainEntityType).singleOrNull();
                        if (old != null && !old.is(e.mainEntityType))
                            await throwConnectionErrorForNodes(
                                table(WorkflowActivityEntity).filter(a => a.script!.script.is(e)), e, "Save",
                                WorkflowActivityEntity);
                    }
                },
            });

            g.Delete(WorkflowScriptOperation.Delete, {
                delete: async e => {
                    await throwConnectionErrorForNodes(
                        table(WorkflowActivityEntity).filter(a => a.script!.script.is(e)), e, "Delete",
                        WorkflowActivityEntity);
                    await e.delete();
                },
            });

            g.ConstructFrom(WorkflowScriptOperation.Clone, {
                entityType: WorkflowScriptEntity,
                construct: e => WorkflowScriptEntity.create({
                    mainEntityType: e.mainEntityType,
                    eval: WorkflowScriptEval.create({ script: e.eval.script }),
                }),
            });
        }).register();

        scripts = sb.globalLazy(async () => await keyedByLite(table(WorkflowScriptEntity)),
            { invalidateWith: [WorkflowScriptEntity] });

        sb.include(WorkflowScriptRetryStrategyEntity)
            .withSave(WorkflowScriptRetryStrategyOperation.Save)
            .withDelete(WorkflowScriptRetryStrategyOperation.Delete)
            .withQuery();

        registerEvalSources();
    }

    /**
     * Signum's `EvalClient.Options.checkEvalFindOptions.Add(...)` calls in WorkflowClient.tsx — what the
     * "check every stored script" pass walks. altea keeps the registry on the server (see
     * EvalLogic.evalSources), so the two entries Signum has to express as a client FindOption with a filter
     * (`Lane.ActorsEval != null`, `Activity.SubWorkflow != null`) are a plain `.filter(...)` here.
     */
    function registerEvalSources(): void {
        EvalLogic.registerEvalSource(WorkflowConditionEntity.niceName(), () => table(WorkflowConditionEntity).toArray());
        EvalLogic.registerEvalSource(WorkflowActionEntity.niceName(), () => table(WorkflowActionEntity).toArray());
        EvalLogic.registerEvalSource(WorkflowTimerConditionEntity.niceName(), () => table(WorkflowTimerConditionEntity).toArray());
        EvalLogic.registerEvalSource(WorkflowScriptEntity.niceName(), () => table(WorkflowScriptEntity).toArray());
        EvalLogic.registerEvalSource(WorkflowLaneEntity.niceName(), async () =>
            (await table(WorkflowLaneEntity).toArray()).filter(l => l.actorsEval != null));
        EvalLogic.registerEvalSource(WorkflowActivityEntity.niceName(), async () =>
            (await table(WorkflowActivityEntity).toArray()).filter(a => a.subWorkflow != null));
    }

    async function keyedByLite<T extends Entity>(query: IQuery<T>): Promise<Map<string, T>> {
        const rows = await query.toArray();
        return new Map(rows.map(r => [r.toLite().key(), r]));
    }

    /** Signum's ThrowConnectionError(IQueryable<WorkflowConnectionEntity>, …). */
    async function throwConnectionErrorForConnections(query: IQuery<WorkflowConnectionEntity>,
        entity: Entity, operationName: string): Promise<void> {
        const errors = await query
            .map(a => ({ connection: a.toLite(), from: a.from.toLite(), to: a.to.toLite(), workflow: a.from.lane.pool.workflow.toLite() }))
            .toArray();
        if (errors.length === 0)
            return;

        const formatted = errors.groupBy(a => a.workflow.key())
            .map(gr => `    Workflow '${gr.elements[0].workflow}':\n`
                + gr.elements.map(a => `        Connection ${a.connection.id} (${a.connection}): ${a.from} -> ${a.to}`).join("\n"))
            .join("\n\n");

        throw new Error(`Impossible to ${operationName} '${entity}' because is used in some connections: \n` + formatted);
    }

    /** Signum's generic `ThrowConnectionError<T>(IQueryable<T>, …)` over nodes. */
    async function throwConnectionErrorForNodes<T extends WorkflowActivityEntity | WorkflowEventEntity>(
        query: IQuery<T>, entity: Entity, operationName: string,
        nodeType: typeof WorkflowActivityEntity | typeof WorkflowEventEntity): Promise<void> {
        const errors = await query
            .map(a => ({ node: a.toLite(), workflow: a.lane.pool.workflow.toLite() }))
            .toArray();
        if (errors.length === 0)
            return;

        const formatted = errors.groupBy(a => a.workflow.key())
            .map(gr => `    Workflow '${gr.elements[0].workflow}':\n`
                + gr.elements.map(a => `        ${nodeType.niceName()} ${a.node}`).join("\n"))
            .join("\n\n");

        throw new Error(`Impossible to ${operationName} '${entity}' because is used in some `
            + `${nodeType.nicePluralName()}: \n` + formatted);
    }

    // ---- The WorkflowEvent graph -------------------------------------------------------------------

    /** Set by WorkflowEventTaskLogic — how to drop the ScheduledTask behind a Scheduled Start event. */
    export let deleteScheduledTaskOf: (e: WorkflowEventEntity) => Promise<void> = async () => { };

    function registerWorkflowEventGraph(): void {
        graph(WorkflowEventEntity, g => {
            g.Execute(WorkflowEventOperation.Save, {
                canBeNew: true,
                canBeModified: true,
                execute: e => {
                    const timerName = WorkflowEventEntity.nicePropertyName(a => a.timer);
                    const boundaryName = WorkflowEventEntity.nicePropertyName(a => a.boundaryOf);
                    const typeName = WorkflowEventEntity.nicePropertyName(a => a.type);
                    const typeNice = Enum.niceName(WorkflowEventType, e.type);

                    if (e.timer == null && isTimer(e.type))
                        throw new Error(mandatoryWhen(timerName, typeName, typeNice));
                    if (e.timer != null && !isTimer(e.type))
                        throw new Error(nullWhen(timerName, typeName, typeNice));
                    if (e.boundaryOf == null && isBoundary(e.type))
                        throw new Error(mandatoryWhen(boundaryName, typeName, typeNice));
                    if (e.boundaryOf != null && !isBoundary(e.type))
                        throw new Error(nullWhen(boundaryName, typeName, typeNice));
                },
            });

            g.Delete(WorkflowEventOperation.Delete, {
                delete: async e => {
                    if (isScheduledStart(e.type))
                        await deleteScheduledTaskOf(e);
                    await e.delete();
                },
            });
        }).register();
    }

    // ---- The Workflow graph ------------------------------------------------------------------------

    /** Set by CaseActivityLogic: "does this main entity type have a registered constructor?" (Signum reads
     *  `CaseActivityLogic.Options`, which lives in the other logic file). */
    export let hasConstructor: (mainEntityTypeName: string) => boolean = () => false;

    /** Set by CaseActivityLogic — the cases of a workflow, for the Deactivate / Delete checks. */
    export let workflowHasPendingActivities: (w: WorkflowEntity) => Promise<boolean> = async () => false;
    export let workflowUsedAsSubWorkflow: (w: WorkflowEntity) => Promise<Lite<WorkflowEntity>[]> = async () => [];

    function registerWorkflowGraph(): void {
        graph(WorkflowEntity, g => {
            g.Construct(WorkflowOperation.Create, {
                construct: () => WorkflowEntity.create({}),
            });

            g.Execute(WorkflowOperation.Save, {
                canBeNew: true,
                canBeModified: true,
                avoidImplicitSave: true,
                execute: async (e, args) => {
                    if (e.mainEntityStrategies.some(s => s.strategy === WorkflowMainEntityStrategy.CreateNew)) {
                        if (!hasConstructor(e.mainEntityType.cleanName))
                            throw new Error(WorkflowMessage
                                ._0NotAllowedFor1NoConstructorHasBeenDefinedInWithWorkflow.niceToString(
                                    Enum.niceName(WorkflowMainEntityStrategy, WorkflowMainEntityStrategy.CreateNew),
                                    e.mainEntityType.cleanName));
                    }

                    const model = args.firstOrNull(a => a instanceof WorkflowModel) as WorkflowModel | null;
                    const replacements = args.firstOrNull(a => a instanceof WorkflowReplacementModel) as WorkflowReplacementModel | null;
                    const issues = (args.firstOrNull(a => Array.isArray(a)) as WorkflowIssue[] | null) ?? [];

                    await applyDocument(e, model, replacements, issues);
                },
            });

            g.ConstructFrom(WorkflowOperation.Clone, {
                entityType: WorkflowEntity,
                construct: async w => await (await WorkflowBuilder.create(w)).clone(),
            });

            g.Delete(WorkflowOperation.Delete, {
                canDelete: () => null, // the real check is async — see `delete` below
                delete: async w => {
                    const usedWorkflows = await workflowUsedAsSubWorkflow(w);
                    if (usedWorkflows.length > 0)
                        throw new Error(WorkflowMessage.WorkflowUsedIn0ForDecompositionOrCallWorkflow
                            .niceToString(usedWorkflows.join(", ")));

                    const wb = await WorkflowBuilder.create(w);
                    await wb.deleteAll();
                },
            });

            g.Execute(WorkflowOperation.Activate, {
                canExecute: w => hasExpired(w) ? null : WorkflowMessage.Workflow0AlreadyActivated.niceToString(w),
                execute: async w => {
                    w.expirationDate = null;
                    await w.save();
                    await suspendWorkflowScheduledTasks(w, false);
                },
            });

            g.Execute(WorkflowOperation.Deactivate, {
                canExecute: w => hasExpired(w)
                    ? WorkflowMessage.Workflow0HasExpiredOn1.niceToString(w, w.expirationDate!.toString())
                    : null,
                execute: async (w, args) => {
                    if (await workflowHasPendingActivities(w))
                        throw new Error(CaseActivityMessage.ThereAreInprogressActivities.niceToString());

                    w.expirationDate = args[0] as Temporal.PlainDateTime;
                    await w.save();
                    await suspendWorkflowScheduledTasks(w, true);
                },
            });
        }).register();
    }

    /** Set by WorkflowEventTaskLogic — suspend / resume every Scheduled Start of a workflow. */
    export let suspendWorkflowScheduledTasks: (workflow: WorkflowEntity, suspended: boolean) => Promise<void> =
        async () => { };

    // ---- The designer round-trip ------------------------------------------------------------------

    export async function getWorkflowModel(workflow: WorkflowEntity): Promise<WorkflowModel> {
        const wb = await WorkflowBuilder.create(workflow);
        return await wb.getWorkflowModel();
    }

    export async function previewChanges(workflow: WorkflowEntity, model: WorkflowModel): Promise<WorkflowReplacementModel> {
        if (model == null)
            throw new Error("model is null");

        const document = WorkflowBuilder.parseDocument(model.diagramXml);
        const wb = await WorkflowBuilder.create(workflow);
        return await wb.previewChanges(document, model);
    }

    /** Signum's ApplyDocument — the body of WorkflowOperation.Save. */
    export async function applyDocument(workflow: WorkflowEntity, model: WorkflowModel | null,
        replacements: WorkflowReplacementModel | null, issuesContainer: WorkflowIssue[]): Promise<void> {

        if (issuesContainer.length > 0)
            throw new Error("issuesContainer should be empty");

        if (workflow.isNew)
            await workflow.save();

        const wb = await WorkflowBuilder.create(workflow);

        if (model != null)
            await wb.applyChanges(model, replacements);

        await wb.validateGraph(issuesContainer);

        if (issuesContainer.some(a => a.type === WorkflowIssueType.Error))
            throw new WorkflowIssuesException(issuesContainer);

        workflow.fullDiagramXml = WorkflowXmlEmbedded.create({ diagramXml: await wb.getDocumentText() });
        await workflow.save();
    }
}

/** Thrown by a save whose diagram has structural ERRORS. The route turns it into a 400 whose model state
 *  carries the issues, which is how the designer highlights the offending shapes (Signum throws an
 *  IntegrityCheckException with an empty dictionary and smuggles the issues through the ModelState). */
export class WorkflowIssuesException extends Error {
    constructor(readonly issues: WorkflowIssue[]) {
        super("Workflow has issues:\n" + issues.map(issueToString).join("\n"));
        this.name = "WorkflowIssuesException";
    }
}

function mandatoryWhen(what: string, when: string, value: string): string {
    return ValidationMessage._0IsMandatoryWhen1IsSetTo2.niceToString(what, when, value);
}

function nullWhen(what: string, when: string, value: string): string {
    return ValidationMessage._0ShouldBeNullWhen1IsSetTo2.niceToString(what, when, value);
}

function isBoundary(type: WorkflowEventType): boolean {
    return type === WorkflowEventType.BoundaryForkTimer || type === WorkflowEventType.BoundaryInterruptingTimer;
}

/** A Map lookup that FAILS LOUDLY (Signum's Dictionary.GetOrThrow). altea has no such extension. */
function mapGet<V>(map: Map<string, V>, key: string, what: string): V {
    const value = map.get(key);
    if (value == null)
        throw new Error(`${what} '${key}' not found`);
    return value;
}
