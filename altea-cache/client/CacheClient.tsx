import * as React from 'react'
import { ajaxGet, ajaxPost } from '@altea/altea/client/Services'
import { ImportComponent } from '@altea/altea/client/ImportComponent'
import type { ClientBuilder } from '@altea/altea/client/ClientBuilder'
import type { CacheStateTS } from '../data/CacheState'
import { registerSpecialAction } from '@altea/altea/client/OmniboxSpecialAction'
import { AuthClient } from '@altea/altea-auth/client/AuthClient'
import { CachePermission } from '../data/CachePermission'

// Port of Signum's CacheClient (Signum.Caching/CacheClient.tsx). Registers the statistics route, the
// "!ViewCache" omnibox entry and the typed HTTP client the page calls. altea divergences: the panel's DTOs
// live in the DATA layer (data/CacheState.ts), shared with the server builder instead of re-declared here;
// the Signum.Map colour provider is not registered (altea-map has no cache provider).
//
// One deliberate fix rather than a mirror: Signum gates the "!ViewCache" entry on
// `CachePermission.InvalidateCache`, but the page it opens needs `ViewCache` — every route it calls asserts
// that one, and only `clear` asserts InvalidateCache. Signum's condition therefore hides the entry from
// someone allowed to open the panel, and offers it to someone who may not. Gated on ViewCache here.
export namespace CacheClient {

    export function start(cb: ClientBuilder): void {
        cb.routes.push(
            { path: "/cache/statistics", element: <ImportComponent onImport={() => import("./CacheStatisticsPage")} /> },
        );

        registerSpecialAction({
            key: "ViewCache",
            allowed: () => AuthClient.isPermissionAuthorized(CachePermission.ViewCache),
            onClick: () => Promise.resolve("/cache/statistics"),
        });
    }

    export namespace API {
        export function view(): Promise<CacheStateTS> {
            return ajaxGet({ url: "/api/cache/view", avoidDeserialize: true });
        }

        export function enable(): Promise<void> {
            return ajaxPost({ url: "/api/cache/enable", avoidDeserialize: true }, undefined);
        }

        export function disable(): Promise<void> {
            return ajaxPost({ url: "/api/cache/disable", avoidDeserialize: true }, undefined);
        }

        export function clear(): Promise<void> {
            return ajaxPost({ url: "/api/cache/clear", avoidDeserialize: true }, undefined);
        }
    }
}
