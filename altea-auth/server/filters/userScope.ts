import { UserHolder } from "@altea/altea/server/userHolder";
import type { WebBuilder } from "@altea/altea/server/webApi";
import { UserWithClaims } from "@altea/altea/data/security";
import { AuthTokenServer } from "../AuthTokenServer";
import { AuthLogic } from "../AuthLogic";

// Signum's `SignumAuthenticationFilter` — the frame that establishes WHO the request is.
//
// It is APP-level Express middleware, not a route filter, and that is deliberate rather than historical.
// The other three concerns (culture, profiler, authorization) only ever wrap a ROUTE, so they live in
// core's per-route filter chain. This one has readers OUTSIDE routing:
//
//   - @altea/altea-isolation mounts `app.use` middleware that resolves the tenant, and its
//     `resolveIsolation` reads `UserHolder.current()` and the user's pinned isolation;
//   - @altea/altea-rest mounts `RestLogFilter` on a path prefix and stamps `UserHolder.currentUserLite()`
//     onto the log row.
//
// Both run before any route handler, so a route-level user frame would leave them looking at nobody —
// silently: isolation would fall through to its request-derived default and the REST log would record an
// anonymous call. Establishing the user has to happen before any middleware that reads it, which is
// exactly what `app.use` ordering gives.
//
// Extracted into its own file all the same, so it is one named, installable piece — `useUserScope(ws)`,
// the same idiom as core's `useExceptionFilter(ws)`.

/** The Express request/response surface an authenticator needs; altea-auth does not depend on @types/express. */
interface ReqLike { header(name: string): string | undefined; query: Record<string, unknown>; }
interface ResLike { setHeader(name: string, value: string): void; }
type NextLike = (err?: unknown) => void;

async function authenticate(req: ReqLike, res: ResLike): Promise<UserWithClaims | undefined> {
    const reqLike = {
        header: (n: string) => req.header(n) ?? undefined,
        hasQuery: (n: string) => req.query[n] != null,
        // Express gives a repeated parameter as an array and a single one as a string; normalise to
        // an array so an authenticator can see "more than one" (see AuthRequestLike.query).
        query: (n: string) => {
            const v = req.query[n];
            return v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
        },
    };
    const resLike = { setHeader: (n: string, v: string) => { res.setHeader(n, v); } };
    for (const authenticator of AuthTokenServer.authenticators) {
        const result = await authenticator(reqLike, resLike);
        if (result != null)
            return result;
    }
    // Permissive fallback: a configured AnonymousUser, else undefined (request proceeds anonymous).
    const anon = await AuthLogic.anonymousUser();
    return anon != null ? new UserWithClaims(anon) : undefined;
}

/**
 * Open a fresh per-request user scope, authenticate inside it, then continue the pipeline THERE — so
 * everything downstream sees `UserHolder.current()` (AsyncLocalStorage propagates across the awaited
 * continuation).
 *
 * Authenticating is not authorizing: a request with no valid token simply proceeds with no user, and the
 * authorization filter is what rejects it unless the route is `allowAnonymous`.
 *
 * Mount FIRST — before any other `app.use` that reads the user, and before the routes.
 */
export function useUserScope(ws: WebBuilder): void {
    const middleware = (req: ReqLike, res: ResLike, next: NextLike): void => {
        UserHolder.withScope(() => {
            authenticate(req, res).then(
                uwc => { if (uwc != null) UserHolder.setCurrent(uwc); next(); },
                next,
            );
        });
    };
    (ws.app.use as (h: unknown) => void)(middleware);
}
