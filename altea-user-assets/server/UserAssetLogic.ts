import type { SchemaBuilder } from "@altea/altea/server/schema";
import { UserAssetServer } from "./UserAssetServer";
import "../data/UserAssets"; // seed UserAssetPermission.UserAssetsToXML (transformer init → PermissionSymbol set)
import { PermissionLogic } from "@altea/altea-auth/server/PermissionLogic";
import { UserAssetPermission } from "../data/UserAssets";

// The UserAssets wiring — see docs/port/UserAssets.md. There is no persistent UserAssets entity
// (UserAssetPreviewModel is a transport ModelEntity); this registers the permission (through the
// data-module import above) and starts the export/import HTTP surface when a web host is present.
// Downstream asset modules register their XML (de)serializers with UserAssetsImporter in their own start.
export namespace UserAssetLogic {
    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Registered HERE rather than from TokenMigrationLogic.start: this module's whole job is that
        // permission plus the export/import surface it gates, so an app using user assets WITHOUT token
        // migrations can still grant it.
        PermissionLogic.registerPermissions(UserAssetPermission.UserAssetsToXML);

        if (sb.webBuilder)
            UserAssetServer.start(sb.webBuilder);
    }
}
