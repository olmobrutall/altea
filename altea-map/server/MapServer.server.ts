import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { Schema } from "@altea/altea/server/schema";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { Entity } from "@altea/altea/data/entity";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { UserEntity } from "@altea/altea-auth/data/User";
import { MapMessage, MapPermission, type OperationMapInfo, type SchemaMapInfo } from "../data/Map";
import { MapColorProvider } from "./MapColorProvider.server";
import { AuthColorProvider } from "./AuthColorProvider.server";
import { SchemaMap } from "./SchemaMap.server";
import { OperationMap } from "./OperationMap.server";

// Port of Signum.Map's MapServer.cs + MapController.cs — the two routes, and the registration of the
// built-in colour providers.
//
// altea divergences:
//  - `ReflectionServer.RegisterLike(typeof(MapMessage), …)` has no counterpart: altea ships ONE metadata
//    blob and a message container is included by being registered, with no per-container visibility
//    predicate to attach (the same note altea-time-machine's server carries).
//  - Signum decides whether the two HISTORY providers and the auth providers apply **at start time**
//    (`if (Schema.Current.Tables.Any(a => a.Value.SystemVersioned != null))`), which reads the schema
//    while it is still being built. Here each factory decides PER REQUEST — so the answer cannot depend
//    on where in the starter `MapLogic.start` happens to sit.
//  - Both routes are gated by `MapPermission.ViewMap` (Signum's `AssertAuthorized`), and Signum's
//    unprefixed `api/map/...` keeps its own `/api/map` segment.
export namespace MapServer {

    export function start(ws: WebBuilder): void {

        registerBuiltInColorProviders();

        ws.get("/api/map/types",
            { res: CustomType<SchemaMapInfo>() },
            async (_req, res) => {
                await assertAuthorized();
                return res.jsonTyped(await SchemaMap.getMapInfo());
            });

        ws.get("/api/map/operations/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<OperationMapInfo>() },
            async (req, res) => {
                await assertAuthorized();
                const { typeName } = (req as unknown as { params: { typeName: string } }).params;
                return res.jsonTyped(await OperationMap.getOperationMapInfo(Entity.resolveType(typeName)));
            });
    }

    async function assertAuthorized(): Promise<void> {
        if (!(await PermissionAuthLogic.isAuthorized(MapPermission.ViewMap)))
            throw new UnauthorizedAccessException(`Not authorized for '${MapPermission.ViewMap.key}'`);
    }

    /**
     * Signum's seven `MapColorProvider.GetColorProviders +=` blocks, plus the auth ones. Each is only the
     * DROPDOWN ENTRY — the scale that turns a table into a colour is the matching `ClientColorProvider`
     * in the browser, and the page refuses to render if the two lists disagree, which is what keeps this
     * list and client/Schema/DefaultColorProvider.ts honest.
     */
    function registerBuiltInColorProviders(): void {
        MapColorProvider.getColorProviders.push(() => [
            { name: "namespace", niceName: MapMessage.Namespace.niceToString() },
            { name: "entityKind", niceName: "EntityKind" },
            { name: "columns", niceName: MapMessage.Columns.niceToString() },
            { name: "entityData", niceName: "EntityData" },
            { name: "rows", niceName: MapMessage.Rows.niceToString() },
            { name: "tableSize", niceName: MapMessage.TableSize.niceToString() },
        ]);

        // The two history scales only mean something once at least one table is @systemVersioned.
        MapColorProvider.getColorProviders.push(() => {
            const anyVersioned = [...Schema.current.tables.values()].some(t => t.systemVersioned != null);
            return !anyVersioned ? [] : [
                { name: "rows_history", niceName: MapMessage.RowsHistory.niceToString() },
                { name: "tableSize_history", niceName: MapMessage.TableSizeHistory.niceToString() },
            ];
        });

        // Per-role access painting — only where there is a user table to have roles in, matching Signum's
        // `if (Schema.Current.Tables.ContainsKey(typeof(UserEntity)))`.
        MapColorProvider.getColorProviders.push(() =>
            Schema.current.tables.has(UserEntity) ? AuthColorProvider.getMapColors() : []);
    }
}
