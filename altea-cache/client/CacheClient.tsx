import * as React from 'react'
import { ajaxGet, ajaxPost } from '@altea/altea/client/Services'
import { ImportComponent } from '@altea/altea/client/ImportComponent'
import type { ClientBuilder } from '@altea/altea/client/ClientBuilder'
import type { CacheStateTS } from '../data/CacheState'

// Port of Signum's CacheClient (Signum.Caching/CacheClient.tsx). Registers the statistics route and the
// typed HTTP client the page calls. altea divergences: the panel's DTOs live in the DATA layer
// (data/CacheState.ts), shared with the server builder instead of re-declared here; the omnibox special
// action and the Signum.Map colour provider are not registered (the omnibox special-action registry is a
// per-app concern in altea, and altea has no schema map) — the route is gated server-side by
// CachePermission.ViewCache either way.
export namespace CacheClient {

    export function start(cb: ClientBuilder): void {
        cb.routes.push(
            { path: "/cache/statistics", element: <ImportComponent onImport={() => import("./CacheStatisticsPage")} /> },
        );
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
