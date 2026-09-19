import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { Lite } from "@altea/altea/data/lite";
import { Clock } from "@altea/altea/data/utils/clock";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { applyMixins } from "@altea/altea/server/filters/exceptionFilter";
import {
    useIsolationScope, isolationHeader as isolationHeaderName,
    setIsolationFromRequest as setIsolationFromRequestImpl,
    type RequestLike as IsolationRequestLike,
} from "./filters/isolationScope";
import { MapColorProvider } from "@altea/altea-map/server/MapColorProvider";
import type { IFilePath } from "@altea/altea-files/server/FileTypeAlgorithm";
import { Isolation, IsolationEntity } from "../data/Isolation";
import { IsolationLogic } from "./IsolationLogic";

// The HTTP half: pick the request's isolation, expose the list the navbar picker shows, colour the schema
// map by strategy, and record the isolation on a logged exception.
//
// The isolation filter itself lives in filters/isolationScope: EXPRESS MIDDLEWARE mounted on the WHOLE
// app, because every request must resolve an isolation and it reads the current user, so it belongs
// between the user scope and the routes rather than in core's per-route filter chain. Its ordering
// requirement is expressed by WHERE the host calls `start`. The resolved isolation is stashed on the
// Express request, because by the time the exception hook reads it the ambient scope is gone.
//
// Port of Signum.Isolation's IsolationServer.cs + IsolationFilter.cs — see port/Isolation.md.
export namespace IsolationServer {

    // The header, the host hook and the request shape live with the middleware that reads them
    // (filters/isolationScope) and are re-exported here so `IsolationServer.x` keeps working.
    export const isolationHeader = isolationHeaderName;
    export const setIsolationFromRequest = setIsolationFromRequestImpl;
    export type RequestLike = IsolationRequestLike;

    export function start(ws: WebBuilder): void {

        // The per-request isolation scope — see filters/isolationScope for why it is app-level middleware
        // and not one of core's route filters.
        useIsolationScope(ws);

        // ---- the list the navbar picker shows --------------------------------------------------------
        ws.get("/api/isolations",
            { res: CustomType<Lite<IsolationEntity>[]>() },
            async (_req, res) => {
                // A user PINNED to an isolation may not enumerate the others. (The
                // message interpolates an `IsolationMixin`, which is a bug in its error text; the isolation
                // itself is what is worth naming.)
                const pinned = IsolationLogic.currentUserIsolation();
                if (pinned != null)
                    throw new UnauthorizedAccessException(`User is only allowed to see isolation: ${pinned.toString()}`);
                return res.jsonTyped(await IsolationLogic.isolations.value());
            });

        // ---- the schema map's per-table strategy colours ---------------------------------------------
        MapColorProvider.getColorProviders.push(() => {
            const strategies = Isolation.allStrategies();
            const byCleanName = new Map<string, string>();
            for (const [ctor, strategy] of strategies)
                byCleanName.set(ctor.name.replace(/Entity$/, ""), strategy);

            return [{
                name: "isolation",
                niceName: "Isolation",
                order: 3,
                addExtra: t => {
                    const s = byCleanName.get(t.typeName);
                    if (s != undefined)
                        t.extra["isolation"] = s;
                },
            }];
        });

        // ---- record the isolation on a logged exception ----------------------------------------------
        applyMixins.push((e, req) => {
            const iso = IsolationLogic.current() ?? (req as RequestLike).isolation ?? null;
            Isolation.setIsolation(e, iso);
        });
    }

    /**
     * A file-store suffix generator that puts
     * each isolation's files in their own folder, so one tenant's uploads are never mixed into another's
     * directory. Pass it as a FileTypeAlgorithm's `calculateSuffix`.
     *
     * The folder is keyed on the isolation's id (or "None"), since the id is stable and
     * short where the name is neither.
     */
    export const isolated_YearMonth_Guid_Filename = (fp: IFilePath): string => {
        const iso = IsolationLogic.current();
        const now = Clock.now;
        return path.join(
            iso?.id == undefined ? "None" : String(iso.id),
            `${now.year}-${String(now.month).padStart(2, "0")}`,
            randomUUID(),
            path.basename(fp.fileName));
    };
}
