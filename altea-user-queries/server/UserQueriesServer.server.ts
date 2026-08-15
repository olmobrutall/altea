import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import type { Lite } from "@altea/altea/data/lite";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { UserQueryEntity, UserQueryPermission } from "../data/UserQuery";
import { UserQueriesLogic } from "./UserQueriesLogic.server";

// Port of Signum's UserQueryController (Signum.UserQueries/UserQueryController.cs) — the lookup endpoints the
// UserQueryMenu / quick-links call. Each asserts ViewUserQuery server-side. (Signum's `translated` endpoint
// is dropped: altea carries the display fields on the custom lite — see UserQueryLite.)

export namespace UserQueriesServer {
    export function start(ws: WebBuilder): void {
        ws.get("/api/userQueries/forQuery/:queryKey",
            { params: CustomType<{ queryKey: string }>(), res: CustomType<Lite<UserQueryEntity>[]>() },
            async (req, res) => {
                await assertAuthorized();
                res.jsonTyped(await UserQueriesLogic.getUserQueriesForQuery(req.params.queryKey));
            });

        ws.get("/api/userQueries/forQueryAppendFilters/:queryKey",
            { params: CustomType<{ queryKey: string }>(), res: CustomType<Lite<UserQueryEntity>[]>() },
            async (req, res) => {
                await assertAuthorized();
                res.jsonTyped(await UserQueriesLogic.getUserQueriesForQueryAppendFilters(req.params.queryKey));
            });

        ws.get("/api/userQueries/forEntityType/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<Lite<UserQueryEntity>[]>() },
            async (req, res) => {
                await assertAuthorized();
                res.jsonTyped(await UserQueriesLogic.getUserQueriesForEntityType(req.params.typeName));
            });

        // The QueryEntity row for a query key — the client needs it to build a NEW UserQuery's `query` FK
        // (altea has no client QueryEntity fetch; Signum built the lite client-side from its cache). Looked
        // up by KEY directly: entity-type queries (e.g. "Order") are seeded as QueryEntity rows but NOT in
        // queryNamesByKey (which toQueryName reads — they resolve on demand via resolveCleanType), so
        // tryGetQueryEntityByKey is the right accessor.
        ws.get("/api/userQueries/queryEntity/:queryKey",
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
    if (!(await PermissionAuthLogic.isAuthorized(UserQueryPermission.ViewUserQuery)))
        throw new UnauthorizedAccessException(`Not authorized for '${UserQueryPermission.ViewUserQuery.key}'`);
}
