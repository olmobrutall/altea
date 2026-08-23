import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { Lite } from "@altea/altea/data/lite";
import { Clock } from "@altea/altea/data/utils/clock";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { applyMixins } from "@altea/altea/server/exceptionFilter";
import { UserHolder } from "@altea/altea/server/userHolder";
import { MapColorProvider } from "@altea/altea-map/server/MapColorProvider.server";
import type { IFilePath } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import { Isolation, IsolationEntity } from "../data/Isolation";
import { IsolationLogic } from "./IsolationLogic.server";

// Port of Signum.Isolation's IsolationServer.cs + IsolationFilter.cs + IsolationController.cs — the HTTP
// half: pick the request's isolation, expose the list the navbar picker shows, colour the schema map by
// strategy, and record the isolation on a logged exception.
//
// altea divergences:
//  - **Signum's `IsolationFilter` (a `SignumDisposableResourceFilter`) is EXPRESS MIDDLEWARE**, the same
//    translation @altea/altea-rest's RestLogFilter made: altea has no MVC filter pipeline. It is mounted
//    on the whole app rather than per controller, because every request must resolve an isolation —
//    Signum registers it globally too (`options.AddIsolationFilter()`), so `AddIsolationFilter`'s
//    positional `atIndex` argument has no counterpart; the ordering requirement it expresses ("after the
//    authentication filter") is expressed by WHERE the host calls `start`.
//  - `HttpContext.Items[Signum_Isolation]` → a property on the Express request, read back by the
//    exception hook for the same reason Signum stashes it: by then the ambient scope is gone.
export namespace IsolationServer {

    /** Signum's `IsolationFilter.Signum_Isolation_Key` — the header a client sends its pick in. */
    export const isolationHeader = "signum_isolation";

    /**
     * Signum's `IsolationFilter.GetIsolationFromHttpContext` — a host hook for deducing the isolation from
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

        // ---- the per-request scope (Signum's IsolationFilter.GetResource) ----------------------------
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

        // ---- Signum's IsolationController.Isolations -------------------------------------------------
        ws.get("/api/isolations",
            { res: CustomType<Lite<IsolationEntity>[]>() },
            async (_req, res) => {
                // Signum's check: a user PINNED to an isolation may not enumerate the others. (Signum's own
                // message interpolates an `IsolationMixin`, which is a bug in its error text; the isolation
                // itself is what is worth naming.)
                const pinned = IsolationLogic.currentUserIsolation();
                if (pinned != null)
                    throw new UnauthorizedAccessException(`User is only allowed to see isolation: ${pinned.toString()}`);
                return res.jsonTyped(await IsolationLogic.isolations.value());
            });

        // ---- Signum's MapColorProvider.GetColorProviders += GetMapColors -----------------------------
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

        // ---- Signum's SignumExceptionFilterAttribute.ApplyMixins -------------------------------------
        applyMixins.push((e, req) => {
            const iso = IsolationLogic.current() ?? (req as unknown as RequestLike).isolation ?? null;
            Isolation.setIsolation(e, iso);
        });
    }

    /**
     * Signum's `IsolationFilter.GetResource`, in order: the user's OWN isolation wins (a pinned user can
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
     * Signum's `IsolationLogic.Isolated_YearMonth_Guid_Filename` — a file-store suffix generator that puts
     * each isolation's files in their own folder, so one tenant's uploads are never mixed into another's
     * directory. Pass it as a FileTypeAlgorithm's `calculateSuffix`.
     *
     * Signum keys the folder on the isolation's `IdOrNull` (or "None"); kept, since the id is stable and
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
