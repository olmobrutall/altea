import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import type { Lite } from "@altea/altea/data/lite";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { UserAssetServer } from "@altea/altea-user-assets/server/UserAssetServer";
import { DashboardEntity, DashboardPermission } from "../data/Dashboard";
import type { DashboardWithCachedQueries } from "../data/CachedQuery";
import { DashboardLogic } from "./DashboardLogic";

// Port of Signum's DashboardController + DashboardServer (Signum.Dashboard/DashboardController.cs /
// DashboardServer.cs) — the lookup endpoints the dashboard page / quick-links / embedded widgets call. Each
// asserts ViewDashboard server-side.
//
// altea divergences:
//  - Signum's is a POST `/get` taking the lite; altea's is the GET `/:dashboardId` the page already used.
//    It answers Signum's same `DashboardWithCachedQueries` pair, through a SEAM
//    (`DashboardLogic.cachedQueriesProvider`) because CachedQuery is an optional half here — see its note.
//  - Signum pushed the entity-scoped dashboards onto the ENTITY PACK (`EntityPackTS.AddExtension` →
//    `pack.dashboards` / `pack.embeddedDashboards`). altea's EntityPack has no extension bag, so the client
//    fetches them per entity type from `/forEntityType` and `/embedded/:typeName` instead (one small GET,
//    cached client-side by the widget) — see client/DashboardClient.tsx.

export namespace DashboardServer {
    export function start(ws: WebBuilder): void {
        // The shared user-asset export/import surface (Signum's UserAssetServer.Start + the
        // QueryPermissionSymbols registration).
        UserAssetServer.start(ws);

        ws.get("/api/dashboard/forEntityType/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<Lite<DashboardEntity>[]>() },
            async (req, res) => {
                await assertAuthorized();
                res.jsonTyped(await DashboardLogic.getDashboardsForEntityType(req.params.typeName));
            });

        // The entity types that HAVE embedded dashboards. Signum needed no such route (the server decided per
        // entity pack whether to attach `embeddedDashboards` at all); altea's client registers its embedded
        // widgets UP FRONT, so it fetches this small set once at startup and only registers a widget for a
        // type that actually has one — otherwise every entity view would grow an empty "Dashboards" tab.
        ws.get("/api/dashboard/embeddedTypes",
            { res: CustomType<string[]>() },
            async (_req, res) => {
                await assertAuthorized();
                res.jsonTyped(await DashboardLogic.getEmbeddedDashboardTypeNames());
            });

        // The dashboards that render INSIDE an entity's own view (Signum's pack.embeddedDashboards). Full
        // entities: the widget renders them without a second round-trip.
        ws.get("/api/dashboard/embedded/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<DashboardEntity[]>() },
            async (req, res) => {
                await assertAuthorized();
                res.jsonTyped(await DashboardLogic.getEmbeddedDashboards(req.params.typeName));
            });

        ws.get("/api/dashboard/home",
            { res: CustomType<Lite<DashboardEntity> | null>() },
            async (_req, res) => {
                await assertAuthorized();
                const db = await DashboardLogic.getHomePageDashboard();
                res.jsonTyped(db == null ? null : db.toLite() as Lite<DashboardEntity>);
            });

        ws.get("/api/dashboard/:dashboardId",
            { params: CustomType<{ dashboardId: string }>(), res: CustomType<DashboardWithCachedQueries | null>() },
            async (req, res) => {
                await assertAuthorized();
                const db = await DashboardLogic.retrieveDashboard(req.params.dashboardId);
                if (db == null) {
                    res.status(404).json({ error: `Dashboard '${req.params.dashboardId}' not found` });
                    return;
                }
                // Signum's DashboardWithCachedQueries. The rows only — the client downloads each file
                // itself, which is what lets the store (S3, Azure) serve them instead of the app.
                const cachedQueries = await DashboardLogic.cachedQueriesProvider?.(db) ?? [];
                res.jsonTyped({ dashboard: db, cachedQueries });
            });
    }
}

async function assertAuthorized(): Promise<void> {
    if (!(await PermissionLogic.isAuthorized(DashboardPermission.ViewDashboard)))
        throw new UnauthorizedAccessException(`Not authorized for '${DashboardPermission.ViewDashboard.key}'`);
}
