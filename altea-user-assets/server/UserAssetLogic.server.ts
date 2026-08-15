import type { SchemaBuilder } from "@altea/altea/server/schema";
import { UserAssetServer } from "./UserAssetServer.server";
import "../data/UserAssets"; // seed UserAssetPermission.UserAssetsToXML (transformer init → PermissionSymbol set)

// Port of Signum's UserAssetsServer.Start / the UserAssets logic wiring. There is no persistent UserAssets
// entity (UserAssetPreviewModel is a transport ModelEntity); this just registers the permission (via the
// data-module import above) and starts the export/import HTTP surface when a web host is present. Downstream
// asset modules (UserQueries, …) register their XML (de)serializers with UserAssetsImporter in their own start.
export namespace UserAssetLogic {
    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        if (sb.webBuilder)
            UserAssetServer.start(sb.webBuilder);
    }
}
