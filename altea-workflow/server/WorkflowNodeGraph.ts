import "@altea/altea/data/globals/arrayExtensions";
import { DirectedEdgedGraph } from "@altea/altea/server/directedGraph";
import { Enum } from "@altea/altea/data/enum";
import { Lite } from "@altea/altea/data/lite";
import { Clock } from "@altea/altea/data/utils/clock";
import { Temporal } from "@altea/altea/data/basics";
import {
    WorkflowEntity, WorkflowIssueType, WorkflowMainEntityStrategy, WorkflowValidationMessage,
    type IWorkflowNodeEntity, type IWorkflowObjectEntity,
} from "../data/Workflow";
import {
    ConnectionType, WorkflowActivityEntity, WorkflowActivityType, WorkflowConnectionEntity, WorkflowEventEntity,
    WorkflowEventType, WorkflowGatewayDirection, WorkflowGatewayEntity, WorkflowGatewayType, WorkflowLaneEntity,
    isFinish, isScheduledStart, isStart, isTimer,
} from "../data/WorkflowNodes";
import type { WorkflowIssue } from "../data/WorkflowDtos";

// Port of Signum.Workflow's WorkflowNodeGraph.cs + WorkflowIssue — the in-memory form of ONE workflow: every
// node and connection, the graph both ways, the VALIDATION, and the "parallel track" analysis that lets the
// engine decide when a join is satisfied.
//
// altea divergences:
//  - Signum's `DirectedEdgedGraph<IWorkflowNodeEntity, HashSet<WorkflowConnectionEntity>>` needed a core
//    addition: altea had `DirectedGraph<T>` but no edge-valued variant, so one was added beside it
//    (@altea/altea/server/directedGraph). Two nodes CAN be joined by more than one connection, which is why
//    the edge value is a Set.
//  - the dictionaries are keyed by the lite's KEY string, not by the Lite OBJECT: a Lite is not a value key
//    in JavaScript (the same reason altea-toolbar's caches are arrays).
//  - `Validate`'s `changeDirection` callback is ASYNC here — the builder's implementation saves the gateway.
//  - `IsStartCurrentUser` is async (altea's role expansion is).

/** Signum's WorkflowIssue + its AddError/AddWarning extensions. */
export function addWarning(issues: WorkflowIssue[], node: IWorkflowObjectEntity | null, message: string): void {
    issues.push({ type: WorkflowIssueType.Warning, bpmnElementId: node?.bpmnElementId ?? null, message });
}

export function addError(issues: WorkflowIssue[], node: IWorkflowObjectEntity | null, message: string): void {
    issues.push({ type: WorkflowIssueType.Error, bpmnElementId: node?.bpmnElementId ?? null, message });
}

export function issueToString(issue: WorkflowIssue): string {
    return `${Enum.niceName(WorkflowIssueType, issue.type)}(${issue.bpmnElementId ?? ""}): ${issue.message}`;
}

/** How the graph asks "who may act in this lane", so the graph itself needs no CaseActivityLogic import
 *  (Signum reaches `lane.GetActors(null)`, an extension method in the logic assembly). */
export type LaneActorsResolver = (lane: WorkflowLaneEntity) => Promise<Lite<never>[]>;

export class WorkflowNodeGraph {
    workflow!: WorkflowEntity;

    events = new Map<string, WorkflowEventEntity>();
    activities = new Map<string, WorkflowActivityEntity>();
    gateways = new Map<string, WorkflowGatewayEntity>();
    connections = new Map<string, WorkflowConnectionEntity>();
    lanes: WorkflowLaneEntity[] = [];

    nextGraph!: DirectedEdgedGraph<IWorkflowNodeEntity, Set<WorkflowConnectionEntity>>;
    previousGraph!: DirectedEdgedGraph<IWorkflowNodeEntity, Set<WorkflowConnectionEntity>>;

    /**
     * Filled by `validate`: which parallel TRACK each node belongs to, and which node opened that track.
     * Null until a successful validation — `WorkflowLogic.getWorkflowNodeGraph` validates on first use.
     *
     * altea divergence: keyed by the node's LITE KEY, where Signum keys by the ENTITY. Same reason as
     * fillGraphs — without an ambient EntityCache a connection's `from` is a different object than the graph's
     * node for the same row, so an entity-keyed map would miss every lookup.
     */
    trackId: Map<string, number> | null = null;
    trackCreatedBy: Map<number, IWorkflowNodeEntity | null> | null = null;

    /** The key `trackId` (and DirectedEdgedGraph) compares nodes by. */
    static nodeKey(node: IWorkflowNodeEntity): string {
        return node.toLite().key();
    }

    // ---- Lookups ----------------------------------------------------------------------------------------

    getNode(lite: Lite<IWorkflowNodeEntity>): IWorkflowNodeEntity {
        const key = lite.key();
        const node = this.events.get(key) ?? this.activities.get(key) ?? this.gateways.get(key);
        if (node == null)
            throw new Error("Unexpected " + key);
        return node;
    }

    tryGetActivity(lite: Lite<WorkflowActivityEntity>): WorkflowActivityEntity | undefined {
        return this.activities.get(lite.key());
    }

    getActivity(lite: Lite<WorkflowActivityEntity>): WorkflowActivityEntity {
        const a = this.activities.get(lite.key());
        if (a == null)
            throw new Error("Activity not found in graph: " + lite.key());
        return a;
    }

    getEvent(lite: Lite<WorkflowEventEntity>): WorkflowEventEntity {
        const e = this.events.get(lite.key());
        if (e == null)
            throw new Error("Event not found in graph: " + lite.key());
        return e;
    }

    allNodes(): IWorkflowNodeEntity[] {
        return [...this.events.values(), ...this.activities.values(), ...this.gateways.values()];
    }

    /** Signum's IsStartCurrentUser — may the current user open a case of this workflow? */
    async isStartCurrentUser(isCurrentUserActor: (actor: Lite<never>) => Promise<boolean>,
        getActors: LaneActorsResolver): Promise<boolean> {

        if (hasExpired(this.workflow))
            return false;

        if (this.workflow.mainEntityStrategies.length === 0)
            return false;

        for (const e of this.events.values()) {
            if (e.type !== WorkflowEventType.Start)
                continue;
            const actors = await getActors(e.lane);
            for (const a of actors)
                if (await isCurrentUserActor(a))
                    return true;
        }
        return false;
    }

    /** Signum's Autocomplete — the jump targets a client may pick: finish events, activities and gateways. */
    autocomplete(subString: string, count: number, excludes: Lite<IWorkflowNodeEntity>[]): Lite<IWorkflowNodeEntity>[] {
        const excluded = new Set((excludes ?? []).map(e => e.key()));
        const matches = (lite: Lite<IWorkflowNodeEntity>): boolean =>
            (lite.toString() ?? "").toLowerCase().includes(subString.toLowerCase());

        const candidates: Lite<IWorkflowNodeEntity>[] = [
            ...[...this.events.values()].filter(e => e.type === WorkflowEventType.Finish).map(e => e.toLite()),
            ...[...this.activities.values()].map(a => a.toLite()),
            ...[...this.gateways.values()].map(g => g.toLite()),
        ];

        return candidates
            .filter(l => matches(l) && !excluded.has(l.key()))
            .orderByDescending(l => (l.toString() ?? "").length)
            .slice(0, count);
    }

    // ---- The graphs -------------------------------------------------------------------------------------

    fillGraphs(): void {
        // Keyed by the node's LITE KEY, not by object identity. Signum wraps its graph build in
        // `using (new EntityCache())`, so `c.From` IS the very instance the events/activities/gateways lists
        // hold; altea has no ambient identity map (each query gets its own Retriever), so those are different
        // objects for the same row — and an identity-keyed graph would join nothing. See DirectedEdgedGraph.
        const graph = new DirectedEdgedGraph<IWorkflowNodeEntity, Set<WorkflowConnectionEntity>>(
            () => new Set<WorkflowConnectionEntity>(), n => n.toLite().key());

        for (const e of this.events.values()) graph.add(e);
        for (const a of this.activities.values()) graph.add(a);
        for (const g of this.gateways.values()) graph.add(g);
        for (const c of this.connections.values()) graph.getOrCreate(c.from, c.to).add(c);

        this.nextGraph = graph;
        this.previousGraph = graph.inverse();
    }

    nextConnections(node: IWorkflowNodeEntity): WorkflowConnectionEntity[] {
        return [...this.nextGraph.tryRelatedTo(node).values()].flatMap(s => [...s]);
    }

    previousConnections(node: IWorkflowNodeEntity): WorkflowConnectionEntity[] {
        return [...this.previousGraph.tryRelatedTo(node).values()].flatMap(s => [...s]);
    }

    /** Signum's GetSplit — the node that opened the track each of this join's inputs is on. */
    getSplit(gateway: WorkflowGatewayEntity): IWorkflowNodeEntity {
        const trackId = this.trackId!;
        const trackCreatedBy = this.trackCreatedBy!;
        const candidates = this.previousConnections(gateway)
            .map(a => trackCreatedBy.get(trackId.get(WorkflowNodeGraph.nodeKey(a.from))!) ?? null)
            .distinct();
        if (candidates.length !== 1)
            throw new Error(`Gateway '${gateway}' has inputs from ${candidates.length} different tracks`);
        return candidates[0]!;
    }

    /**
     * Signum's GetAllConnections — every connection on any path from `from` to `to` that `isValidPath`
     * accepts. Used by the case-flow view to draw which route a case actually took, and by the engine to
     * decide whether a transition context belongs to a newly created activity.
     */
    getAllConnections(from: IWorkflowNodeEntity, to: IWorkflowNodeEntity,
        isValidPath: (path: WorkflowConnectionEntity[]) => boolean): Set<WorkflowConnectionEntity> {

        // Node comparison is by KEY, not `===`: Signum can use reference equality because its graph is built
        // inside `using (new EntityCache())`, so `to` / `from` (which the caller took from a case activity or
        // a connection) ARE the graph's own instances. altea has no such scope — see fillGraphs.
        const key = WorkflowNodeGraph.nodeKey;
        const toKey = key(to);
        const fromKey = key(from);

        const result = new Set<WorkflowConnectionEntity>();
        const partialPath: WorkflowConnectionEntity[] = [];
        const visited = new Set<string>();

        const flood = (node: IWorkflowNodeEntity): void => {
            if (key(node) === toKey) {
                if (isValidPath(partialPath))
                    for (const c of partialPath)
                        result.add(c);
                return;
            }

            // Stop at any OTHER activity: a path through a second activity is a different step, not a route.
            if (node instanceof WorkflowActivityEntity && key(node) !== fromKey)
                return;

            // …and at a boundary event of the activity we started from (that is a timer route, handled by
            // the caller starting AT the boundary event).
            if (node instanceof WorkflowEventEntity && key(node) !== fromKey && node.boundaryOf?.is(from as never))
                return;

            for (const con of this.nextConnections(node)) {
                const nextKey = key(con.to);
                if (!visited.has(nextKey)) {
                    visited.add(nextKey);
                    partialPath.push(con);
                    flood(con.to);
                    partialPath.pop();
                    visited.delete(nextKey);
                }
            }
        };

        flood(from);
        return result;
    }

    isParallelGateway(node: IWorkflowNodeEntity, direction?: WorkflowGatewayDirection): boolean {
        return node instanceof WorkflowGatewayEntity
            && node.type !== WorkflowGatewayType.Exclusive
            && (direction == null || direction === node.direction);
    }

    // ---- Validation -------------------------------------------------------------------------------------

    /**
     * Signum's Validate — every structural rule of a BPMN workflow, plus the TRACK assignment. Faithful
     * port, in the same order, so a rule added upstream is easy to re-apply.
     *
     * `changeDirection` is called when a gateway's stored Split/Join disagrees with its fan-in/fan-out: the
     * builder FIXES and saves it, while a read-only caller throws. It is async (a save is).
     */
    async validate(issues: WorkflowIssue[],
        changeDirection: (g: WorkflowGatewayEntity, newDirection: WorkflowGatewayDirection) => Promise<void>,
        scheduledStartInfo?: (e: WorkflowEventEntity) => Promise<{ hasSchedule: boolean; hasTask: boolean; conditionMissing: boolean }>,
    ): Promise<void> {

        const events = [...this.events.values()];
        const activities = [...this.activities.values()];
        const gateways = [...this.gateways.values()];
        const connections = [...this.connections.values()];

        if (events.count(a => isStart(a.type)) === 0)
            addError(issues, null, WorkflowValidationMessage.SomeStartEventIsRequired.niceToString());

        const strategies = this.workflow.mainEntityStrategies.map(s => s.strategy);
        if (strategies.some(a => a === WorkflowMainEntityStrategy.SelectByUser || a === WorkflowMainEntityStrategy.Clone))
            if (events.count(a => a.type === WorkflowEventType.Start) === 0)
                addError(issues, null, WorkflowValidationMessage.NormalStartEventIsRequiredWhenThe0Are1Or2.niceToString(
                    WorkflowEntity.nicePropertyName(a => a.mainEntityStrategies),
                    Enum.niceName(WorkflowMainEntityStrategy, WorkflowMainEntityStrategy.SelectByUser),
                    Enum.niceName(WorkflowMainEntityStrategy, WorkflowMainEntityStrategy.Clone)));

        if (events.count(a => a.type === WorkflowEventType.Start) > 1)
            for (const e of events.filter(a => a.type === WorkflowEventType.Start))
                addError(issues, e, WorkflowValidationMessage.MultipleStartEventsAreNotAllowed.niceToString());

        if (events.count(a => isFinish(a.type)) === 0)
            addError(issues, null, WorkflowValidationMessage.FinishEventIsRequired.niceToString());

        for (const e of events) {
            const fanIn = this.previousConnections(e).length;
            const fanOut = this.nextConnections(e).length;

            if (isStart(e.type)) {
                if (fanIn > 0)
                    addError(issues, e, WorkflowValidationMessage._0HasInputs.niceToString(e));
                if (fanOut === 0)
                    addError(issues, e, WorkflowValidationMessage._0HasNoOutputs.niceToString(e));
                if (fanOut > 1)
                    addError(issues, e, WorkflowValidationMessage._0HasMultipleOutputs.niceToString(e));

                if (fanOut === 1) {
                    const nextConn = this.nextConnections(e).single();
                    if (e.type === WorkflowEventType.Start && !(nextConn.to instanceof WorkflowActivityEntity))
                        addError(issues, e, WorkflowValidationMessage.StartEventNextNodeShouldBeAnActivity.niceToString());
                }
            }

            if (isFinish(e.type)) {
                if (fanIn === 0)
                    addError(issues, e, WorkflowValidationMessage._0HasNoInputs.niceToString(e));
                if (fanOut > 0)
                    addError(issues, e, WorkflowValidationMessage._0HasOutputs.niceToString(e));
            }

            if (isScheduledStart(e.type) && scheduledStartInfo != null) {
                // Signum reads `e.ScheduledTask()` / `e.WorkflowEventTask()` inline (both are DB queries).
                // altea passes the three answers in, so this method needs no scheduler import.
                const info = await scheduledStartInfo(e);

                if (!info.hasSchedule)
                    addError(issues, e, WorkflowValidationMessage._0IsTimerStartAndSchedulerIsMandatory.niceToString(e));

                if (!info.hasTask)
                    addError(issues, e, WorkflowValidationMessage._0IsTimerStartAndTaskIsMandatory.niceToString(e));
                else if (info.conditionMissing)
                    addError(issues, e, WorkflowValidationMessage._0IsConditionalStartAndTaskConditionIsMandatory.niceToString(e));
            }

            if (isTimer(e.type)) {
                const boundaryOutput = this.nextConnections(e).onlyOrNull();
                if (boundaryOutput == null || boundaryOutput.type !== ConnectionType.Normal) {
                    if (e.type === WorkflowEventType.IntermediateTimer)
                        addError(issues, e, WorkflowValidationMessage.IntermediateTimer0ShouldHaveOneOutputOfType1
                            .niceToString(e, Enum.niceName(ConnectionType, ConnectionType.Normal)));
                    else {
                        const parentActivity = activities.single(a => a.boundaryTimers.includes(e));
                        addError(issues, e, WorkflowValidationMessage.BoundaryTimer0OfActivity1ShouldHaveExactlyOneConnectionOfType2
                            .niceToString(e, parentActivity, Enum.niceName(ConnectionType, ConnectionType.Normal)));
                    }
                }

                if (e.type === WorkflowEventType.IntermediateTimer && (e.name ?? "") === "")
                    addError(issues, e, WorkflowValidationMessage.IntermediateTimer0ShouldHaveName.niceToString(e));

                if (e.type === WorkflowEventType.BoundaryInterruptingTimer) {
                    const parentActivity = activities.single(a => a.boundaryTimers.includes(e));
                    const optionName = WorkflowEventEntity.nicePropertyName(a => a.decisionOptionName);
                    const decisionNice = Enum.niceName(WorkflowActivityType, WorkflowActivityType.Decision);
                    const hasName = (e.decisionOptionName ?? "").trim() !== "";

                    if (!hasName && parentActivity.type === WorkflowActivityType.Decision)
                        addError(issues, e, WorkflowValidationMessage.BoundaryTimer0OfActivity1ShouldHave2BecauseActivityIs3
                            .niceToString(e, parentActivity, optionName, decisionNice));

                    if (hasName && parentActivity.type !== WorkflowActivityType.Decision)
                        addError(issues, e, WorkflowValidationMessage.BoundaryTimer0OfActivity1CanNotHave2BecauseActivityIsNot3
                            .niceToString(e, parentActivity, optionName, decisionNice));

                    if (hasName && !parentActivity.decisionOptions.some(a => a.option.name === e.decisionOptionName))
                        addError(issues, e, WorkflowValidationMessage.BoundaryTimer0OfActivity1HasInvalid23
                            .niceToString(e, parentActivity, optionName, e.decisionOptionName));
                }
            }
        }

        for (const g of gateways) {
            const fanIn = this.previousConnections(g).length;
            const fanOut = this.nextConnections(g).length;
            if (fanIn === 0)
                addError(issues, g, WorkflowValidationMessage._0HasNoInputs.niceToString(g));
            if (fanOut === 0)
                addError(issues, g, WorkflowValidationMessage._0HasNoOutputs.niceToString(g));
            if (fanIn === 1 && fanOut === 1)
                addError(issues, g, WorkflowValidationMessage._0HasJustOneInputAndOneOutput.niceToString(g));

            const newDirection = fanOut === 1 ? WorkflowGatewayDirection.Join : WorkflowGatewayDirection.Split;
            if (g.direction !== newDirection)
                await changeDirection(g, newDirection);

            if (g.direction === WorkflowGatewayDirection.Split) {
                if (g.type === WorkflowGatewayType.Exclusive || g.type === WorkflowGatewayType.Inclusive) {
                    if (this.nextConnections(g).some(c => c.type === ConnectionType.Decision)) {
                        // Every activity that can reach this gateway without passing another activity must be
                        // a Decision — otherwise nobody produced the decision the outputs branch on.
                        const previousActivities: WorkflowActivityEntity[] = [];
                        this.previousGraph.depthExploreConnections(g, (_prev, _value, next) => {
                            if (next instanceof WorkflowActivityEntity) {
                                previousActivities.push(next);
                                return false;
                            }
                            return true;
                        });

                        for (const act of previousActivities.filter(a => a.type !== WorkflowActivityType.Decision))
                            addError(issues, act, WorkflowValidationMessage.Activity0ShouldBeDecision.niceToString(act));
                    }
                }

                switch (g.type) {
                    case WorkflowGatewayType.Exclusive:
                        if (this.nextConnections(g).orderByDescending(a => a.order).slice(1)
                            .some(c => c.type === ConnectionType.Normal && c.condition == null))
                            addError(issues, g, WorkflowValidationMessage
                                .Gateway0ShouldHasConditionOrDecisionOnEachOutputExceptTheLast.niceToString(g));
                        break;
                    case WorkflowGatewayType.Inclusive:
                        if (this.nextConnections(g).count(c => c.type === ConnectionType.Normal && c.condition == null) !== 1)
                            addError(issues, g, WorkflowValidationMessage
                                .InclusiveGateway0ShouldHaveOneConnectionWithoutCondition.niceToString(g));
                        break;
                    case WorkflowGatewayType.Parallel:
                        if (this.nextConnections(g).length === 0)
                            addError(issues, g, WorkflowValidationMessage.ParallelSplit0ShouldHaveAtLeastOneConnection.niceToString(g));
                        if (this.nextConnections(g).some(a => a.type !== ConnectionType.Normal || a.condition != null))
                            addError(issues, g, WorkflowValidationMessage
                                .ParallelSplit0ShouldHaveOnlyNormalConnectionsWithoutConditions.niceToString(g));
                        break;
                }
            }
        }

        // ---- Track assignment (Signum's queue walk, verbatim in structure) ------------------------------

        const starts = events.filter(a => isStart(a.type));
        const trackId = new Map<string, number>(starts.map(a => [WorkflowNodeGraph.nodeKey(a), 0]));
        const trackCreatedBy = new Map<number, IWorkflowNodeEntity | null>([[0, null]]);
        this.trackId = trackId;
        this.trackCreatedBy = trackCreatedBy;

        const isSplitActivity = (wa: WorkflowActivityEntity): boolean =>
            wa.boundaryTimers.some(bt => bt.type === WorkflowEventType.BoundaryForkTimer);

        const continueExplore = (conn: WorkflowConnectionEntity): boolean => {
            const prev = conn.from;
            const next = conn.to;
            const prevTrackId = trackId.get(WorkflowNodeGraph.nodeKey(prev))!;
            let newTrackId: number;

            if (this.isParallelGateway(prev, WorkflowGatewayDirection.Split)) {
                if (this.isParallelGateway(next, WorkflowGatewayDirection.Join))
                    newTrackId = prevTrackId;
                else {
                    newTrackId = trackCreatedBy.size + 1;
                    trackCreatedBy.set(newTrackId, prev);
                }
            }
            else if ((prev instanceof WorkflowActivityEntity && isSplitActivity(prev))
                || (prev instanceof WorkflowEventEntity && prev.type === WorkflowEventType.BoundaryInterruptingTimer
                    && isSplitActivity(this.getActivity(prev.boundaryOf!)))) {

                if (this.isParallelGateway(next, WorkflowGatewayDirection.Join))
                    newTrackId = prevTrackId;
                else {
                    const activity = prev instanceof WorkflowActivityEntity ? prev
                        : this.getActivity((prev as WorkflowEventEntity).boundaryOf!);

                    const mainTrackIds = [
                        ...this.nextConnections(activity),
                        ...activity.boundaryTimers
                            .filter(a => a.type === WorkflowEventType.BoundaryInterruptingTimer)
                            .flatMap(we => this.nextConnections(we)),
                    ].map(c => trackId.get(WorkflowNodeGraph.nodeKey(c.to))).notNull().distinct();

                    if (mainTrackIds.length > 1)
                        throw new Error(`Activity '${activity}' leads to more than one track`);

                    if (mainTrackIds.length === 1)
                        newTrackId = mainTrackIds[0]!;
                    else {
                        newTrackId = trackCreatedBy.size + 1;
                        trackCreatedBy.set(newTrackId, activity);
                    }
                }
            }
            else if (prev instanceof WorkflowEventEntity && prev.type === WorkflowEventType.BoundaryForkTimer) {
                // Obviously a split activity.
                newTrackId = trackCreatedBy.size + 1;
                trackCreatedBy.set(newTrackId, prev);
            }
            else if (this.isParallelGateway(next, WorkflowGatewayDirection.Join)) {
                const split = trackCreatedBy.get(prevTrackId) ?? null;
                if (split == null) {
                    issues.push({
                        type: WorkflowIssueType.Warning,
                        bpmnElementId: conn.bpmnElementId,
                        message: WorkflowValidationMessage
                            ._0CanNotBeConnectedToAParallelJoinBecauseHasNoPreviousParallelSplit.niceToString(prev),
                    });
                    return false;
                }

                const join = next as WorkflowGatewayEntity;
                const splitType = split instanceof WorkflowGatewayEntity ? split.type
                    : split instanceof WorkflowActivityEntity ? WorkflowGatewayType.Inclusive
                        : undefined;
                if (splitType == null)
                    throw new Error("Unexpected split node " + split);

                if (join.type !== splitType) {
                    const message = WorkflowValidationMessage.Join0OfType1DoesNotMatchWithItsPairTheSplit2OfType3
                        .niceToString(join, Enum.niceName(WorkflowGatewayType, join.type), split,
                            Enum.niceName(WorkflowGatewayType, splitType));
                    addError(issues, split as IWorkflowObjectEntity, message);
                    addError(issues, join, message);
                }

                newTrackId = trackId.get(WorkflowNodeGraph.nodeKey(split))!;
            }
            else
                newTrackId = prevTrackId;

            const nextKey = WorkflowNodeGraph.nodeKey(next);
            if (trackId.has(nextKey)) {
                if (trackId.get(nextKey) !== newTrackId)
                    issues.push({
                        type: WorkflowIssueType.Warning,
                        bpmnElementId: conn.bpmnElementId,
                        message: WorkflowValidationMessage._0Track1CanNotBeConnectedTo2Track3InsteadOfTrack4
                            .niceToString(prev, prevTrackId, next, trackId.get(nextKey), newTrackId),
                    });
                return false;
            }

            trackId.set(nextKey, newTrackId);
            return true;
        };

        const queue: IWorkflowNodeEntity[] = [...starts];
        while (queue.length > 0) {
            const node = queue.shift()!;

            if (node instanceof WorkflowActivityEntity) {
                for (const bt of node.boundaryTimers.filter(a => a.type === WorkflowEventType.BoundaryInterruptingTimer)) {
                    trackId.set(WorkflowNodeGraph.nodeKey(bt), trackId.get(WorkflowNodeGraph.nodeKey(node))!);
                    queue.push(bt);
                }

                for (const bt of node.boundaryTimers.filter(a => a.type === WorkflowEventType.BoundaryForkTimer)) {
                    const newTrackId = trackCreatedBy.size + 1;
                    trackCreatedBy.set(newTrackId, bt);
                    trackId.set(WorkflowNodeGraph.nodeKey(bt), trackId.get(WorkflowNodeGraph.nodeKey(node))!);
                    queue.push(bt);
                }
            }

            for (const con of this.nextConnections(node))
                if (continueExplore(con))
                    queue.push(con.to);
        }

        // ---- Activity + connection rules ---------------------------------------------------------------

        const declaredOptionNames = new Set(activities
            .filter(a => a.type === WorkflowActivityType.Decision)
            .flatMap(d => d.decisionOptions.map(o => o.option.name)));
        const usedOptionNames = new Set(connections
            .filter(a => a.type === ConnectionType.Decision)
            .map(d => d.decisionOptionName));

        const isNormalOrDecision = (type: ConnectionType): boolean =>
            type === ConnectionType.Normal || type === ConnectionType.Decision;

        for (const wa of activities) {
            const fanIn = this.previousConnections(wa).length;
            const fanOut = this.nextConnections(wa).count(v => isNormalOrDecision(v.type));

            if (fanIn === 0)
                addError(issues, wa, WorkflowValidationMessage._0HasNoInputs.niceToString(wa));
            if (fanOut === 0)
                addError(issues, wa, WorkflowValidationMessage._0HasNoOutputs.niceToString(wa));
            if (fanOut > 1)
                addError(issues, wa, WorkflowValidationMessage._0HasMultipleOutputs.niceToString(wa));

            if (fanOut === 1 && wa.type === WorkflowActivityType.Decision) {
                const nextConn = this.nextConnections(wa).single(c => c.type === ConnectionType.Normal);
                if (!(nextConn.to instanceof WorkflowGatewayEntity)
                    || (nextConn.to as WorkflowGatewayEntity).type === WorkflowGatewayType.Parallel)
                    addError(issues, wa, WorkflowValidationMessage
                        .Activity0WithDecisionTypeShouldGoToAnExclusiveOrInclusiveGateways.niceToString(wa));
            }

            const typeNice = Enum.niceName(WorkflowActivityType, wa.type);
            const scriptExceptionNice = Enum.niceName(ConnectionType, ConnectionType.ScriptException);

            if (wa.type === WorkflowActivityType.Script) {
                const scriptException = this.nextConnections(wa)
                    .onlyOrNull((a: WorkflowConnectionEntity) => a.type === ConnectionType.ScriptException);
                if (scriptException == null)
                    addError(issues, wa, WorkflowValidationMessage.Activity0OfType1ShouldHaveExactlyOneConnectionOfType2
                        .niceToString(wa, typeNice, scriptExceptionNice));
            }
            else {
                if (this.nextConnections(wa).some(a => a.type === ConnectionType.ScriptException))
                    addError(issues, wa, WorkflowValidationMessage.Activity0OfType1CanNotHaveConnectionsOfType2
                        .niceToString(wa, typeNice, scriptExceptionNice));
            }

            if (wa.type === WorkflowActivityType.Decision) {
                for (const item of wa.decisionOptions)
                    if (!usedOptionNames.has(item.option.name))
                        addWarning(issues, wa, WorkflowValidationMessage.DecisionOption0IsDeclaredButNeverUsedInAConnection
                            .niceToString(item.option.name));
            }

            if (wa.type === WorkflowActivityType.CallWorkflow || wa.type === WorkflowActivityType.DecompositionWorkflow) {
                if (this.nextConnections(wa).some(a => a.type !== ConnectionType.Normal))
                    addError(issues, wa, WorkflowValidationMessage.Activity0OfType1ShouldHaveExactlyOneConnectionOfType2
                        .niceToString(wa, typeNice, Enum.niceName(ConnectionType, ConnectionType.Normal)));
            }
        }

        for (const wc of connections) {
            if (wc.type === ConnectionType.Decision && (wc.decisionOptionName ?? "") !== ""
                && !declaredOptionNames.has(wc.decisionOptionName!))
                addError(issues, wc, WorkflowValidationMessage.DecisionOptionName0IsNotDeclaredInAnyActivity
                    .niceToString(wc.decisionOptionName));
        }

        if (issues.some(a => a.type === WorkflowIssueType.Error)) {
            this.trackCreatedBy = null;
            this.trackId = null;
        }
    }
}

/** Signum's `WorkflowEntity.HasExpired()` extension, in memory (its `@quoted` twin lives in WorkflowLogic). */
export function hasExpired(w: WorkflowEntity): boolean {
    return w.expirationDate != null && Temporal.PlainDateTime.compare(w.expirationDate, Clock.now) < 0;
}
