import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { Lite } from "@altea/altea/data/lite";
import { Clock } from "@altea/altea/data/utils/clock";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { applyMixins } from "@altea/altea/server/exceptionFilter";
import { UserHolder } from "@altea/altea/server/userHolder";
import { MapColorProvider } from "@altea/altea-map/server/MapColorProvider";
import type { IFilePath } from "@altea/altea-files/server/FileTypeAlgorithm";
import { Isolation, IsolationEntity } from "../data/Isolation";
import { IsolationLogic } from "./IsolationLogic";

// The HTTP half: pick the request's isolation, expose the list the navbar picker shows, colour the schema
// map by strategy, and record the isolation on a logged exception.
//
// The isolation filter is EXPRESS MIDDLEWARE mounted on the WHOLE app, because every request must resolve
// an isolation. Its ordering requirement — after the authentication filter — is expressed by WHERE the
// host calls `start`. The resolved isolation is stashed on the Express request, because by the time the
// exception hook reads it the ambient scope is gone.
//
// Port of Signum.Isolation's IsolationServer.cs + IsolationFilter.cs — see port/Isolation.md.
export namespace IsolationServer {

    /** The header a client sends its pick in. */
    export const isolationHeader = "signum_isolation";

    /**
     * A host hook for deducing the isolation from
     * something other than the header (a sub-domain, a route prefix). Consulted only when the user is not
     * pinned to one and sent no header.
     */
    export let getIsolationFromRequest: ((req: RequestLike) => Lite<IsolationEntity> | null) | undefined;

    // The slice of Express this module needs, spelled out so it needn't depend on @types/express.
    export interface RequestLike {
        headers: Record<string, string | string[] | undefined>;
        isolation?: Lite<IsolationEntity> | null;
    }

    export function start(ws: WebBuilder): void {

        // ---- the per-request scope ------------------------------------------------------------------
        //
        // Mount BEFORE any route that reads data and AFTER AuthLogic.start, which installs the user scope
        // this reads. Express runs middleware in registration order.
        ws.app.use((req: unknown, _res: unknown, next: () => void) => {
            const request = req as RequestLike;
            const isolation = resolveIsolation(request);
            request.isolation = isolation;
            // `unsafeOverride` rather than `override`: this OPENS the request's scope, so there is nothing
            // to conflict with, and it must establish global mode (null) just as firmly as a picked one.
            IsolationLogic.unsafeOverride(isolation, next);
        });

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
     * Resolving the request's isolation, in order: the user's OWN isolation wins (a pinned user can
     * never leave it), else the header the client sent — but only for a real, non-anonymous user — else the
     * host's hook, else global mode.
     */
    function resolveIsolation(req: RequestLike): Lite<IsolationEntity> | null {
        const pinned = IsolationLogic.currentUserIsolation();
        if (pinned != null)
            return pinned;

        if (UserHolder.current() != null) {
            const header = req.headers[isolationHeader];
            const key = Array.isArray(header) ? header[0] : header;
            if (key != undefined && key !== "")
                return Lite.parse(key) as Lite<IsolationEntity>;
        }

        return getIsolationFromRequest?.(req) ?? null;
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
