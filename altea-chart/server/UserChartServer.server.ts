import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import type { Lite } from "@altea/altea/data/lite";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { ChartPermission } from "../data/ChartPermissions";
import { UserChartEntity } from "../data/UserChart";
import { UserChartLogic } from "./UserChartLogic.server";

// Port of Signum's UserChartController (Signum.Chart/UserChart/UserChartController.cs) — the lookup endpoints
// the UserChart menu / quick-links call. Each asserts ViewCharting server-side (Signum gates charting with
// ChartPermission.ViewCharting; UserChart adds no permission of its own). Mirrors UserQueriesServer.

export namespace UserChartServer {
    export function start(ws: WebBuilder): void {
        ws.get("/api/userChart/forQuery/:queryKey",
            { params: CustomType<{ queryKey: string }>(), res: CustomType<Lite<UserChartEntity>[]>() },
            async (req, res) => {
                await assertAuthorized();
                res.jsonTyped(await UserChartLogic.getUserChartsForQuery(req.params.queryKey));
            });

        ws.get("/api/userChart/forEntityType/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<Lite<UserChartEntity>[]>() },
            async (req, res) => {
                await assertAuthorized();
                res.jsonTyped(await UserChartLogic.getUserChartsForEntityType(req.params.typeName));
            });

        // The QueryEntity row for a query key — the client needs it to build a NEW UserChart's `query` FK
        // (altea has no client QueryEntity fetch; Signum built the lite client-side from its cache). Looked
        // up by KEY directly (see UserQueriesServer's identical note).
        ws.get("/api/userChart/queryEntity/:queryKey",
            { params: CustomType<{ queryKey: string }>(), res: QueryEntity },
            async (req, res) => {
                await assertAuthorized();
                const qe = QueryLogic.tryGetQueryEntityByKey(req.params.queryKey);
                if (qe == null) {
                    res.status(404).json({ error: `Query '${req.params.queryKey}' not found` });
                    return;
                }
                res.jsonTyped(qe);
            });
    }
}

async function assertAuthorized(): Promise<void> {
    if (!(await PermissionAuthLogic.isAuthorized(ChartPermission.ViewCharting)))
        throw new UnauthorizedAccessException(`Not authorized for '${ChartPermission.ViewCharting.key}'`);
}
