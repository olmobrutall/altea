import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UserAssetServer } from "@altea/altea-user-assets/server/UserAssetServer";
import type { ToolbarLocationKeys } from "../data/Toolbar";
import type { ToolbarResponse } from "../data/ToolbarResponse";
import { ToolbarLogic } from "./ToolbarLogic";

// Port of Signum.Toolbar's ToolbarController.cs — see port/Toolbar.md.
//
// The two GETs the renderers call. NO permission assert, deliberately: a toolbar carries none of its own.
// What the caller may see is decided per ELEMENT inside the response builder (every element's content
// config is asked `isAuthorized`), plus the row-level owner scoping on the toolbar itself — so an anonymous
// or unauthorized caller simply gets `null` or a pruned tree.
//
// `location` arrives as the enum's member NAME (its wire form) and `ToolbarLogic.getCurrent` converts it;
// `/api/toolbarMenu/:menuId` takes the menu's uuid PK.

export namespace ToolbarServer {
    export function start(ws: WebBuilder): void {
        // The shared user-asset export / import surface. Idempotent — the
        // dashboard / user-query modules call it too.
        UserAssetServer.start(ws);

        ws.get("/api/toolbar/current/:location",
            {
                params: CustomType<{ location: ToolbarLocationKeys }>(),
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
