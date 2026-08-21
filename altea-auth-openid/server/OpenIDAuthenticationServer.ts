import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserWithClaims } from "@altea/altea/data/security";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { AuthServer } from "@altea/altea-auth/server/AuthServer";
import { AuthTokenServer } from "@altea/altea-auth/server/AuthTokenServer";
import { OpenIdConnect, type OAuthTokenResponse } from "@altea/altea-auth/server/OpenIdConnect";
import type { UserEntity } from "@altea/altea-auth/data/User";
import type { OpenIDClientConfig, OpenIDEndpoints } from "../data/OpenID";
import { OpenIDConfigurationEmbedded } from "../data/OpenID";
import { OpenIDAuthorizer, OpenIDClaimsContext } from "./OpenIDAuthorizer";

// Port of Signum.Authorization.OpenID's OpenIDAuthenticationServer.cs + OpenIDAuthenticationController.cs —
// the server half of the authorization-code flow: the browser comes back with a `code`, the server
// exchanges it for tokens at the provider, validates the id_token against the provider's JWKS, and maps the
// resulting identity onto a local user.
//
// altea divergences, documented inline:
//  - `ConfigurationManager<OpenIdConnectConfiguration>` + `JwtSecurityTokenHandler` → altea-auth's
//    `OpenIdConnect` helper (discovery cache + `jose` verification). Same checks: signature against the
//    published keys, issuer, audience, lifetime.
//  - the "find or create the local user" block (~40 lines Signum repeats in all three modules) is
//    `ADAuthorizer.findOrCreateUser`.
//  - `AuthServer.OnUserPreLogin` / `AddUserSession` → `UserHolder.setCurrent` + `AuthServer.userLogged`,
//    which is what altea's AuthServer login route does.
//  - Signum serialises the browser-visible configuration into Index.cshtml
//    (`window.__openIDConfig`); altea has no server-rendered page, so `/api/auth/openIDConfig` serves it.
//    That endpoint also carries the discovery endpoints, so the client needs ONE anonymous call at boot
//    rather than Signum's inline blob plus a separate `/api/auth/openIDEndpoints` round trip. The
//    endpoints route is kept as well, since a client may need to re-read them after a provider change.

interface LoginWithOpenIDRequest { code?: string; redirectUri?: string }
interface LoginResponse { authenticationType: string; token: string; userEntity: UserEntity }
/** The one anonymous boot payload: null when OpenID is off or not configured. */
export type OpenIDClientSettings = (OpenIDClientConfig & OpenIDEndpoints) | null;

export namespace OpenIDAuthenticationServer {

    export function start(ws: WebBuilder): void {

        // POST /api/auth/loginWithOpenID?throwErrors=true — the callback page posts the authorization code.
        ws.post("/api/auth/loginWithOpenID",
            { req: CustomType<LoginWithOpenIDRequest>(), res: CustomType<LoginResponse | null>(), allowAnonymous: true },
            async (req, res) => {
                const request = (await req.jsonTyped()) as LoginWithOpenIDRequest | undefined;
                const throwErrors = ((req as unknown as { query: Record<string, unknown> }).query["throwErrors"] ?? "true") !== "false";

                const user = await loginOpenIDAuthentication(request?.code ?? "", request?.redirectUri ?? "", throwErrors);
                if (user == null) {
                    res.jsonTyped(null);
                    return;
                }

                res.jsonTyped({
                    authenticationType: "openID",
                    token: AuthTokenServer.createToken(user),
                    userEntity: user,
                });
            });

        // GET /api/auth/openIDConfig — the browser-visible configuration + the provider's endpoints.
        ws.get("/api/auth/openIDConfig",
            { res: CustomType<OpenIDClientSettings>(), allowAnonymous: true },
            async (_req, res) => {
                const config = tryGetConfig();
                const clientConfig = config?.toClientConfig();
                if (config == null || clientConfig == null) {
                    res.jsonTyped(null);
                    return;
                }

                const discovery = await OpenIdConnect.getConfiguration(config.getDiscoveryEndpoint(), config);
                res.jsonTyped({
                    ...clientConfig,
                    authorizationEndpoint: discovery.authorization_endpoint,
                    endSessionEndpoint: discovery.end_session_endpoint,
                });
            });

        // GET /api/auth/openIDEndpoints — Signum's endpoint, kept for a client that re-reads them.
        ws.get("/api/auth/openIDEndpoints",
            { res: CustomType<OpenIDEndpoints>(), allowAnonymous: true },
            async (_req, res) => {
                const config = requireConfig();
                const discovery = await OpenIdConnect.getConfiguration(config.getDiscoveryEndpoint(), config);
                res.jsonTyped({
                    authorizationEndpoint: discovery.authorization_endpoint,
                    endSessionEndpoint: discovery.end_session_endpoint,
                });
            });
    }

    /**
     * Signum's `LoginOpenIDAuthentication(ac, request, throwErrors)` — the whole exchange. Returns the
     * logged-in user, or null when `throwErrors` is false and anything went wrong (the silent-login path:
     * a failed attempt must fall through to the normal login page, not blow up the boot sequence).
     */
    export async function loginOpenIDAuthentication(code: string, redirectUri: string, throwErrors: boolean): Promise<UserEntity | null> {
        return await AuthLogic.withDisabled(async () => {
            try {
                const authorizer = requireAuthorizer();
                const config = authorizer.getConfig();
                if (config == null || !config.enabled)
                    return null;

                const tokens = await exchangeCodeForTokens(code, redirectUri, config);
                if (tokens.id_token == null)
                    throw new Error("The token endpoint returned no id_token");

                const claims = await OpenIdConnect.validateToken(tokens.id_token, {
                    discoveryEndpoint: config.getDiscoveryEndpoint(),
                    audience: config.clientId!,
                    avoidSSLVerify: config.avoidSSLVerify,
                });

                const ctx = new OpenIDClaimsContext(claims, tokens.access_token ?? "", config);
                const user = await authorizer.findOrCreateUser(ctx);

                UserHolder.setCurrent(new UserWithClaims(user));
                for (const fn of AuthServer.userLogged) fn(user);
                AuthLogic.onUserLogingIn(user, "OpenID");
                return user;
            } catch (e) {
                await logException(e);
                if (throwErrors)
                    throw e;
                return null;
            }
        });
    }

    /** Signum's `ExchangeCodeForTokens` — the OAuth 2.0 authorization-code grant. */
    async function exchangeCodeForTokens(code: string, redirectUri: string, config: OpenIDConfigurationEmbedded): Promise<OAuthTokenResponse> {
        const discovery = await OpenIdConnect.getConfiguration(config.getDiscoveryEndpoint(), config);

        return await OpenIdConnect.postForm<OAuthTokenResponse>(discovery.token_endpoint, {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId!,
            // A PUBLIC client (a SPA with no secret) simply omits it; sending "" would be rejected.
            ...(config.clientSecret != null && config.clientSecret !== "" ? { client_secret: config.clientSecret } : {}),
        }, config);
    }

    function requireAuthorizer(): OpenIDAuthorizer {
        const authorizer = AuthLogic.authorizer;
        if (!(authorizer instanceof OpenIDAuthorizer))
            throw new Error("AuthLogic.authorizer is not an OpenIDAuthorizer");
        return authorizer;
    }

    function tryGetConfig(): OpenIDConfigurationEmbedded | null {
        const authorizer = AuthLogic.authorizer;
        return authorizer instanceof OpenIDAuthorizer ? authorizer.getConfig() : null;
    }

    function requireConfig(): OpenIDConfigurationEmbedded {
        const config = tryGetConfig();
        if (config == null)
            throw new Error("OpenID is not configured");
        return config;
    }
}

/** `ex.LogException()` — in its own transaction so the log survives the rollback of what failed. */
async function logException(e: unknown): Promise<void> {
    try {
        await ExecutionMode.global(() => Transaction.forceNew(() => ExceptionLogic.logException(e)));
    } catch {
        // Never let logging mask the original error.
    }
}
