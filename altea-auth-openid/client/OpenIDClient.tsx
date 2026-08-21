import * as React from "react";
import type { RouteObject } from "react-router";
import { ImportComponent } from "@altea/altea/client/ImportComponent";

// Port of Signum.Authorization.OpenID's OpenIDClient.tsx — the PUBLIC half: one route, no Navigator
// dependency, so it is safe to load for an anonymous visitor. The configuration EDITOR lives in
// OpenIDAdminClient (which does touch Navigator).

export namespace OpenIDClient {

    /** Signum's `startPublic({routes})` — called from MainPublic inside its reload(). */
    export function startPublic(routes: RouteObject[]): void {
        routes.push({
            path: "/openid-callback",
            element: <ImportComponent onImport={() => import("./OpenIDCallback")} />,
        });
    }
}
