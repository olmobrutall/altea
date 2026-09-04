import "@altea/altea/server";
import { table } from "@altea/altea/server/table";
import type { IQuery } from "@altea/altea/data/iquery";
import { Lite } from "@altea/altea/data/lite";
import { UserHolder } from "@altea/altea/server/userHolder";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { WorkflowEntity } from "../data/Workflow";
import {
    WorkflowActivityEntity, WorkflowConnectionEntity, WorkflowEventEntity, WorkflowGatewayEntity,
    WorkflowLaneEntity, WorkflowPoolEntity,
} from "../data/WorkflowNodes";
import { CaseActivityEntity, CaseActivityExecutedTimerEntity } from "../data/CaseActivity";
import { CaseEntity, CaseTagEntity } from "../data/Case";
import { CaseNotificationEntity } from "../data/CaseNotification";
import { WorkflowEventTaskEntity, WorkflowEventTaskConditionResultEntity } from "../data/WorkflowEventTask";
import { ScheduledTaskEntity } from "@altea/altea-scheduler/data/Scheduler";

/**
 * The RUNTIME twins of the module's `withQuoted` prototype members (declared in WorkflowLogic.server.ts and
 * CaseActivityLogic.server.ts).
 *
 * ---- WHY THIS FILE EXISTS -------------------------------------------------------------------------------
 *
 * Signum's `[AutoExpressionField]` members are ordinary C# methods with an expression twin: the LINQ provider
 * translates them inside a query, and calling one outside a query just runs the body. altea's `withQuoted` is
 * NOT symmetric — the quote-transformer emits the quoted AST as a second argument and leaves the runtime
 * body's inner lambdas UNSTAMPED, so `wf.workflowConnections()` called in memory throws
 *
 *     Error: The following lambda has not been quoted. Are you using ts-path and quote-transformer?
 *
 * Every other altea module uses its quoted members only inside queries / `QueryLogic.expressions.register`,
 * so the asymmetry never showed. The workflow ENGINE is the first consumer that needs both: the same sets are
 * query tokens for the UI *and* the working data of `executeStep` / the timeout sweep / the case-flow builder.
 *
 * So each quoted member gets a plain query twin here, with the SAME body. The quoted members stay exactly as
 * Signum declares them (they are what the query tokens are built from); the engine calls these.
 */
export namespace CaseQueries {

    // ---- CaseNotification --------------------------------------------------------------------------------

    /** `CaseNotificationEntity.isForMe` — is this notification the current user's? */
    export function isForMe(cn: CaseNotificationEntity): boolean {
        return cn.user.is(UserHolder.currentUserLite() as Lite<UserEntity>);
    }

    // ---- CaseActivity ------------------------------------------------------------------------------------

    export function notifications(ca: CaseActivityEntity): IQuery<CaseNotificationEntity> {
        return table(CaseNotificationEntity).filter(a => a.caseActivity.is(ca));
    }

    export function executedTimers(ca: CaseActivityEntity): IQuery<CaseActivityExecutedTimerEntity> {
        return table(CaseActivityExecutedTimerEntity).filter(a => a.caseActivity.is(ca));
    }

    export function lastExecutedTimer(ca: CaseActivityEntity, we: Lite<WorkflowEventEntity>):
        Promise<CaseActivityExecutedTimerEntity | null> {
        return executedTimers(ca).filter(a => a.boundaryEvent.is(we))
            .orderByDescending(a => a.creationDate).firstOrNull();
    }

    export function nextActivities(ca: CaseActivityEntity): IQuery<CaseActivityEntity> {
        return table(CaseActivityEntity).filter(a => a.previous!.is(ca));
    }

    // ---- Case --------------------------------------------------------------------------------------------

    export function caseActivities(c: CaseEntity): IQuery<CaseActivityEntity> {
        return table(CaseActivityEntity).filter(a => a.case.is(c));
    }

    export function tags(c: CaseEntity): IQuery<CaseTagEntity> {
        return table(CaseTagEntity).filter(a => a.case.is(c));
    }

    export function subCases(c: CaseEntity): IQuery<CaseEntity> {
        return table(CaseEntity).filter(sc => sc.parentCase!.is(c));
    }

    /** The activity of the PARENT case that spawned this one (Signum's DecompositionSurrogateActivity). */
    export function decompositionSurrogateActivity(c: CaseEntity): Promise<CaseActivityEntity> {
        return caseActivities(c).orderBy(ca => ca.startDate).map(a => a.previous!.entity).first();
    }

    // ---- Workflow ----------------------------------------------------------------------------------------

    export function cases(wf: WorkflowEntity): IQuery<CaseEntity> {
        return table(CaseEntity).filter(a => a.workflow.is(wf));
    }

    export function workflowPools(wf: WorkflowEntity): IQuery<WorkflowPoolEntity> {
        return table(WorkflowPoolEntity).filter(a => a.workflow.is(wf));
    }

    export function workflowLanes(wf: WorkflowEntity): IQuery<WorkflowLaneEntity> {
        return table(WorkflowLaneEntity).filter(a => a.pool.workflow.is(wf));
    }

    /** `WorkflowPoolEntity.workflowLanes` — the lanes of ONE pool. */
    export function poolLanes(pool: WorkflowPoolEntity): IQuery<WorkflowLaneEntity> {
        return table(WorkflowLaneEntity).filter(a => a.pool.is(pool));
    }

    /** `WorkflowPoolEntity.workflowConnections` — the connections INSIDE one pool. */
    export function poolConnections(pool: WorkflowPoolEntity): IQuery<WorkflowConnectionEntity> {
        return table(WorkflowConnectionEntity)
            .filter(a => a.from.lane.pool.is(pool) && a.to.lane.pool.is(pool));
    }

    export function workflowActivities(wf: WorkflowEntity): IQuery<WorkflowActivityEntity> {
        return table(WorkflowActivityEntity).filter(a => a.lane.pool.workflow.is(wf));
    }

    export function workflowEvents(wf: WorkflowEntity): IQuery<WorkflowEventEntity> {
        return table(WorkflowEventEntity).filter(a => a.lane.pool.workflow.is(wf));
    }

    export function workflowGateways(wf: WorkflowEntity): IQuery<WorkflowGatewayEntity> {
        return table(WorkflowGatewayEntity).filter(a => a.lane.pool.workflow.is(wf));
    }

    export function workflowConnections(wf: WorkflowEntity): IQuery<WorkflowConnectionEntity> {
        return table(WorkflowConnectionEntity)
            .filter(a => a.from.lane.pool.workflow.is(wf) && a.to.lane.pool.workflow.is(wf));
    }

    // ---- Nodes -------------------------------------------------------------------------------------------

    export function nodeCaseActivities(node: WorkflowActivityEntity | WorkflowEventEntity):
        IQuery<CaseActivityEntity> {
        return table(CaseActivityEntity).filter(a => a.workflowActivity.is(node));
    }

    export function averageDuration(node: WorkflowActivityEntity | WorkflowEventEntity):
        Promise<number | null> {
        return nodeCaseActivities(node).avg(a => a.duration);
    }

    export function nextConnections(node: WorkflowActivityEntity | WorkflowEventEntity | WorkflowGatewayEntity):
        IQuery<WorkflowConnectionEntity> {
        return table(WorkflowConnectionEntity).filter(a => a.from.is(node));
    }

    export function previousConnections(
        node: WorkflowActivityEntity | WorkflowEventEntity | WorkflowGatewayEntity):
        IQuery<WorkflowConnectionEntity> {
        return table(WorkflowConnectionEntity).filter(a => a.to.is(node));
    }

    // ---- WorkflowEventTask -------------------------------------------------------------------------------

    export function workflowEventTask(we: WorkflowEventEntity): Promise<WorkflowEventTaskEntity | null> {
        return table(WorkflowEventTaskEntity).singleOrNull(et => et.event.is(we));
    }

    export function scheduledTask(we: WorkflowEventEntity): Promise<ScheduledTaskEntity | null> {
        return table(ScheduledTaskEntity)
            .singleOrNull(st => (st.task as WorkflowEventTaskEntity).event.is(we));
    }

    export function conditionResults(task: WorkflowEventTaskEntity):
        IQuery<WorkflowEventTaskConditionResultEntity> {
        return table(WorkflowEventTaskConditionResultEntity).filter(a => a.workflowEventTask!.is(task));
    }
}
