import * as React from 'react'
import { ajaxGet, ajaxPost } from '@altea/altea/client/Services'
import { ImportComponent } from '@altea/altea/client/ImportComponent'
import type { ClientBuilder } from '@altea/altea/client/ClientBuilder'
import type { CacheStateTS } from '../data/CacheState'
import { registerSpecialAction } from '@altea/altea/client/OmniboxSpecialAction'
import { AuthClient } from '@altea/altea-auth/client/AuthClient'
import { CachePermission } from '../data/CachePermission'

// Port of Signum.Caching's CacheClient.tsx — see docs/port/Cache.md.
//
// The statistics route, the "!ViewCache" omnibox entry and the typed HTTP client the page calls.
//
// That omnibox entry is gated on **ViewCache**, which is what the page it opens actually needs — every
// route the page calls asserts ViewCache, and only `clear` asserts InvalidateCache. (Signum gates it on
// InvalidateCache, which hides it from someone allowed to open the panel and offers it to someone who is
// not. Do not "restore" that.)
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
