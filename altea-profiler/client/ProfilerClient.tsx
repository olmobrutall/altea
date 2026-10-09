import * as React from 'react'
import { ajaxPost, ajaxGet, ajaxGetRaw, saveFile } from '@altea/altea/client/Services'
import { ImportComponent } from '@altea/altea/client/ImportComponent'
import type { ClientBuilder } from '@altea/altea/client/ClientBuilder'
import { registerSpecialAction } from '@altea/altea/client/OmniboxSpecialAction'
import { AuthClient } from '@altea/altea-auth/client/AuthClient'
import { ProfilerPermission } from '../data/ProfilerPermission'
import type { HeavyProfilerEntryInfo, HeavyProfilerUpload, StackTrace, TimeTrackerEntryInfo } from '../data/ProfilerDtos'

// Port of Signum's ProfilerClient (Signum.Profiler/ProfilerClient.tsx). Registers the three admin routes,
// the two omnibox entries reaching them, and the typed HTTP client the pages call.
//
// Divergences: Signum's third special action, `!OverrideSessionTimeout`, is NOT ported — it navigates to
// `/profiler/overrideSessionTimeout`, a route NOTHING registers in Signum either (its ProfilerLogic has an
// `overrideSessionTimeout` server flag, but no page), so the entry is dead there. The profiler DTOs are
// plain interfaces (not entities), so the API uses avoidDeserialize/avoidSerialize to bypass the entity
// Serializer. `TimeTrackerTime.user` is a plain string (the server sends the user's label), not a Lite.
export namespace ProfilerClient {

    export function start(cb: ClientBuilder): void {
        cb.routes.push(
            { path: "/profiler/times", element: <ImportComponent onImport={() => import("./Times/TimesPage")} /> },
            { path: "/profiler/heavy", element: <ImportComponent onImport={() => import("./Heavy/HeavyListPage")} /> },
            { path: "/profiler/heavy/entry/:selectedIndex", element: <ImportComponent onImport={() => import("./Heavy/HeavyEntryPage")} /> },
        );

        registerSpecialAction({
            key: "ProfilerHeavy",
            allowed: () => AuthClient.isPermissionAuthorized(ProfilerPermission.ViewHeavyProfiler),
            onClick: () => Promise.resolve("/profiler/heavy"),
        });

        registerSpecialAction({
            key: "ProfilerTimes",
            allowed: () => AuthClient.isPermissionAuthorized(ProfilerPermission.ViewTimeTracker),
            onClick: () => Promise.resolve("/profiler/times"),
        });
    }

    export namespace API {

        export namespace Heavy {
            export function setEnabled(isEnabled: boolean): Promise<void> {
                return ajaxPost({ url: "/api/profilerHeavy/setEnabled/" + isEnabled, avoidDeserialize: true }, undefined);
            }

            export function isEnabled(): Promise<boolean> {
                return ajaxGet({ url: "/api/profilerHeavy/isEnabled", avoidDeserialize: true });
            }

            export function clear(): Promise<void> {
                return ajaxPost({ url: "/api/profilerHeavy/clear", avoidDeserialize: true }, undefined);
            }

            export function entries(ignoreProfilerHeavyEntries: boolean): Promise<HeavyProfilerEntryInfo[]> {
                return ajaxGet({ url: "/api/profilerHeavy/entries?ignoreProfilerHeavyEntries=" + ignoreProfilerHeavyEntries, avoidDeserialize: true });
            }

            export function details(key: string): Promise<HeavyProfilerEntryInfo[]> {
                return ajaxGet({ url: "/api/profilerHeavy/details/" + key, avoidDeserialize: true });
            }

            export function stackTrace(key: string): Promise<StackTrace[] | null> {
                return ajaxGet({ url: "/api/profilerHeavy/stackTrace/" + key, avoidDeserialize: true });
            }

            export function download(indices?: string): void {
                void ajaxGetRaw({ url: "/api/profilerHeavy/download" + (indices ? ("?indices=" + indices) : "") })
                    .then(response => saveFile(response));
            }

            export function upload(file: HeavyProfilerUpload): Promise<void> {
                return ajaxPost({ url: "/api/profilerHeavy/upload", avoidSerialize: true, avoidDeserialize: true }, file);
            }
        }

        export namespace Times {
            export function clear(): Promise<void> {
                return ajaxPost({ url: "/api/profilerTimes/clear", avoidDeserialize: true }, undefined);
            }

            export function fetchInfo(): Promise<TimeTrackerEntryInfo[]> {
                return ajaxGet({ url: "/api/profilerTimes/times", avoidDeserialize: true });
            }
        }
    }
}
