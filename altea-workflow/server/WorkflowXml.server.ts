import "@altea/altea/server";
import "@altea/altea/data/globals/arrayExtensions";
import { table } from "@altea/altea/server/table";
import { Operations } from "@altea/altea/server/operationLogic";
import { Synchronizer } from "@altea/altea/server/sync/synchronizer";
import { isGraphModified } from "@altea/altea/data/changes";
import { Enum } from "@altea/altea/data/enum";
import { Temporal, toInt, type int } from "@altea/altea/data/basics";
import { Lite } from "@altea/altea/data/lite";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { UserAssetsImporter } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import type { IFromXmlContext, IToXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import {
    WorkflowEntity, WorkflowEntity_MainEntityStrategy, WorkflowMainEntityStrategy, WorkflowOperation,
    WorkflowXmlEmbedded, type IWorkflowNodeEntity,
} from "../data/Workflow";
import {
    BootstrapStyle, ButtonOptionEmbedded, ConnectionType, SubWorkflowEmbedded, TimeSpanEmbedded,
    ViewNamePropEmbedded, WorkflowActivityEntity, WorkflowActivityEntity_DecisionOption,
    WorkflowActivityEntity_ViewNameProp, WorkflowActivityOperation, WorkflowActivityType,
    WorkflowConnectionEntity, WorkflowConnectionOperation, WorkflowEventEntity, WorkflowEventOperation,
    WorkflowEventType, WorkflowGatewayDirection, WorkflowGatewayEntity, WorkflowGatewayOperation,
    WorkflowGatewayType, WorkflowLaneEntity, WorkflowLaneEntity_Actor, WorkflowLaneOperation,
    WorkflowPoolEntity, WorkflowPoolOperation, WorkflowScriptPartEmbedded, WorkflowTimerEmbedded,
} from "../data/WorkflowNodes";
import { WorkflowConditionEntity, WorkflowConditionOperation } from "../data/WorkflowCondition";
import { WorkflowActionEntity, WorkflowActionOperation } from "../data/WorkflowAction";
import { WorkflowTimerConditionEntity, WorkflowTimerConditionOperation } from "../data/WorkflowTimerCondition";
import {
    WorkflowScriptEntity, WorkflowScriptOperation, WorkflowScriptRetryStrategyEntity,
    WorkflowScriptRetryStrategyOperation,
} from "../data/WorkflowScript";
import {
    WorkflowActionSymbol, WorkflowConditionSymbol, WorkflowEventTaskActionSymbol,
    WorkflowEventTaskConditionSymbol, WorkflowLaneActorsSymbol, WorkflowScriptSymbol, WorkflowSubEntitiesSymbol,
    WorkflowTimerConditionSymbol,
} from "../data/WorkflowEval";
import { TriggeredOn, WorkflowEventTaskModel } from "../data/WorkflowEventTask";
import { CaseQueries } from "./CaseQueries.server";
import { applyWorkflowEventTaskModel, getWorkflowEventTaskModel } from "./WorkflowBuilder.server";
import { CaseActivityLogic } from "./CaseActivityLogic.server";

// Port of Signum.Workflow's ImportExport/WorkflowImportExport.cs plus the five small `ToXml`/`FromXml` pairs
// that Signum puts on WorkflowCondition / WorkflowAction / WorkflowTimerCondition / WorkflowScript /
// WorkflowScriptRetryStrategy. altea keeps XML off the isomorphic entities, so every one of them registers a
// (de)serializer with UserAssetsImporter — the shape @altea/altea-user-queries established.
//
// The element / attribute names are Signum's, so a workflow exported by a Signum app imports here (and back)
// with two exceptions, both from documented module divergences:
//
//  - an EVAL is a SYMBOL KEY, not a CDATA script. `<Eval><Script>…C#…</Script></Eval>` becomes an
//    `Evaluator="MyApp.SomeCondition"` attribute; `<ActorsEval>`, `<SubEntitiesEval>` and the event task's
//    `<Condition>` / `<Action>` likewise. A Signum file's scripts cannot be imported — there is nothing to
//    compile them with — so importing one FAILS LOUDLY on the first script rather than silently dropping it.
//
//  - a REPLACEMENT cannot be negotiated. Signum's import runs a PREVIEW pass, and when it finds an activity
//    that would be deleted while it still has case activities, it hands the user a WorkflowReplacementModel
//    through `ctx.CustomResolutionModel` and asks where those cases should move. altea's user-asset import
//    engine has no custom-resolution channel (it decides New / Different / Identical only), so such an import
//    THROWS with the offending activities named. The designer's own save path (which does have the
//    replacement dialog — see WorkflowLogic.previewChanges) is unaffected.

const A = "@_"; // fast-xml-parser attribute prefix

// ---- The five simple assets ----------------------------------------------------------------------------
//
// Signum puts a ToXml / FromXml pair on each of these entities; the four NAMED evaluator assets share the
// same three fields (name + mainEntityType + the symbol that replaces Signum's script), so each registration
// is three lines over a shared pair of helpers.

export function registerWorkflowXml(): void {

    UserAssetsImporter.register<WorkflowConditionEntity>({
        elementName: "WorkflowCondition",
        create: () => new WorkflowConditionEntity(),
        load: async guid => (await table(WorkflowConditionEntity).filter(a => a.id == guid).toArray())[0],
        save: async e => { await Operations.execute(e, WorkflowConditionOperation.Save); },
        toXml: e => evaluatorToXml(e.name, e.mainEntityType, e.evaluator),
        fromXml: (e, xml, ctx) => {
            evaluatorFromXml(e, xml, ctx, "WorkflowCondition");
            e.evaluator = resolveSymbol(WorkflowConditionSymbol, str(xml["Evaluator"]), "WorkflowCondition");
        },
    });

    UserAssetsImporter.register<WorkflowActionEntity>({
        elementName: "WorkflowAction",
        create: () => new WorkflowActionEntity(),
        load: async guid => (await table(WorkflowActionEntity).filter(a => a.id == guid).toArray())[0],
        save: async e => { await Operations.execute(e, WorkflowActionOperation.Save); },
        toXml: e => evaluatorToXml(e.name, e.mainEntityType, e.executor),
        fromXml: (e, xml, ctx) => {
            evaluatorFromXml(e, xml, ctx, "WorkflowAction");
            e.executor = resolveSymbol(WorkflowActionSymbol, str(xml["Evaluator"]), "WorkflowAction");
        },
    });

    UserAssetsImporter.register<WorkflowTimerConditionEntity>({
        elementName: "WorkflowTimerCondition",
        create: () => new WorkflowTimerConditionEntity(),
        load: async guid => (await table(WorkflowTimerConditionEntity).filter(a => a.id == guid).toArray())[0],
        save: async e => { await Operations.execute(e, WorkflowTimerConditionOperation.Save); },
        toXml: e => evaluatorToXml(e.name, e.mainEntityType, e.evaluator),
        fromXml: (e, xml, ctx) => {
            evaluatorFromXml(e, xml, ctx, "WorkflowTimerCondition");
            e.evaluator = resolveSymbol(WorkflowTimerConditionSymbol, str(xml["Evaluator"]), "WorkflowTimerCondition");
        },
    });

    UserAssetsImporter.register<WorkflowScriptEntity>({
        elementName: "WorkflowScript",
        create: () => new WorkflowScriptEntity(),
        load: async guid => (await table(WorkflowScriptEntity).filter(a => a.id == guid).toArray())[0],
        save: async e => { await Operations.execute(e, WorkflowScriptOperation.Save); },
        toXml: e => evaluatorToXml(e.name, e.mainEntityType, e.executor),
        fromXml: (e, xml, ctx) => {
            evaluatorFromXml(e, xml, ctx, "WorkflowScript");
            e.executor = resolveSymbol(WorkflowScriptSymbol, str(xml["Evaluator"]), "WorkflowScript");
        },
    });

    UserAssetsImporter.register<WorkflowScriptRetryStrategyEntity>({
        elementName: "WorkflowScriptRetryStrategy",
        create: () => new WorkflowScriptRetryStrategyEntity(),
        load: async guid => (await table(WorkflowScriptRetryStrategyEntity).filter(a => a.id == guid).toArray())[0],
        save: async e => { await Operations.execute(e, WorkflowScriptRetryStrategyOperation.Save); },
        toXml: e => ({ [A + "Rule"]: e.rule }),
        fromXml: (e, xml) => { e.rule = str(xml["Rule"])!; },
    });

    registerWorkflowAsset();
}

function evaluatorToXml(name: string, mainEntityType: TypeEntity, symbol: { key: string }): Record<string, unknown> {
    return {
        [A + "Name"]: name,
        [A + "MainEntityType"]: mainEntityType.cleanName,
        [A + "Evaluator"]: symbol.key,
    };
}

function evaluatorFromXml(entity: { name: string; mainEntityType: TypeEntity },
    xml: Record<string, unknown>, ctx: IFromXmlContext, elementName: string): void {
    entity.name = str(xml["Name"])!;
    // `ctx.getType` answers a Lite; the field is the full row, so it is retrieved through the lite's own
    // entity (the importer fills it fat for exactly this).
    const lite = ctx.getType(str(xml["MainEntityType"])!);
    entity.mainEntityType = lite.entityOrNull ?? (lite as unknown as { entity: TypeEntity }).entity;
    assertNoScript(xml, elementName);
}

/** A Signum file carries C# in `<Eval><Script>` — there is nothing here to compile it with, so say so. */
function assertNoScript(xml: Record<string, unknown>, elementName: string): void {
    if (xml["Eval"] != null)
        throw new Error(elementName + ": this file was exported by Signum and carries a compiled C# "
            + "<Eval><Script>. altea replaces evals with code-declared symbols (see data/WorkflowEval.ts), so "
            + "the script cannot be imported — register a symbol for it and set Evaluator=\"<its key>\".");
}

function resolveSymbol<S>(symbolType: new () => S, key: string | undefined, what: string): S {
    if (key == null)
        throw new Error(what + ": no Evaluator attribute (the key of a registered symbol)");
    return SymbolLogic.toSymbol(symbolType as never, key) as unknown as S;
}

// ---- The workflow asset -------------------------------------------------------------------------------

function registerWorkflowAsset(): void {
    UserAssetsImporter.register<WorkflowEntity>({
        elementName: "Workflow",
        create: () => new WorkflowEntity(),
        load: async guid => (await table(WorkflowEntity).filter(a => a.id == guid).toArray())[0],
        save: async w => { await Operations.execute(w, WorkflowOperation.Save); },
        toXml: workflowToXml,
        fromXml: workflowFromXml,
    });
}

async function workflowToXml(workflow: WorkflowEntity, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const pools = await CaseQueries.workflowPools(workflow).toArray();
    const lanes = (await Promise.all(pools.map(p => CaseQueries.poolLanes(p).toArray()))).flat();
    const activities = await CaseQueries.workflowActivities(workflow).toArray();
    const events = await CaseQueries.workflowEvents(workflow).toArray();
    const gateways = await CaseQueries.workflowGateways(workflow).toArray();
    const connections = await CaseQueries.workflowConnections(workflow).toArray();

    // The boundary-timer list is not persisted (see data/WorkflowNodes.ts) — fill it for `BoundaryOf`.
    const activityByKey = new Map(activities.map(a => [a.toLite().key(), a]));

    const o: Record<string, unknown> = {};
    o[A + "Name"] = workflow.name;
    o[A + "MainEntityType"] = workflow.mainEntityType.cleanName;
    o[A + "MainEntityStrategies"] = workflow.mainEntityStrategies
        .map(s => Enum.toName(WorkflowMainEntityStrategy, s.strategy)).join(",");
    if (workflow.expirationDate != null)
        o[A + "ExpirationDate"] = workflow.expirationDate.toString();

    o["Pool"] = pools.map(p => ({
        [A + "BpmnElementId"]: p.bpmnElementId,
        [A + "Name"]: p.name,
        "DiagramXml": { "#text": p.xml.diagramXml },
    }));

    o["Lane"] = await Promise.all(lanes.map(async la => {
        const x: Record<string, unknown> = {
            [A + "BpmnElementId"]: la.bpmnElementId,
            [A + "Name"]: la.name,
            [A + "Pool"]: la.pool.bpmnElementId,
        };
        if (la.actors.length > 0)
            x["Actors"] = { Actor: la.actors.map(a => ({ "#text": a.actor.key() })) };
        if (la.actorsEvaluator != null)
            x[A + "ActorsEvaluator"] = la.actorsEvaluator.key;
        if (la.useActorEvalForStart)
            x["UseActorEvalForStart"] = true;
        if (la.combineActorAndActorEvalWhenContinuing)
            x["CombineActorAndActorEvalWhenContinuing"] = true;
        x["DiagramXml"] = { "#text": la.xml.diagramXml };
        return x;
    }));

    o["Activity"] = await Promise.all(activities.map(async a => {
        const x: Record<string, unknown> = {
            [A + "BpmnElementId"]: a.bpmnElementId,
            [A + "Lane"]: a.lane.bpmnElementId,
            [A + "Name"]: a.name,
            [A + "Type"]: Enum.toName(WorkflowActivityType, a.type),
        };
        if (a.requiresOpen) x[A + "RequiresOpen"] = true;
        if (a.estimatedDuration != null) x[A + "EstimatedDuration"] = a.estimatedDuration;
        if ((a.viewName ?? "") !== "") x[A + "ViewName"] = a.viewName;
        if ((a.comments ?? "") !== "") x["Comments"] = a.comments;
        if (a.viewNameProps.length > 0)
            x["ViewNameProps"] = {
                ViewNameProp: a.viewNameProps.map(p => ({
                    [A + "Name"]: p.prop.name,
                    "#text": p.prop.expression ?? "",
                })),
            };
        if (a.decisionOptions.length > 0)
            x["DecisionOptions"] = { DecisionOption: a.decisionOptions.map(d => buttonOptionXml(d.option)) };
        if (a.customNextButton != null)
            x["CustomNextButton"] = buttonOptionXml(a.customNextButton);
        if ((a.userHelp ?? "") !== "")
            x["UserHelp"] = { "#text": a.userHelp };
        if (a.subWorkflow != null)
            x["SubWorkflow"] = {
                [A + "Workflow"]: a.subWorkflow.workflow.is(workflow)
                    ? String(workflow.id)
                    : ctx.include(a.subWorkflow.workflow),
                [A + "SubEntitiesEvaluator"]: a.subWorkflow.subEntitiesEvaluator.key,
            };
        if (a.script != null) {
            const script = await ctx.retrieveLite(a.script.script);
            const s: Record<string, unknown> = { [A + "Script"]: ctx.include(script) };
            if (a.script.retryStrategy != null)
                s[A + "RetryStrategy"] = ctx.include(a.script.retryStrategy);
            x["Script"] = s;
        }
        x["DiagramXml"] = { "#text": a.xml.diagramXml };
        return x;
    }));

    o["Gateway"] = gateways.map(g => {
        const x: Record<string, unknown> = { [A + "BpmnElementId"]: g.bpmnElementId };
        if ((g.name ?? "") !== "") x[A + "Name"] = g.name;
        x[A + "Lane"] = g.lane.bpmnElementId;
        x[A + "Type"] = Enum.toName(WorkflowGatewayType, g.type);
        x[A + "Direction"] = Enum.toName(WorkflowGatewayDirection, g.direction);
        x["DiagramXml"] = { "#text": g.xml.diagramXml };
        return x;
    });

    o["Event"] = await Promise.all(events.map(async e => {
        const x: Record<string, unknown> = { [A + "BpmnElementId"]: e.bpmnElementId };
        if ((e.name ?? "") !== "") x[A + "Name"] = e.name;
        x[A + "Lane"] = e.lane.bpmnElementId;
        x[A + "Type"] = Enum.toName(WorkflowEventType, e.type);
        if ((e.decisionOptionName ?? "") !== "") x[A + "DecisionOptionName"] = e.decisionOptionName;
        if (e.timer != null) {
            const t: Record<string, unknown> = {};
            if (e.timer.duration != null) t["Duration"] = timeSpanXml(e.timer.duration);
            if (e.timer.condition != null)
                t[A + "Condition"] = ctx.include(await ctx.retrieveLite(e.timer.condition));
            if (e.timer.avoidExecuteConditionByTimer) t["AvoidExecuteConditionByTimer"] = true;
            x["Timer"] = t;
        }
        if (e.boundaryOf != null)
            x[A + "BoundaryOf"] = activityByKey.get(e.boundaryOf.key())!.bpmnElementId;
        x["DiagramXml"] = { "#text": e.xml.diagramXml };

        const task = await getWorkflowEventTaskModel(e);
        if (task != null) {
            const m: Record<string, unknown> = {
                [A + "Suspended"]: task.suspended,
                [A + "TriggeredOn"]: Enum.toName(TriggeredOn, task.triggeredOn),
            };
            if (task.rule != null)
                m[A + "Rule"] = ctx.include(task.rule as never);
            if (task.condition != null)
                m[A + "Condition"] = task.condition.key;
            if (task.action != null)
                m[A + "Action"] = task.action.key;
            x["WorkflowEventTaskModel"] = m;
        }
        return x;
    }));

    o["Connection"] = connections.map(c => {
        const x: Record<string, unknown> = { [A + "BpmnElementId"]: c.bpmnElementId };
        if ((c.name ?? "") !== "") x[A + "Name"] = c.name;
        x[A + "Type"] = Enum.toName(ConnectionType, c.type);
        x[A + "From"] = c.from.bpmnElementId;
        x[A + "To"] = c.to.bpmnElementId;
        if (c.decisionOptionName != null) x[A + "CustomDecisionName"] = c.decisionOptionName;
        if (c.condition != null) x[A + "Condition"] = ctx.include(c.condition.entityOrNull ?? c.condition as never);
        if (c.action != null) x[A + "Action"] = ctx.include(c.action.entityOrNull ?? c.action as never);
        if (c.order != null) x[A + "Order"] = c.order;
        x["DiagramXml"] = { "#text": c.xml.diagramXml };
        return x;
    });

    return o;
}

function buttonOptionXml(b: ButtonOptionEmbedded): Record<string, unknown> {
    return {
        [A + "Name"]: b.name,
        [A + "Style"]: Enum.toName(BootstrapStyle, b.style),
        [A + "WithConfirmation"]: b.withConfirmation,
    };
}

function timeSpanXml(t: TimeSpanEmbedded): Record<string, unknown> {
    return {
        [A + "Days"]: t.days,
        [A + "Hours"]: t.hours,
        [A + "Minutes"]: t.minutes,
        [A + "Seconds"]: t.seconds,
    };
}

// ---- Import -------------------------------------------------------------------------------------------

async function workflowFromXml(workflow: WorkflowEntity, xml: Record<string, unknown>, ctx: IFromXmlContext): Promise<void> {
    workflow.name = str(xml["Name"])!;
    const mainEntityTypeLite = ctx.getType(str(xml["MainEntityType"])!);
    workflow.mainEntityType = mainEntityTypeLite.entityOrNull
        ?? (mainEntityTypeLite as unknown as { entity: TypeEntity }).entity;

    const strategies = (str(xml["MainEntityStrategies"]) ?? "").split(",").map(s => s.trim()).filter(s => s !== "");
    workflow.mainEntityStrategies = strategies.map(s => WorkflowEntity_MainEntityStrategy.create({
        strategy: Enum.toValue(WorkflowMainEntityStrategy, s as never) as WorkflowMainEntityStrategy,
    }));

    const exp = str(xml["ExpirationDate"]);
    workflow.expirationDate = exp == null ? null : Temporal.PlainDateTime.from(exp);

    if (ctx.isPreview)
        return; // a preview only reports whether the asset differs; nothing is written.

    if (workflow.isNew)
        await workflow.save();

    // The existing graph, keyed by bpmn element id (Signum's six dictionaries).
    const pools = new Map((await CaseQueries.workflowPools(workflow).toArray()).map(a => [a.bpmnElementId, a]));
    const lanes = new Map((await Promise.all([...pools.values()].map(p => CaseQueries.poolLanes(p).toArray())))
        .flat().map(a => [a.bpmnElementId, a]));
    const activities = new Map((await CaseQueries.workflowActivities(workflow).toArray()).map(a => [a.bpmnElementId, a]));
    const events = new Map((await CaseQueries.workflowEvents(workflow).toArray()).map(a => [a.bpmnElementId, a]));
    const gateways = new Map((await CaseQueries.workflowGateways(workflow).toArray()).map(a => [a.bpmnElementId, a]));
    const connections = new Map((await CaseQueries.workflowConnections(workflow).toArray()).map(a => [a.bpmnElementId, a]));

    // Signum nests six `using (Sync(...))` blocks so every CREATE happens outermost-first and every DELETE
    // innermost-first. altea does the same with two explicit passes per level, in the same order.
    const poolXmls = byBpmnId(xml["Pool"]);
    const laneXmls = byBpmnId(xml["Lane"]);
    const activityXmls = byBpmnId(xml["Activity"]);
    const eventXmls = byBpmnId(xml["Event"]);
    const gatewayXmls = byBpmnId(xml["Gateway"]);
    const connectionXmls = byBpmnId(xml["Connection"]);

    // ---- create / update, top down ----
    await Synchronizer.synchronizeAsync(poolXmls, pools,
        async (id, x) => {
            const p = WorkflowPoolEntity.create({ bpmnElementId: id, workflow, xml: WorkflowXmlEmbedded.create({}) });
            setPool(p, x);
            await Operations.execute(p, WorkflowPoolOperation.Save);
            pools.set(id, p);
        }, undefined,
        async (_id, x, p) => {
            setPool(p, x);
            if (isGraphModified(p))
                await Operations.execute(p, WorkflowPoolOperation.Save);
        });

    await Synchronizer.synchronizeAsync(laneXmls, lanes,
        async (id, x) => {
            const l = WorkflowLaneEntity.create({ bpmnElementId: id, xml: WorkflowXmlEmbedded.create({}) });
            setLane(l, x, pools, ctx);
            await Operations.execute(l, WorkflowLaneOperation.Save);
            lanes.set(id, l);
        }, undefined,
        async (_id, x, l) => {
            setLane(l, x, pools, ctx);
            if (isGraphModified(l))
                await Operations.execute(l, WorkflowLaneOperation.Save);
        });

    await Synchronizer.synchronizeAsync(activityXmls, activities,
        async (id, x) => {
            const a = WorkflowActivityEntity.create({ bpmnElementId: id, xml: WorkflowXmlEmbedded.create({}) });
            await setActivity(a, x, lanes, workflow, ctx);
            await Operations.execute(a, WorkflowActivityOperation.Save);
            activities.set(id, a);
        }, undefined,
        async (_id, x, a) => {
            await setActivity(a, x, lanes, workflow, ctx);
            if (isGraphModified(a))
                await Operations.execute(a, WorkflowActivityOperation.Save);
        });

    await Synchronizer.synchronizeAsync(eventXmls, events,
        async (id, x) => {
            const e = WorkflowEventEntity.create({ bpmnElementId: id, xml: WorkflowXmlEmbedded.create({}) });
            setEvent(e, x, lanes, activities, ctx);
            await Operations.execute(e, WorkflowEventOperation.Save);
            events.set(id, e);
            await applyEventTaskModel(e, x, ctx);
        }, undefined,
        async (_id, x, e) => {
            setEvent(e, x, lanes, activities, ctx);
            if (isGraphModified(e))
                await Operations.execute(e, WorkflowEventOperation.Save);
            await applyEventTaskModel(e, x, ctx);
        });

    await Synchronizer.synchronizeAsync(gatewayXmls, gateways,
        async (id, x) => {
            const g = WorkflowGatewayEntity.create({ bpmnElementId: id, xml: WorkflowXmlEmbedded.create({}) });
            setGateway(g, x, lanes);
            await Operations.execute(g, WorkflowGatewayOperation.Save);
            gateways.set(id, g);
        }, undefined,
        async (_id, x, g) => {
            setGateway(g, x, lanes);
            if (isGraphModified(g))
                await Operations.execute(g, WorkflowGatewayOperation.Save);
        });

    const nodeOf = (bpmnElementId: string): IWorkflowNodeEntity => {
        const n = activities.get(bpmnElementId) ?? events.get(bpmnElementId) ?? gateways.get(bpmnElementId);
        if (n == null)
            throw new Error("No workflow node found with BpmnElementId: " + bpmnElementId);
        return n;
    };

    await Synchronizer.synchronizeAsync(connectionXmls, connections,
        async (id, x) => {
            const c = WorkflowConnectionEntity.create({
                bpmnElementId: id, type: ConnectionType.Normal, xml: WorkflowXmlEmbedded.create({}),
            });
            setConnection(c, x, nodeOf, ctx);
            await Operations.execute(c, WorkflowConnectionOperation.Save);
            connections.set(id, c);
        }, undefined,
        async (_id, x, c) => {
            setConnection(c, x, nodeOf, ctx);
            if (isGraphModified(c))
                await Operations.execute(c, WorkflowConnectionOperation.Save);
        });

    // ---- delete, bottom up ----
    await Synchronizer.synchronizeAsync(connectionXmls, connections, undefined,
        async (id, c) => { connections.delete(id); await Operations.delete(c, WorkflowConnectionOperation.Delete); },
        undefined);

    await Synchronizer.synchronizeAsync(gatewayXmls, gateways, undefined,
        async (id, g) => { gateways.delete(id); await Operations.delete(g, WorkflowGatewayOperation.Delete); },
        undefined);

    await Synchronizer.synchronizeAsync(eventXmls, events, undefined,
        async (id, e) => {
            await assertNoCaseActivities(e);
            events.delete(id);
            await Operations.delete(e, WorkflowEventOperation.Delete);
        }, undefined);

    await Synchronizer.synchronizeAsync(activityXmls, activities, undefined,
        async (id, a) => {
            await assertNoCaseActivities(a);
            activities.delete(id);
            await Operations.delete(a, WorkflowActivityOperation.Delete);
        }, undefined);

    await Synchronizer.synchronizeAsync(laneXmls, lanes, undefined,
        async (id, l) => { lanes.delete(id); await Operations.delete(l, WorkflowLaneOperation.Delete); },
        undefined);

    await Synchronizer.synchronizeAsync(poolXmls, pools, undefined,
        async (id, p) => { pools.delete(id); await Operations.delete(p, WorkflowPoolOperation.Delete); },
        undefined);

    // Signum finishes with `workflow.Execute(WorkflowOperation.Save)` when anything changed; the importer
    // calls the registered save for us, so this only refreshes the redundant full-diagram copy.
    await Operations.execute(workflow, WorkflowOperation.Save);
}

/** altea divergence (see the header): an import cannot negotiate a replacement, so it refuses instead. */
async function assertNoCaseActivities(node: IWorkflowNodeEntity): Promise<void> {
    if (await CaseActivityLogic.hasCaseActivities(node))
        throw new Error(`Importing this workflow would delete '${node}', which still has case activities. `
            + `altea's user-asset import has no channel to ask where they should move (Signum uses a `
            + `WorkflowReplacementModel), so the import is refused. Move or finish those cases first, or `
            + `apply the change through the workflow designer, which does offer the replacement dialog.`);
}

function setPool(p: WorkflowPoolEntity, x: Record<string, unknown>): void {
    p.name = str(x["Name"])!;
    setDiagramXml(p, x);
}

function setLane(l: WorkflowLaneEntity, x: Record<string, unknown>, pools: Map<string, WorkflowPoolEntity>,
    ctx: IFromXmlContext): void {
    l.name = str(x["Name"])!;
    l.pool = mapGet(pools, str(x["Pool"])!, "Pool");

    const actorKeys = elements(x["Actors"], "Actor").map(a => str(a["#text"]) ?? String(a)).filter(k => k !== "");
    l.actors = actorKeys.map(k => ctx.parseLite(k)).notNull()
        .map(lite => WorkflowLaneEntity_Actor.create({ actor: lite }));

    l.actorsEvaluator = optionalSymbol(WorkflowLaneActorsSymbol, str(x["ActorsEvaluator"]), "Lane.ActorsEvaluator", x, "ActorsEval");
    l.useActorEvalForStart = bool(x["UseActorEvalForStart"]) ?? false;
    l.combineActorAndActorEvalWhenContinuing = bool(x["CombineActorAndActorEvalWhenContinuing"]) ?? false;
    setDiagramXml(l, x);
}

async function setActivity(a: WorkflowActivityEntity, x: Record<string, unknown>,
    lanes: Map<string, WorkflowLaneEntity>, workflow: WorkflowEntity, ctx: IFromXmlContext): Promise<void> {
    a.lane = mapGet(lanes, str(x["Lane"])!, "Lane");
    a.name = str(x["Name"])!;
    a.type = Enum.toValue(WorkflowActivityType, str(x["Type"])! as never) as WorkflowActivityType;
    a.comments = str(x["Comments"]) ?? null;
    a.requiresOpen = bool(x["RequiresOpen"]) ?? false;
    a.estimatedDuration = num(x["EstimatedDuration"]) ?? null;
    a.viewName = str(x["ViewName"]) ?? null;

    a.viewNameProps = elements(x["ViewNameProps"], "ViewNameProp").map(p =>
        WorkflowActivityEntity_ViewNameProp.create({
            prop: ViewNamePropEmbedded.create({ name: str(p["Name"])!, expression: str(p["#text"]) ?? null }),
        }));

    a.decisionOptions = elements(x["DecisionOptions"], "DecisionOption").map(d =>
        WorkflowActivityEntity_DecisionOption.create({ option: buttonOptionFromXml(d) }));

    a.customNextButton = x["CustomNextButton"] == null ? null
        : buttonOptionFromXml(x["CustomNextButton"] as Record<string, unknown>);

    a.userHelp = str((x["UserHelp"] as Record<string, unknown> | undefined)?.["#text"]) ?? str(x["UserHelp"]) ?? null;

    const sub = x["SubWorkflow"] as Record<string, unknown> | undefined;
    a.subWorkflow = sub == null ? null : SubWorkflowEmbedded.create({
        workflow: String(workflow.id) === str(sub["Workflow"])
            ? workflow
            : ctx.getEntity(str(sub["Workflow"])!) as unknown as WorkflowEntity,
        subEntitiesEvaluator: resolveSymbol(WorkflowSubEntitiesSymbol, str(sub["SubEntitiesEvaluator"]),
            "Activity.SubWorkflow"),
    });

    const script = x["Script"] as Record<string, unknown> | undefined;
    a.script = script == null ? null : WorkflowScriptPartEmbedded.create({
        script: (ctx.getEntity(str(script["Script"])!) as unknown as WorkflowScriptEntity).toLite(),
        retryStrategy: script["RetryStrategy"] == null ? null
            : ctx.getEntity(str(script["RetryStrategy"])!) as unknown as WorkflowScriptRetryStrategyEntity,
    });

    setDiagramXml(a, x);
}

function setEvent(e: WorkflowEventEntity, x: Record<string, unknown>, lanes: Map<string, WorkflowLaneEntity>,
    activities: Map<string, WorkflowActivityEntity>, ctx: IFromXmlContext): void {
    e.name = str(x["Name"]) ?? null;
    e.lane = mapGet(lanes, str(x["Lane"])!, "Lane");
    e.type = Enum.toValue(WorkflowEventType, str(x["Type"])! as never) as WorkflowEventType;
    e.decisionOptionName = str(x["DecisionOptionName"]) ?? null;

    const timer = x["Timer"] as Record<string, unknown> | undefined;
    e.timer = timer == null ? null : WorkflowTimerEmbedded.create({
        duration: timer["Duration"] == null ? null
            : timeSpanFromXml(timer["Duration"] as Record<string, unknown>),
        condition: timer["Condition"] == null ? null
            : (ctx.getEntity(str(timer["Condition"])!) as unknown as WorkflowTimerConditionEntity).toLite(),
        avoidExecuteConditionByTimer: bool(timer["AvoidExecuteConditionByTimer"]) ?? false,
    });

    e.boundaryOf = x["BoundaryOf"] == null ? null
        : mapGet(activities, str(x["BoundaryOf"])!, "Activity").toLite();

    setDiagramXml(e, x);
}

function setGateway(g: WorkflowGatewayEntity, x: Record<string, unknown>, lanes: Map<string, WorkflowLaneEntity>): void {
    g.name = str(x["Name"]) ?? null;
    g.lane = mapGet(lanes, str(x["Lane"])!, "Lane");
    g.type = Enum.toValue(WorkflowGatewayType, str(x["Type"])! as never) as WorkflowGatewayType;
    g.direction = Enum.toValue(WorkflowGatewayDirection, str(x["Direction"])! as never) as WorkflowGatewayDirection;
    setDiagramXml(g, x);
}

function setConnection(c: WorkflowConnectionEntity, x: Record<string, unknown>,
    nodeOf: (id: string) => IWorkflowNodeEntity, ctx: IFromXmlContext): void {
    c.name = str(x["Name"]) ?? null;
    c.decisionOptionName = str(x["CustomDecisionName"]) ?? null;
    c.type = Enum.toValue(ConnectionType, str(x["Type"])! as never) as ConnectionType;
    c.from = nodeOf(str(x["From"])!);
    c.to = nodeOf(str(x["To"])!);
    c.condition = x["Condition"] == null ? null
        : (ctx.getEntity(str(x["Condition"])!) as unknown as WorkflowConditionEntity).toLite();
    c.action = x["Action"] == null ? null
        : (ctx.getEntity(str(x["Action"])!) as unknown as WorkflowActionEntity).toLite();
    const order = num(x["Order"]);
    c.order = order == null ? null : toInt(order);
    setDiagramXml(c, x);
}

async function applyEventTaskModel(e: WorkflowEventEntity, x: Record<string, unknown>, ctx: IFromXmlContext): Promise<void> {
    const m = x["WorkflowEventTaskModel"] as Record<string, unknown> | undefined;
    if (m == null)
        return;

    const model = WorkflowEventTaskModel.create({
        suspended: bool(m["Suspended"]) ?? false,
        triggeredOn: Enum.toValue(TriggeredOn, str(m["TriggeredOn"])! as never) as TriggeredOn,
        rule: m["Rule"] == null ? null : ctx.getEntity(str(m["Rule"])!) as never,
        condition: optionalSymbol(WorkflowEventTaskConditionSymbol, str(m["Condition"]),
            "WorkflowEventTaskModel.Condition", m, "Condition"),
        action: optionalSymbol(WorkflowEventTaskActionSymbol, str(m["Action"]),
            "WorkflowEventTaskModel.Action", m, "Action"),
    });

    await applyWorkflowEventTaskModel(e, model);
}

function buttonOptionFromXml(x: Record<string, unknown>): ButtonOptionEmbedded {
    return ButtonOptionEmbedded.create({
        name: str(x["Name"])!,
        style: Enum.toValue(BootstrapStyle, str(x["Style"])! as never) as BootstrapStyle,
        withConfirmation: bool(x["WithConfirmation"]) ?? false,
    });
}

function timeSpanFromXml(x: Record<string, unknown>): TimeSpanEmbedded {
    return TimeSpanEmbedded.create({
        days: toInt(num(x["Days"]) ?? 0),
        hours: toInt(num(x["Hours"]) ?? 0),
        minutes: toInt(num(x["Minutes"]) ?? 0),
        seconds: toInt(num(x["Seconds"]) ?? 0),
    });
}

function setDiagramXml(entity: { xml: WorkflowXmlEmbedded }, x: Record<string, unknown>): void {
    const value = str((x["DiagramXml"] as Record<string, unknown> | undefined)?.["#text"]) ?? str(x["DiagramXml"]);
    if (value == null)
        throw new Error("A workflow object without its DiagramXml cannot be imported");
    entity.xml ??= WorkflowXmlEmbedded.create({});
    if (entity.xml.diagramXml !== value)
        entity.xml.diagramXml = value;
}

/**
 * A symbol reference that may be ABSENT — but a Signum-exported script in its place is an error, not a
 * silent null (the divergence the header explains).
 */
function optionalSymbol<S>(symbolType: new () => S, key: string | undefined,
    what: string, container: Record<string, unknown>, scriptElementName: string): S | null {
    if (key != null)
        return SymbolLogic.toSymbol(symbolType as never, key) as unknown as S;

    if (container[scriptElementName] != null)
        throw new Error(`${what}: this file carries a compiled C# script where altea expects the KEY of a `
            + `registered symbol (see data/WorkflowEval.ts).`);

    return null;
}

// ---- fast-xml-parser helpers ---------------------------------------------------------------------------

function byBpmnId(value: unknown): Map<string, Record<string, unknown>> {
    return new Map(asArray(value).map(x => [str(x["BpmnElementId"])!, x]));
}

function asArray(value: unknown): Record<string, unknown>[] {
    if (value == null)
        return [];
    return (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
}

function elements(container: unknown, name: string): Record<string, unknown>[] {
    if (container == null)
        return [];
    const inner = (container as Record<string, unknown>)[name];
    return asArray(inner);
}

function str(value: unknown): string | undefined {
    return value == null ? undefined : String(value);
}

function num(value: unknown): number | undefined {
    return value == null ? undefined : Number(value);
}

function bool(value: unknown): boolean | undefined {
    if (value == null)
        return undefined;
    return value === true || String(value).toLowerCase() === "true";
}

function mapGet<V>(map: Map<string, V>, key: string, what: string): V {
    const value = map.get(key);
    if (value == null)
        throw new Error(`${what} '${key}' not found`);
    return value;
}
