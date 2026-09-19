import type { WebBuilder } from "@altea/altea/server/webApi";
import { Lite } from "@altea/altea/data/lite";
import { UserHolder } from "@altea/altea/server/userHolder";
import type { IsolationEntity } from "../../data/Isolation";
import { IsolationLogic } from "../IsolationLogic";

// Signum's `IsolationFilter` — which tenant a request belongs to.
//
// APP-level Express middleware rather than one of core's route filters, for the same reason as
// altea-auth's user scope: it must be established before ANY route reads data, and it reads the current
// user, so it sits between the user scope and the routes. Express middleware ordering is what expresses
// that — mount it after AuthLogic.start and before the routes that need it.
//
// (Everything that only ever wraps a route — culture, profiler, authorization — is a RequestFilter in
// core's per-route chain instead. See @altea/altea/server/filters.)

/** The slice of Express this module needs, spelled out so it needn't depend on @types/express. */
export interface RequestLike {
    headers: Record<string, string | string[] | undefined>;
    isolation?: Lite<IsolationEntity> | null;
}

/** The header a client sends its pick in. */
export const isolationHeader = "signum_isolation";

/**
 * A host hook for deducing the isolation from something other than the header (a sub-domain, a route
 * prefix). Consulted only when the user is not pinned to one and sent no header.
 */
export let getIsolationFromRequest: ((req: RequestLike) => Lite<IsolationEntity> | null) | undefined;
export function setIsolationFromRequest(fn: ((req: RequestLike) => Lite<IsolationEntity> | null) | undefined): void {
    getIsolationFromRequest = fn;
}

/**
 * Resolving the request's isolation, in order: the user's OWN isolation wins (a pinned user can never
 * leave it), else the header the client sent — but only for a real, non-anonymous user — else the host's
 * hook, else global mode.
 */
export function resolveIsolation(req: RequestLike): Lite<IsolationEntity> | null {
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
 * Open the request's isolation scope.
 *
 * Mount BEFORE any route that reads data and AFTER the user scope this reads. Express runs middleware in
 * registration order.
 */
export function useIsolationScope(ws: WebBuilder): void {
    ws.app.use((req: unknown, _res: unknown, next: () => void) => {
        const request = req as RequestLike;
        const isolation = resolveIsolation(request);
        request.isolation = isolation;
        // `unsafeOverride` rather than `override`: this OPENS the request's scope, so there is nothing
        // to conflict with, and it must establish global mode (null) just as firmly as a picked one.
        IsolationLogic.unsafeOverride(isolation, next);
    });
}
