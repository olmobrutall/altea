import "@altea/altea/data/globals/arrayExtensions";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { getEntityPack } from "@altea/altea/server/operationServer";
import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import { assertGraphIntegrityAsync } from "@altea/altea/server/graphExplorer";
import { Operations } from "@altea/altea/server/operationLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { parseQueryRequest } from "@altea/altea/server/queryServer";
import type { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { Enum } from "@altea/altea/data/enum";
import type { FilterRequest, ColumnRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import {
    WorkflowEntity, WorkflowModel, WorkflowOperation, WorkflowPermission, WorkflowReplacementModel,
    type IWorkflowNodeEntity,
} from "../data/Workflow";
import {
    ConnectionType, WorkflowActivityEntity, WorkflowConnectionEntity, WorkflowEventEntity, WorkflowGatewayEntity,
} from "../data/WorkflowNodes";
import { CaseActivityEntity } from "../data/CaseActivity";
import { CaseEntity, CaseTagEntity, CaseTagTypeEntity, type ICaseMainEntity } from "../data/Case";
import type {
    CaseActivityMainEntityPair, CaseEntityPack, CaseFlow, CaseFlowEntityPack, EntityPackWithIssues,
    NextConnectionsRequest, WorkflowActivityMonitor, WorkflowActivityMonitorRequest, WorkflowFindNodeRequest,
    WorkflowIssue, WorkflowModelAndIssues, WorkflowScriptRunnerState,
} from "../data/WorkflowDtos";
import { WorkflowLogic, WorkflowIssuesException } from "./WorkflowLogic.server";
import { WorkflowBuilder } from "./WorkflowBuilder.server";
import { CaseActivityLogic } from "./CaseActivityLogic.server";
import { CaseFlowLogic } from "./CaseFlowLogic.server";
import { WorkflowActivityMonitorLogic, type ParsedWorkflowActivityMonitorRequest } from "./WorkflowActivityMonitorLogic.server";
import { WorkflowScriptRunner } from "./WorkflowScriptRunner.server";
import { WorkflowActivityInfo } from "./WorkflowActivityInfo.server";

// Port of Signum.Workflow's WorkflowController.cs.
//
// altea divergences:
//  - `/api/workflow/save` returns the issues in the SUCCESS body, and on a structural error answers 400 with
//    `{ modelState: { workflowIssues: […] } }` — the same channel Signum smuggles them through, but as real
//    JSON rather than a serialized string inside a ModelState entry (the client parses one less layer).
//  - `condition/test` is NOT ported: it compiled a script and ran it against an example entity, and a
//    registered symbol needs no such thing (see data/WorkflowEval.ts).
//  - `healthCheck` is not ported (altea has no health-check surface yet); `scriptRunner/view` reports the
//    same facts to the panel.
//  - Signum's start/stop `Thread.Sleep(1000)` is unnecessary — the runner's state is updated synchronously.

export namespace WorkflowServer {
    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        // ---- A case activity for viewing (the case frame's fetch) -----------------------------------

        ws.get("/api/workflow/fetchForViewing/:caseActivityId",
            { params: CustomType<{ caseActivityId: string }>(), res: CustomType<CaseEntityPack>() },
            async (req, res) => {
                const { caseActivityId } = params<{ caseActivityId: string }>(req);
                const activity = await CaseActivityLogic.retrieveForViewing(
                    liteOf(CaseActivityEntity, caseActivityId));

                // Signum opens a WorkflowActivityInfo scope around the pack build so a view that asks
                // `WorkflowActivityInfo.Current` while rendering sees the activity.
                const pack = await WorkflowActivityInfo.withScope({ caseActivity: activity },
                    () => getEntityPack(activity.case.mainEntity as Entity));

                res.jsonTyped({
                    activity,
                    canExecuteActivity: (await getEntityPack(activity)).canExecute,
                    canExecuteMainEntity: pack.canExecute,
                });
            });

        ws.get("/api/workflow/tags/:caseId",
            { params: CustomType<{ caseId: string }>(), res: CustomType<CaseTagTypeEntity[]>() },
            async (req, res) => {
                const { caseId } = params<{ caseId: string }>(req);
                const lite = liteOf(CaseEntity, caseId);
                res.jsonTyped(await table(CaseTagEntity).filter(a => a.case.is(lite)).map(a => a.tagType).toArray());
            });

        ws.get("/api/workflow/caseFlowPack/:caseActivityId",
            { params: CustomType<{ caseActivityId: string }>(), res: CustomType<CaseFlowEntityPack>() },
            async (req, res) => {
                const { caseActivityId } = params<{ caseActivityId: string }>(req);
                const ca = await retrieve(CaseActivityEntity, idOf(CaseActivityEntity, caseActivityId));
                res.jsonTyped({
                    pack: await getEntityPack(ca.case) as CaseFlowEntityPack["pack"],
                    workflowActivity: ca.workflowActivity,
                });
            });

        // ---- Starting a case -----------------------------------------------------------------------

        ws.get("/api/workflow/starts",
            { res: CustomType<WorkflowEntity[]>() },
            async (_req, res) => {
                res.jsonTyped(await WorkflowLogic.getAllowedStarts(lane => CaseActivityLogic.getActors(lane, null)));
            });

        // ---- The designer --------------------------------------------------------------------------

        ws.get("/api/workflow/workflowModel/:workflowId",
            { params: CustomType<{ workflowId: string }>(), res: CustomType<WorkflowModelAndIssues>() },
            async (req, res) => {
                const { workflowId } = params<{ workflowId: string }>(req);
                const wf = await retrieve(WorkflowEntity, idOf(WorkflowEntity, workflowId));
                const model = await WorkflowLogic.getWorkflowModel(wf);
                const wb = await WorkflowBuilder.create(wf);
                const issues: WorkflowIssue[] = [];
                await wb.validateGraph(issues);
                res.jsonTyped({ model, issues });
            });

        ws.post("/api/workflow/previewChanges/:workflowId",
            {
                params: CustomType<{ workflowId: string }>(),
                req: CustomType<WorkflowModel>(),
                res: CustomType<WorkflowReplacementModel>(),
            },
            async (req, res) => {
                const { workflowId } = params<{ workflowId: string }>(req);
                const wf = await retrieve(WorkflowEntity, idOf(WorkflowEntity, workflowId));
                const model = await req.jsonTyped() as WorkflowModel;
                res.jsonTyped(await WorkflowLogic.previewChanges(wf, model));
            });

        ws.post("/api/workflow/save",
            {
                req: CustomType<{ entity: WorkflowEntity; args: unknown[] }>(),
                res: CustomType<EntityPackWithIssues>(),
            },
            async (req, res) => {
                const issues: WorkflowIssue[] = [];
                const body = await req.jsonTyped() as { entity: WorkflowEntity; args?: unknown[] };
                const args = [...(body.args ?? []), issues];

                try {
                    // Signum's model-binder validation pass, as altea's operationServer does it: the
                    // just-deserialized graph is checked before the operation runs.
                    await assertGraphIntegrityAsync([body.entity], "ServerDeserialization");
                    const entity = await Operations.execute(body.entity, WorkflowOperation.Save, ...args);
                    res.jsonTyped({
                        entityPack: await getEntityPack(entity) as EntityPackWithIssues["entityPack"],
                        issues,
                    });
                } catch (error) {
                    if (error instanceof WorkflowIssuesException) {
                        // Signum serializes the issues into a ModelState entry; altea sends them as JSON on
                        // the same key, which is what the client reads back.
                        res.status(400).jsonTyped({
                            modelState: { workflowIssues: error.issues },
                        } as never);
                        return;
                    }
                    throw error;
                }
            });

        ws.get("/api/workflow/findMainEntityType",
            {
                query: CustomType<{ subString: string; count: string }>(),
                res: CustomType<Lite<TypeEntity>[]>(),
            },
            async (req, res) => {
                const { subString, count } = query<{ subString: string; count: string }>(req);
                // The main-entity types are the ones an app registered with `withWorkflow`.
                const cleanNames = [...CaseActivityLogic.options.keys()];
                const sub = (subString ?? "").toLowerCase();
                const types = await table(TypeEntity)
                    .filter(t => cleanNames.includes(t.cleanName))
                    .toArray();
                res.jsonTyped(types
                    .filter(t => t.cleanName.toLowerCase().includes(sub) || (t.toString() ?? "").toLowerCase().includes(sub))
                    .slice(0, Number(count ?? 5))
                    .map(t => t.toLite()));
            });

        ws.post("/api/workflow/findNode",
            { req: CustomType<WorkflowFindNodeRequest>(), res: CustomType<Lite<IWorkflowNodeEntity>[]>() },
            async (req, res) => {
                const r = await req.jsonTyped() as WorkflowFindNodeRequest;
                const workflow = liteOf(WorkflowEntity, r.workflowId);
                res.jsonTyped(await WorkflowLogic.autocompleteNodes(workflow, r.subString, r.count, r.excludes ?? []));
            });

        ws.post("/api/workflow/nextConnections",
            { req: CustomType<NextConnectionsRequest>(), res: CustomType<Lite<IWorkflowNodeEntity>[]>() },
            async (req, res) => {
                const r = await req.jsonTyped() as NextConnectionsRequest;
                const wa = await retrieve(WorkflowActivityEntity, r.workflowActivity.id!);
                const conns = await WorkflowLogic.nextConnectionsFromCache(wa, r.connectionType);
                res.jsonTyped(conns.map(a => a.to.toLite()));
            });

        // ---- The case-flow diagram ------------------------------------------------------------------

        ws.get("/api/workflow/caseFlow/:caseId",
            { params: CustomType<{ caseId: string }>(), res: CustomType<CaseFlow>() },
            async (req, res) => {
                await assertAuthorized(WorkflowPermission.ViewCaseFlow);
                const { caseId } = params<{ caseId: string }>(req);
                const c = await retrieve(CaseEntity, idOf(CaseEntity, caseId));
                res.jsonTyped(await CaseFlowLogic.getCaseFlow(c));
            });

        // ---- The activity monitor -------------------------------------------------------------------

        ws.post("/api/workflow/activityMonitor",
            {
                req: CustomType<{ workflow: Lite<WorkflowEntity>; filters: FilterRequest[]; columns: ColumnRequest[] }>(),
                res: CustomType<WorkflowActivityMonitor>(),
            },
            async (req, res) => {
                const request = toMonitorRequest(await req.jsonTyped() as WorkflowActivityMonitorRequest);
                res.jsonTyped(await WorkflowActivityMonitorLogic.getWorkflowActivityMonitor(request));
            });

        // ---- The script runner panel ----------------------------------------------------------------

        ws.get("/api/workflow/scriptRunner/view",
            { res: CustomType<WorkflowScriptRunnerState>() },
            async (_req, res) => {
                await assertAuthorized(WorkflowPermission.ViewWorkflowPanel);
                res.jsonTyped(WorkflowScriptRunner.executionState());
            });

        ws.post("/api/workflow/scriptRunner/start",
            { req: CustomType<void>(), res: CustomType<WorkflowScriptRunnerState>() },
            async (_req, res) => {
                await assertAuthorized(WorkflowPermission.ViewWorkflowPanel);
                WorkflowScriptRunner.startRunningScripts();
                res.jsonTyped(WorkflowScriptRunner.executionState());
            });

        ws.post("/api/workflow/scriptRunner/stop",
            { req: CustomType<void>(), res: CustomType<WorkflowScriptRunnerState>() },
            async (_req, res) => {
                await assertAuthorized(WorkflowPermission.ViewWorkflowPanel);
                WorkflowScriptRunner.stop();
                res.jsonTyped(WorkflowScriptRunner.executionState());
            });

        // ---- The contextual-menu helpers ------------------------------------------------------------

        ws.post("/api/workflow/mainEntitiesFromCaseActivities",
            {
                req: CustomType<Lite<CaseActivityEntity>[]>(),
                res: CustomType<CaseActivityMainEntityPair[]>(),
            },
            async (req, res) => {
                const lites = await req.jsonTyped() as Lite<CaseActivityEntity>[];
                const ids = lites.map(a => a.id!);
                const pairs = await table(CaseActivityEntity)
                    .filter(ca => ids.includes(ca.id!))
                    .map(ca => ({ caseActivity: ca.toLite(), mainEntity: ca.case.mainEntity.toLite() }))
                    .toArray();
                res.jsonTyped(pairs as CaseActivityMainEntityPair[]);
            });

        ws.post("/api/workflow/onlyWorkflowActivity",
            {
                req: CustomType<Lite<CaseActivityEntity>[]>(),
                res: CustomType<WorkflowActivityEntity | null>(),
            },
            async (req, res) => {
                const lites = await req.jsonTyped() as Lite<CaseActivityEntity>[];
                const ids = lites.map(a => a.id!);
                const nodes = await table(CaseActivityEntity)
                    .filter(ca => ids.includes(ca.id!))
                    .map(ca => ca.workflowActivity)
                    .distinct()
                    .toArray();

                const only = nodes.onlyOrNull();
                res.jsonTyped(only instanceof WorkflowActivityEntity ? only : null);
            });

        installShutdownHook();
    }

    /**
     * Signum's WorkflowActivityMonitorRequestTS.ToRequest — parse the wire filters / columns into tokens.
     * altea reuses the shared wire → engine translation (queryServer.parseQueryRequest) by building a
     * throwaway request over the CaseActivity query, which is what those tokens are rooted at anyway.
     */
    function toMonitorRequest(body: {
        workflow: Lite<WorkflowEntity>; filters: FilterRequest[]; columns: ColumnRequest[];
    }): ParsedWorkflowActivityMonitorRequest {
        const parsed = parseQueryRequest({
            queryKey: "CaseActivity",
            filters: body.filters ?? [],
            orders: [],
            columns: body.columns ?? [],
            pagination: { mode: "All" },
            groupResults: true,
        } as never);

        return { workflow: body.workflow, filters: parsed.filters, columns: parsed.columns };
    }

    async function assertAuthorized(permission: PermissionSymbol): Promise<void> {
        if (!(await PermissionAuthLogic.isAuthorized(permission)))
            throw new UnauthorizedAccessException(`Not authorized for '${permission.key}'`);
    }

    let shutdownInstalled = false;
    function installShutdownHook(): void {
        if (shutdownInstalled)
            return;
        shutdownInstalled = true;

        const stop = (): void => {
            try {
                WorkflowScriptRunner.stop();
            } catch { /* not running */ }
        };

        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        process.once("beforeExit", stop);
    }
}

function params<T>(req: unknown): T {
    return (req as { params: T }).params;
}

function query<T>(req: unknown): T {
    return (req as { query: T }).query;
}

function liteOf<T extends Entity>(type: new () => T, id: string): Lite<T> {
    // altea's static is `newLite` (Signum's `Type<T>.LiteFromId`).
    return (type as unknown as { newLite(id: unknown): Lite<T> }).newLite(idOf(type, id));
}

function idOf<T extends Entity>(type: new () => T, id: string): never {
    return (type as unknown as { parseId(id: string): never }).parseId(id);
}
