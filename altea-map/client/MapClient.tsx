import * as React from "react";
import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { OmniboxClient } from "@altea/altea-omnibox/client/OmniboxClient";
import type { OperationMapInfo, SchemaMapInfo } from "../data/Map";
import { registerColorProviders } from "./Schema/ClientColorProvider";
import MapOmniboxProvider from "./MapOmniboxProvider";

// Port of Signum.Map's MapClient.tsx — the module's client registration: the two page routes, the omnibox
// provider, the built-in colour providers, and the two API calls.
//
// altea divergences:
//  - **No `clearProviders` / `clearSettingsActions`.** The provider registry lives on
//    `AppContext.clientState` (see Schema/ClientColorProvider), which `newClientState()` resets wholesale
//    on a credential change — so there is nothing for this module to register a reset for.
//  - `ChangeLogClient.registerChangeLogModule` is not called: altea's change log is per-application, not
//    per-Signum-module, and this module ships no changelog.
//  - Both provider factories are dynamic imports, exactly as in Signum — the d3 scales and the auth
//    gradients are only paid for on the /map page.
export namespace MapClient {

    export function start(cb: ClientBuilder): void {

        cb.routes.push(
            { path: "/map", element: <ImportComponent onImport={() => import("./Schema/SchemaMapPage")} /> },
            { path: "/map/:type", element: <ImportComponent onImport={() => import("./Operation/OperationMapPage")} /> },
        );

        OmniboxClient.registerProvider(new MapOmniboxProvider());

        registerColorProviders(info => import("./Schema/DefaultColorProvider").then(c => c.default(info)));

        // The per-role colourings only exist where there are roles. `tryGetTypeInfo` is the client-side
        // counterpart of the server's `Schema.Tables.ContainsKey(typeof(UserEntity))` check: a host that
        // did not start altea-auth has no RoleEntity in the metadata blob.
        if (tryGetTypeInfo(RoleEntity))
            registerColorProviders(info => import("./Schema/AuthColorProvider").then(c => c.default(info)));
    }

    export namespace API {
        export function types(): Promise<SchemaMapInfo> {
            return ajaxGet({ url: "/api/map/types" });
        }

        export function operations(typeName: string): Promise<OperationMapInfo> {
            return ajaxGet({ url: "/api/map/operations/" + typeName });
        }
    }
}
