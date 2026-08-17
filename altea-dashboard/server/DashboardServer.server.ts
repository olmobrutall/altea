import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import type { Lite } from "@altea/altea/data/lite";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { UserAssetServer } from "@altea/altea-user-assets/server/UserAssetServer.server";
import { DashboardEntity, DashboardPermission } from "../data/Dashboard";
import { DashboardLogic } from "./DashboardLogic.server";

// Port of Signum's DashboardController + DashboardServer (Signum.Dashboard/DashboardController.cs /
// DashboardServer.cs) — the lookup endpoints the dashboard page / quick-links / embedded widgets call. Each
// asserts ViewDashboard server-side.
//
// altea divergences:
//  - Signum's `/get` returns `DashboardWithCachedQueries`; CachedQuery is deferred (Signum.Files), so this
//    route returns the DashboardEntity alone and every part queries live.
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
            { params: CustomType<{ dashboardId: string }>(), res: CustomType<DashboardEntity | null>() },
            async (req, res) => {
                await assertAuthorized();
                const db = await DashboardLogic.retrieveDashboard(req.params.dashboardId);
                if (db == null) {
                    res.status(404).json({ error: `Dashboard '${req.params.dashboardId}' not found` });
                    return;
                }
                res.jsonTyped(db);
            });
    }
}

async function assertAuthorized(): Promise<void> {
    if (!(await PermissionAuthLogic.isAuthorized(DashboardPermission.ViewDashboard)))
        throw new UnauthorizedAccessException(`Not authorized for '${DashboardPermission.ViewDashboard.key}'`);
}
