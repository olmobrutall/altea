import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UserAssetServer } from "@altea/altea-user-assets/server/UserAssetServer.server";
import type { ToolbarLocation } from "../data/Toolbar";
import type { ToolbarResponse } from "../data/ToolbarResponse";
import { ToolbarLogic } from "./ToolbarLogic.server";

// Port of Signum's ToolbarController (Signum.Toolbar/ToolbarController.cs) — the two GETs the renderers call.
//
// altea divergences:
//  - No permission assert here, and Signum had none either: a toolbar carries NO permission of its own. What
//    the caller may see is decided per ELEMENT, inside the response builder (every element's content config
//    is asked `isAuthorized`), plus the row-level owner scoping on the toolbar itself. An anonymous /
//    unauthorized caller simply gets `null` or a pruned tree.
//  - Signum bound `ToolbarLocation location` from the route as an enum; altea passes the member NAME through
//    (the wire form of an enum) and `ToolbarLogic.getCurrent` converts it.
//  - `/api/toolbarMenu/:menuId` takes the menu's uuid PK (Signum's `Lite.ParsePrimaryKey<ToolbarMenuEntity>`).

export namespace ToolbarServer {
    export function start(ws: WebBuilder): void {
        // The shared user-asset export/import surface (Signum's UserAssetServer.Start). Idempotent — the
        // dashboard / user-query modules call it too.
        UserAssetServer.start(ws);

        ws.get("/api/toolbar/current/:location",
            {
                params: CustomType<{ location: ToolbarLocation }>(),
                res: CustomType<ToolbarResponse | null>(),
            },
            async (req, res) => {
                res.jsonTyped(await ToolbarLogic.getCurrentToolbarResponse(req.params.location));
            });

        ws.get("/api/toolbarMenu/:menuId",
            {
                params: CustomType<{ menuId: string }>(),
                res: CustomType<ToolbarResponse | null>(),
            },
            async (req, res) => {
                res.jsonTyped(await ToolbarLogic.getToolbarMenuResponse(req.params.menuId));
            });
    }
}
