import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import type { DynamicViewEntity, DynamicViewOverrideEntity, DynamicViewSelectorEntity } from "../data/DynamicView";
import { DynamicViewLogic } from "./DynamicViewLogic.server";

// Port of Signum.Dynamic's Views/DynamicViewController.cs — the six GETs the client's ViewDispatcher reads
// while resolving which component renders an entity.
//
// altea divergences:
//  - Signum's `TypeLogic.GetType(typeName)` then a dictionary `GetOrThrow` becomes a lookup by CLEAN NAME
//    straight off the lazy (see DynamicViewLogic's header). A missing view answers 404 rather than throwing
//    a KeyNotFound, because the dispatcher asks for views it is not sure exist.
//  - the `viewName` query-string parameter is read off `req.query` (Signum's model binder does it by name).
export namespace DynamicViewServer {

    export interface DynamicViewProps {
        name: string;
        type: string;
    }

    export function start(ws: WebBuilder): void {

        ws.get("/api/dynamic/view/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<DynamicViewEntity>() },
            async (req, res) => {
                const { typeName } = req.params;
                const viewName = String(viewNameOf(req));

                const view = await DynamicViewLogic.tryGetDynamicView(typeName, viewName);
                if (view == undefined)
                    throw new Error(`There is no DynamicView '${viewName}' for type '${typeName}'`);

                res.jsonTyped(view);
            });

        ws.get("/api/dynamic/viewProps/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<DynamicViewProps[]>() },
            async (req, res) => {
                const { typeName } = req.params;
                const viewName = String(viewNameOf(req));

                const view = await DynamicViewLogic.tryGetDynamicView(typeName, viewName);
                if (view == undefined)
                    throw new Error(`There is no DynamicView '${viewName}' for type '${typeName}'`);

                res.jsonTyped(view.props.map(p => ({ name: p.name, type: p.type })));
            });

        ws.get("/api/dynamic/viewNames/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<string[]>() },
            async (req, res) => {
                res.jsonTyped(await DynamicViewLogic.getDynamicViewNames(req.params.typeName));
            });

        ws.get("/api/dynamic/selector/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<DynamicViewSelectorEntity | null>() },
            async (req, res) => {
                res.jsonTyped(await DynamicViewLogic.tryGetSelector(req.params.typeName) ?? null);
            });

        ws.get("/api/dynamic/override/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<DynamicViewOverrideEntity[]>() },
            async (req, res) => {
                res.jsonTyped(await DynamicViewLogic.getOverrides(req.params.typeName));
            });

        ws.get("/api/dynamic/suggestedFindOptions/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<DynamicViewLogic.SuggestedFindOptions[]>() },
            async (req, res) => {
                res.jsonTyped(await DynamicViewLogic.getSuggestedFindOptions(req.params.typeName));
            });
    }

    function viewNameOf(req: unknown): unknown {
        return (req as { query?: Record<string, unknown> }).query?.["viewName"];
    }
}
