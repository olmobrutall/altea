import "@altea/altea/server";
import "@altea/altea/data/globals/arrayExtensions";
import { table } from "@altea/altea/server/table";
import { Lite } from "@altea/altea/data/lite";
import type { IWorkflowNodeEntity } from "../data/Workflow";
import {
    ConnectionType, WorkflowActivityEntity, WorkflowConnectionEntity, WorkflowEventEntity, WorkflowEventType,
    WorkflowGatewayDirection,
} from "../data/WorkflowNodes";
import { CaseActivityEntity, DoneType } from "../data/CaseActivity";
import { CaseNotificationEntity } from "../data/CaseNotification";
import type { CaseEntity } from "../data/Case";
import type { CaseActivityStats, CaseConnectionStats, CaseFlow } from "../data/WorkflowDtos";
import { WorkflowLogic } from "./WorkflowLogic.server";
import type { WorkflowNodeGraph } from "./WorkflowNodeGraph.server";

// Port of Signum.Workflow's CaseFlowLogic.cs — what the case-flow VIEW draws: for one case, every activity
// it has been through and every connection it took, so the diagram can highlight the real route (including
// the jumps, which have no connection of their own and are drawn as curves).
//
// altea divergences:
//  - async throughout (the durations and the notification counts are queries).
//  - `GetStartEvent`'s OperationLog probes are kept: they are how the view knows whether a case was opened by
//    a scheduled start (which start event) or by a user (`Register`).
//  - the DTO enum members are ORDINALS, not Signum's strings (see data/WorkflowDtos.ts).

export namespace CaseFlowLogic {

    export async function getCaseFlow(caseEntity: CaseEntity): Promise<CaseFlow> {
        const gr = await WorkflowLogic.getWorkflowNodeGraph(caseEntity.workflow.toLite());

        // Signum builds the averages with two queries over the workflow's nodes.
        // NOTE the two loops query directly rather than through the `withQuoted` members
        // (`workflow.workflowActivities()`, `a.averageDuration()`): those are QUERY-ONLY in altea — the
        // transformer emits the quoted AST beside the body and leaves the body's inner lambdas unstamped, so
        // calling one in memory throws. Signum's [AutoExpressionField] members work both ways.
        const workflow = caseEntity.workflow;
        const averages = new Map<string, number | null>();

        const activityAverages = await table(WorkflowActivityEntity)
            .filter(a => a.lane.pool.workflow.is(workflow))
            .map(a => ({
                node: a.toLite(),
                average: table(CaseActivityEntity).filter(ca => ca.workflowActivity.is(a)).avg(ca => ca.duration),
            }))
            .toArray();
        for (const row of activityAverages)
            averages.set(row.node.key(), row.average as unknown as number | null);

        const eventAverages = await table(WorkflowEventEntity)
            .filter(e => e.lane.pool.workflow.is(workflow) && e.type === WorkflowEventType.IntermediateTimer)
            .map(e => ({
                node: e.toLite(),
                average: table(CaseActivityEntity).filter(ca => ca.workflowActivity.is(e)).avg(ca => ca.duration),
            }))
            .toArray();
        for (const row of eventAverages)
            averages.set(row.node.key(), row.average as unknown as number | null);

        const activityRows = await table(CaseActivityEntity).filter(a => a.case.is(caseEntity)).toArray();
        const caseActivities = new Map<string, CaseActivityStats>();

        for (const ca of activityRows) {
            const node = ca.workflowActivity;
            const wa = node instanceof WorkflowActivityEntity ? node : null;
            const we = node instanceof WorkflowEventEntity ? node : null;

            caseActivities.set(ca.toLite().key(), {
                caseActivity: ca.toLite(),
                previousActivity: ca.previous,
                workflowActivity: node.toLite(),
                workflowActivityType: wa?.type ?? null,
                workflowEventType: we?.type ?? null,
                subWorkflow: wa?.subWorkflow?.workflow.toLite() ?? null,
                bpmnElementId: node.bpmnElementId,
                notifications: (await table(CaseNotificationEntity).filter(n => n.caseActivity.is(ca)).count()) as never,
                startDate: ca.startDate.toString(),
                doneDate: ca.doneDate?.toString() ?? null,
                doneType: ca.doneType,
                doneDecision: ca.doneDecision,
                doneBy: ca.doneBy,
                duration: ca.duration,
                averageDuration: averages.get(node.toLite().key()) ?? null,
                estimatedDuration: wa != null ? wa.estimatedDuration
                    : we!.timer?.duration?.totalMinutes() ?? null,
            });
        }

        const connections: CaseConnectionStats[] = [];

        const withConnection = (c: WorkflowConnectionEntity, from: CaseActivityStats): CaseConnectionStats => ({
            connection: c.toLite(),
            bpmnElementId: c.bpmnElementId,
            fromBpmnElementId: c.from.bpmnElementId,
            toBpmnElementId: c.to.bpmnElementId,
            doneBy: from.doneBy,
            doneDate: from.doneDate,
            doneType: from.doneType,
            doneDecision: from.doneDecision,
        });

        /** Signum's local GetSyncPaths — which stored connections a step could have travelled. */
        const getSyncPaths = (prev: CaseActivityStats, from: IWorkflowNodeEntity, to: IWorkflowNodeEntity)
            : CaseConnectionStats[] | null => {

            if (prev.doneType === DoneType.Timeout) {
                if (from instanceof WorkflowActivityEntity) {
                    const conns = from.boundaryTimers
                        .filter(a => a.type === WorkflowEventType.BoundaryInterruptingTimer)
                        .flatMap(e => [...gr.getAllConnections(e, to, path =>
                            prev.doneDecision != null
                                ? isValidPath(DoneType.Timeout, prev.doneDecision, path)
                                : path.every(a => a.type === ConnectionType.Normal))]);

                    if (conns.length > 0)
                        return conns.map(c => withConnection(c, prev));
                }
                else if (from instanceof WorkflowEventEntity) {
                    const conns = [...gr.getAllConnections(from, to, path =>
                        path.every(a => a.type === ConnectionType.Normal))];
                    if (conns.length > 0)
                        return conns.map(c => withConnection(c, prev));
                }
            }
            else {
                const conns = [...gr.getAllConnections(from, to, path =>
                    isValidPath(prev.doneType!, prev.doneDecision, path))];
                if (conns.length > 0)
                    return conns.map(c => withConnection(c, prev));
            }

            return null;
        };

        for (const cs of caseActivities.values()) {
            if (cs.previousActivity == null || !caseActivities.has(cs.previousActivity.key()))
                continue;

            const prev = caseActivities.get(cs.previousActivity.key())!;
            const from = gr.getNode(prev.workflowActivity);
            const to = gr.getNode(cs.workflowActivity);

            if (prev.doneType != null) {
                const res = getSyncPaths(prev, from, to);
                if (res != null) {
                    connections.push(...res);
                    continue;
                }
            }

            if (from instanceof WorkflowActivityEntity) {
                const conns = from.boundaryTimers
                    .filter(a => a.type === WorkflowEventType.BoundaryForkTimer)
                    .flatMap(e => [...gr.getAllConnections(e, to, path => path.every(a => a.type === ConnectionType.Normal))]);
                if (conns.length > 0) {
                    connections.push(...conns.map(c => withConnection(c, prev)));
                    continue;
                }
            }

            // No stored connection explains the step — it is a JUMP, drawn by the client itself.
            connections.push({
                connection: null,
                bpmnElementId: null,
                fromBpmnElementId: from.bpmnElementId,
                toBpmnElementId: to.bpmnElementId,
                doneBy: prev.doneBy,
                doneDate: prev.doneDate,
                doneType: prev.doneType,
                doneDecision: prev.doneDecision,
            });
        }

        // An activity that is DONE but is nobody's `previous` may still have fed a parallel JOIN.
        const isInPrevious = new Set([...caseActivities.values()]
            .map(a => a.previousActivity?.key()).notNull());

        for (const cs of caseActivities.values()) {
            if (cs.doneDate == null || isInPrevious.has(cs.caseActivity.key()))
                continue;

            const from = gr.getNode(cs.workflowActivity);
            const candidates = cs.doneType === DoneType.Timeout && from instanceof WorkflowActivityEntity
                ? from.boundaryTimers.flatMap(e => gr.nextConnections(e))
                : gr.nextConnections(from);

            const nextConnection = candidates.singleOrNull(c => isCompatible(c.type, cs.doneType!)
                && (c.doneDecision() == null || c.doneDecision() === cs.doneDecision)
                && gr.isParallelGateway(c.to, WorkflowGatewayDirection.Join));

            if (nextConnection != null)
                connections.push(withConnection(nextConnection, cs));
        }

        // The FIRST activity of the case: connect the start event to it.
        const firsts = [...caseActivities.values()]
            .filter(a => a.previousActivity == null || !caseActivities.has(a.previousActivity.key()));

        for (const f of firsts) {
            const start = await getStartEvent(caseEntity, f.caseActivity, gr);
            if (start != null)
                connections.push(...[...gr.getAllConnections(start, gr.getNode(f.workflowActivity),
                    path => path.every(a => a.type === ConnectionType.Normal))]
                    .map(c => withConnection(c, f)));
        }

        // …and, for a finished case, the LAST activity to an end event.
        if (caseEntity.finishDate != null) {
            const lasts = [...caseActivities.values()]
                .filter(last => ![...caseActivities.values()].some(a => a.previousActivity?.is(last.caseActivity)));

            const ends = [...gr.events.values()].filter(a => a.type === WorkflowEventType.Finish);

            for (const last of lasts) {
                const from = gr.getNode(last.workflowActivity);
                const compatibleEnds = ends.map(end => getSyncPaths(last, from, end)).notNull();

                if (compatibleEnds.length > 0) {
                    for (const path of compatibleEnds)
                        connections.push(...path);
                }
                else {
                    // Cancelled case: draw it reaching the first end event anyway.
                    const firstEnd = ends.firstOrNull();
                    if (firstEnd != null)
                        connections.push({
                            connection: null,
                            bpmnElementId: null,
                            fromBpmnElementId: from.bpmnElementId,
                            toBpmnElementId: firstEnd.bpmnElementId,
                            doneBy: last.doneBy,
                            doneDate: last.doneDate,
                            doneType: last.doneType,
                            doneDecision: last.doneDecision,
                        });
                }
            }
        }

        const groupToDic = <T>(items: T[], keyOf: (item: T) => string): { [key: string]: T[] } => {
            const result: { [key: string]: T[] } = {};
            for (const item of items)
                (result[keyOf(item)] ??= []).push(item);
            return result;
        };

        return {
            activities: groupToDic([...caseActivities.values()], a => a.bpmnElementId),
            connections: groupToDic(connections.filter(a => a.bpmnElementId != null), a => a.bpmnElementId!),
            jumps: connections.filter(a => a.bpmnElementId == null),
            allNodes: [
                ...connections.map(a => a.fromBpmnElementId).notNull(),
                ...connections.map(a => a.toBpmnElementId).notNull(),
            ].distinct(),
        };
    }

    function isCompatible(type: ConnectionType, doneType: DoneType): boolean {
        switch (doneType) {
            case DoneType.Next: return type === ConnectionType.Normal;
            case DoneType.Jump: return type === ConnectionType.Jump;
            case DoneType.Timeout: return type === ConnectionType.Normal;
            case DoneType.ScriptSuccess: return type === ConnectionType.Normal;
            case DoneType.ScriptFailure: return type === ConnectionType.ScriptException;
            case DoneType.Recompose: return type === ConnectionType.Normal;
            default: throw new Error("Unexpected DoneType");
        }
    }

    function isValidPath(doneType: DoneType, doneDecision: string | null, path: WorkflowConnectionEntity[]): boolean {
        switch (doneType) {
            case DoneType.Next:
            case DoneType.ScriptSuccess:
            case DoneType.Recompose:
            case DoneType.Timeout:
                return path.every(a => a.type === ConnectionType.Normal
                    || (doneDecision != null && a.doneDecision() === doneDecision));
            case DoneType.Jump:
                return path.every((a, i) => i === 0 ? a.type === ConnectionType.Jump : a.type === ConnectionType.Normal);
            case DoneType.ScriptFailure:
                return path.every((a, i) => i === 0 ? a.type === ConnectionType.ScriptException : a.type === ConnectionType.Normal);
            default:
                throw new Error("Unexpected DoneType");
        }
    }

    /**
     * Signum's GetStartEvent — which start event opened this case. A case opened by a SCHEDULED START has an
     * OperationLog row for CreateCaseFromWorkflowEventTask whose Origin is the task (and the task names its
     * event); a case opened by a user has one for `Register`.
     */
    async function getStartEvent(caseEntity: CaseEntity, firstActivity: Lite<CaseActivityEntity>,
        gr: WorkflowNodeGraph): Promise<WorkflowEventEntity | null> {

        const { OperationLogEntity } = await import("@altea/altea/data/operationLog");
        const { CaseActivityOperation } = await import("../data/CaseActivity");
        const { WorkflowEventTaskEntity } = await import("../data/WorkflowEventTask");

        const fromTaskKey = CaseActivityOperation.CreateCaseFromWorkflowEventTask.key;
        const caseLite = caseEntity.toLite();

        const wet = await table(OperationLogEntity)
            .filter(l => l.operation.key === fromTaskKey && l.target!.is(caseLite))
            .map(l => l.origin)
            .singleOrNull();

        if (wet != null) {
            const taskLite = wet as Lite<InstanceType<typeof WorkflowEventTaskEntity>>;
            const eventLite = await table(WorkflowEventTaskEntity)
                .filter(a => a.id === taskLite.id).map(a => a.event).singleOrNull();
            return eventLite == null ? null : gr.getEvent(eventLite);
        }

        const registerKey = CaseActivityOperation.Register.key;
        const register = await table(OperationLogEntity)
            .some(l => l.operation.key === registerKey && l.target!.is(firstActivity) && l.exception == null);

        if (register)
            return [...gr.events.values()].single(a => a.type === WorkflowEventType.Start);

        return [...gr.events.values()].filter(a => a.type === WorkflowEventType.Start
            || a.type === WorkflowEventType.ScheduledStart).onlyOrNull();
    }
}
