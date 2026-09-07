import type { SchemaBuilder } from "@altea/altea/server/schema";
import { UserAssetServer } from "./UserAssetServer";
import "../data/UserAssets"; // seed UserAssetPermission.UserAssetsToXML (transformer init → PermissionSymbol set)
import { PermissionLogic } from "@altea/altea-auth/server/PermissionLogic";
import { UserAssetPermission } from "../data/UserAssets";

// Port of Signum's UserAssetsServer.Start / the UserAssets logic wiring. There is no persistent UserAssets
// entity (UserAssetPreviewModel is a transport ModelEntity); this just registers the permission (via the
// data-module import above) and starts the export/import HTTP surface when a web host is present. Downstream
// asset modules (UserQueries, …) register their XML (de)serializers with UserAssetsImporter in their own start.
export namespace UserAssetLogic {
    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        // Signum's `PermissionLogic.RegisterPermissions(UserAssetPermission.UserAssetsToXML)`, which it
        // makes from TokenMigrationLogic.Start. It belongs HERE in altea: this module's whole job is that
        // permission plus the export/import surface it gates, so an app using user assets WITHOUT token
        // migrations can still grant it.
        PermissionLogic.registerPermissions(UserAssetPermission.UserAssetsToXML);

        if (sb.webBuilder)
            UserAssetServer.start(sb.webBuilder);
    }
}
