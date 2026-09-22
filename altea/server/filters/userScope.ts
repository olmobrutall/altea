import { UserHolder } from "../userHolder";
import type { UserWithClaims } from "../../data/security";

// The per-request USER SCOPE — the frame that establishes who the request is (Signum's
// `SignumAuthenticationFilter`).
//
// It is APP-level Express middleware and it is mounted by the `WebBuilder` CONSTRUCTOR, before any module
// has run. Both halves of that are deliberate:
//
//  - **app-level**, not one of core's route filters, because there are readers OUTSIDE routing:
//    @altea/altea-isolation mounts `app.use` middleware whose `resolveIsolation` reads
//    `UserHolder.current()`, and @altea/altea-rest's `RestLogFilter` stamps `currentUserLite()` onto the
//    log row. A route-level frame would leave both looking at nobody, silently.
//  - **at construction**, because Express runs middleware in REGISTRATION order: an `app.use` added later
//    does not wrap a route registered earlier. Mounting it with the first module that happens to want it
//    would make every module's start position security-relevant — a module that must start early
//    (CacheLogic swaps the global-lazy invalidation strategy, so it goes before any `sb.globalLazy`) would
//    have its routes permanently outside the scope, and nothing would fail loudly.
//
// So core mounts the SCOPE and altea-auth fills the SEAM: `setAuthenticateRequest` names who the request
// is, the same shape as `setAuthorizeRequest` (the gate) and `setUserCultureProvider` (the culture).
// Unset — a host with no auth module — every request simply runs with no user.

/** The Express request surface an authenticator needs; core does not hand the raw `Request` across. */
export interface AuthRequestLike {
    header(name: string): string | undefined;
    query: Record<string, unknown>;
}

/** The response surface an authenticator needs, for the refreshed-token header. */
export interface AuthResponseLike {
    setHeader(name: string, value: string): void;
}

export type AuthenticateRequest = (req: AuthRequestLike, res: AuthResponseLike) => Promise<UserWithClaims | undefined>;

let authenticateRequest: AuthenticateRequest | undefined;

/**
 * Name who each request is. Called INSIDE the scope, so what it returns becomes `UserHolder.current()`
 * for everything downstream — every route and every later `app.use`, whenever either was registered.
 *
 * Authenticating is not authorizing: a request with no valid credential simply proceeds with no user, and
 * `setAuthorizeRequest`'s gate is what rejects it unless the route is `allowAnonymous`.
 */
export function setAuthenticateRequest(authenticate: AuthenticateRequest): void {
    authenticateRequest = authenticate;
}

interface AppLike { use(handler: (req: AuthRequestLike, res: AuthResponseLike, next: (err?: unknown) => void) => void): void; }

/** Mounted once, by the WebBuilder constructor. Nothing else should call this. */
export function useUserScope(app: AppLike): void {
    app.use((req, res, next) => {
        UserHolder.withScope(() => {
            const authenticate = authenticateRequest;
            if (authenticate == undefined) {
                next();
                return;
            }
            // Continue the pipeline INSIDE the scope (AsyncLocalStorage propagates across the awaited
            // continuation), which is what makes the user visible downstream.
            authenticate(req, res).then(
                uwc => { if (uwc != null) UserHolder.setCurrent(uwc); next(); },
                next,
            );
        });
    });
}
