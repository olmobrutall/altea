import { resolveSerializationAuthContext } from "../../data/serializer";
import type { HttpMeta } from "../webApi";
import type { RequestFilter } from "./requestFilter";

// The two authorization-shaped things that wrap every handler. Signum splits them the same way: the GATE
// is `SignumAuthenticationFilter`'s job, and the serialization snapshot is taken where the role is known.

/**
 * Pluggable per-request authorization gate (Signum's `SignumAuthenticationFilter`). An auth module
 * installs it via `setAuthorizeRequest`; it runs AFTER routing (so `allowAnonymous` is known) and INSIDE
 * the request's user scope (so it can read the current user). It THROWS to reject — the terminal
 * exception filter maps AuthenticationException / UnauthorizedAccessException to 403.
 *
 * Undefined (no auth module installed) → no enforcement: the framework runs open.
 */
export type AuthorizeRequest = (meta: HttpMeta) => void;
let _authorizeRequest: AuthorizeRequest | undefined;
export function setAuthorizeRequest(fn: AuthorizeRequest | undefined): void { _authorizeRequest = fn; }
export function getAuthorizeRequest(): AuthorizeRequest | undefined { return _authorizeRequest; }

/** Deny the request unless the installed gate allows it. Secure-by-default lives in the gate, not here. */
export const authorizationFilter: RequestFilter = async (ctx, next) => {
    _authorizeRequest?.(ctx.meta);
    await next();
};

/**
 * Capture the request's serialization-auth snapshot, once, before the handler.
 *
 * It must run INSIDE the gate (the role has to be settled) and OUTSIDE the handler (both the request
 * write-gate and the response codec read it synchronously). A no-op unless a property-auth module
 * installed a `resolveContext`.
 */
export const serializationAuthFilter: RequestFilter = async (ctx, next) => {
    ctx.authContext = await resolveSerializationAuthContext();
    await next();
};
