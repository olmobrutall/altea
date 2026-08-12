import * as React from 'react'
import { ajaxPost, ajaxGet, ajaxGetRaw, saveFile } from '@altea/altea/client/Services'
import { ImportComponent } from '@altea/altea/client/ImportComponent'
import type { ClientBuilder } from '@altea/altea/client/ClientBuilder'

// Port of Signum's ProfilerClient (Signum.Profiler/ProfilerClient.tsx). Registers the three admin routes
// and exposes the typed HTTP client the pages call. Divergences: no Omnibox / client-side
// isPermissionAuthorized in altea (dropped — the routes are gated server-side); the profiler DTOs are
// plain interfaces (not entities), so the API uses avoidDeserialize/avoidSerialize to bypass the entity
// Serializer. `TimeTrackerTime.user` is a plain string (the server sends the user's label), not a Lite.
export namespace ProfilerClient {

    export function start(cb: ClientBuilder): void {
        cb.routes.push(
            { path: "/profiler/times", element: <ImportComponent onImport={() => import("./Times/TimesPage")} /> },
            { path: "/profiler/heavy", element: <ImportComponent onImport={() => import("./Heavy/HeavyListPage")} /> },
            { path: "/profiler/heavy/entry/:selectedIndex", element: <ImportComponent onImport={() => import("./Heavy/HeavyEntryPage")} /> },
        );
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

            export function entries(ignoreProfilerHeavyEntries: boolean): Promise<HeavyProfilerEntry[]> {
                return ajaxGet({ url: "/api/profilerHeavy/entries?ignoreProfilerHeavyEntries=" + ignoreProfilerHeavyEntries, avoidDeserialize: true });
            }

            export function details(key: string): Promise<HeavyProfilerEntry[]> {
                return ajaxGet({ url: "/api/profilerHeavy/details/" + key, avoidDeserialize: true });
            }

            export function stackTrace(key: string): Promise<StackTraceTS[]> {
                return ajaxGet({ url: "/api/profilerHeavy/stackTrace/" + key, avoidDeserialize: true });
            }

            export function download(indices?: string): void {
                void ajaxGetRaw({ url: "/api/profilerHeavy/download" + (indices ? ("?indices=" + indices) : "") })
                    .then(response => saveFile(response));
            }

            export function upload(file: { fileName: string; content: string }): Promise<void> {
                return ajaxPost({ url: "/api/profilerHeavy/upload", avoidSerialize: true, avoidDeserialize: true }, file);
            }
        }

        export namespace Times {
            export function clear(): Promise<void> {
                return ajaxPost({ url: "/api/profilerTimes/clear", avoidDeserialize: true }, undefined);
            }

            export function fetchInfo(): Promise<TimeTrackerEntry[]> {
                return ajaxGet({ url: "/api/profilerTimes/times", avoidDeserialize: true });
            }
        }
    }

    export interface StackTraceTS {
        color: string;
        fileName: string;
        lineNumber: number;
        method: string;
        type: string;
        namespace: string;
    }

    export interface HeavyProfilerEntry {
        beforeStart: number;
        start: number;
        end: number;
        totalMax: number;
        elapsed: string;
        isFinished: boolean;
        kind: string;
        color: string;
        depth: number;
        asyncDepth: number;
        additionalData: string;
        fullIndex: string;
    }

    export interface TimeTrackerTime {
        duration: number;
        date: string;
        url: string;
        user: string;
    }

    export interface TimeTrackerEntry {
        identifier: string;
        count: number;
        averageDuration: number;
        totalDuration: number;

        max: TimeTrackerTime;
        max2?: TimeTrackerTime;
        max3?: TimeTrackerTime;

        min: TimeTrackerTime;
        last: TimeTrackerTime;
    }
}
