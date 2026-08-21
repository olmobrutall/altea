import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";

// The OpenID Connect plumbing that Signum gets from `Microsoft.IdentityModel.Protocols.OpenIdConnect`
// (`ConfigurationManager<OpenIdConnectConfiguration>` + `JwtSecurityTokenHandler.ValidateToken`), which
// both `Signum.Authorization.OpenID` and `Signum.Authorization.AzureAD` use identically:
//
//   1. fetch and CACHE a provider's discovery document (`/.well-known/openid-configuration`) and its JWKS;
//   2. VALIDATE an id_token against that JWKS — signature, issuer, audience, lifetime.
//
// It lives in altea-auth (rather than being copy-pasted into the two modules, as Signum does) because it is
// pure OIDC, carries no provider-specific knowledge, and both modules would otherwise duplicate it.
//
// altea divergences, documented inline:
//  - `ConfigurationManager` (auto-refreshing, 12 h by default) becomes a small in-process cache keyed by
//    the discovery endpoint with the same intent; `refreshDiscovery()` drops it (Signum's
//    `RequestRefresh`).
//  - HTTP is done with `node:https` / `node:http` rather than `fetch`, for ONE reason: OpenID's
//    `avoidSSLVerify` (Signum's `DangerousAcceptAnyServerCertificateValidator`, needed against a
//    self-signed dev Keycloak) is a per-REQUEST TLS setting, and Node's global `fetch` exposes no
//    supported way to set it without an undici dispatcher. The same helper serves the token exchange,
//    so a module never has to reach for a second HTTP client.
//  - `JwtSecurityTokenHandler` becomes `jose.jwtVerify` over a LOCAL JWK set: the keys are fetched
//    through the helper above (so `avoidSSLVerify` applies to the JWKS request too) instead of by
//    `jose.createRemoteJWKSet`, which would use `fetch` and ignore it.

/** The subset of the discovery document altea reads (Signum's OpenIdConnectConfiguration). */
export interface OpenIdConnectConfiguration {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    end_session_endpoint?: string;
    jwks_uri: string;
    [other: string]: unknown;
}

export interface OpenIdHttpOptions {
    /** Signum's `AvoidSSLVerify` — accept ANY server certificate. Development only. */
    avoidSSLVerify?: boolean;
}

interface CachedDiscovery {
    fetchedAt: number;
    config: OpenIdConnectConfiguration;
    jwks: JSONWebKeySet | undefined;
}

export namespace OpenIdConnect {

    /** Signum's `ConfigurationManager.AutomaticRefreshInterval` (12 h there). */
    export let refreshIntervalMs = 12 * 60 * 60 * 1000;

    const cache = new Map<string, CachedDiscovery>();

    /** Drop every cached discovery document / JWKS (Signum's `RequestRefresh`). */
    export function refreshDiscovery(): void {
        cache.clear();
    }

    /** Signum's `GetDiscoveryDocument` — the provider's metadata, cached. */
    export async function getConfiguration(discoveryEndpoint: string, options?: OpenIdHttpOptions): Promise<OpenIdConnectConfiguration> {
        const cached = cache.get(discoveryEndpoint);
        if (cached != null && Date.now() - cached.fetchedAt < refreshIntervalMs)
            return cached.config;

        const config = await getJson<OpenIdConnectConfiguration>(discoveryEndpoint, options);
        if (config.jwks_uri == null)
            throw new Error(`The discovery document at '${discoveryEndpoint}' has no jwks_uri`);

        cache.set(discoveryEndpoint, { fetchedAt: Date.now(), config, jwks: undefined });
        return config;
    }

    /** The provider's signing keys (Signum's `OpenIdConnectConfiguration.SigningKeys`), cached alongside. */
    export async function getSigningKeys(discoveryEndpoint: string, options?: OpenIdHttpOptions): Promise<JSONWebKeySet> {
        const config = await getConfiguration(discoveryEndpoint, options);
        const entry = cache.get(discoveryEndpoint)!;
        return entry.jwks ??= await getJson<JSONWebKeySet>(config.jwks_uri, options);
    }

    /**
     * Signum's `ValidateToken(jwt, config, out jwtSecurityToken)` — verify the signature against the
     * provider's JWKS and check issuer, audience and lifetime. Returns the CLAIMS (Signum returns a
     * ClaimsPrincipal; altea's contexts read claims by name, so the payload IS the principal).
     *
     * `issuer` is explicit rather than always taken from the document because Azure AD's multi-tenant
     * "common" endpoint advertises a templated issuer, so the caller substitutes the real tenant.
     */
    export async function validateToken(jwt: string, params: {
        discoveryEndpoint: string;
        audience: string | string[];
        issuer?: string;
    } & OpenIdHttpOptions): Promise<JWTPayload> {
        const config = await getConfiguration(params.discoveryEndpoint, params);
        const jwks = await getSigningKeys(params.discoveryEndpoint, params);

        const { payload } = await jwtVerify(jwt, createLocalJWKSet(jwks), {
            audience: params.audience,
            issuer: params.issuer ?? config.issuer,
        });

        return payload;
    }

    /** GET a JSON document (the discovery document, the JWKS, a Graph response). */
    export function getJson<T>(url: string, options?: OpenIdHttpOptions, headers?: Record<string, string>): Promise<T> {
        return request<T>("GET", url, undefined, { ...options, headers });
    }

    /**
     * POST an `application/x-www-form-urlencoded` body and read the JSON response — the OAuth 2.0 token
     * endpoint (Signum's `FormUrlEncodedContent` + `PostAsync`).
     */
    export function postForm<T>(url: string, form: Record<string, string>, options?: OpenIdHttpOptions): Promise<T> {
        const body = new URLSearchParams(form).toString();
        return request<T>("POST", url, body, {
            ...options,
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body)) },
        });
    }

    /** GET raw bytes (a directory profile photo). Returns null on any non-2xx. */
    export function getBytes(url: string, options?: OpenIdHttpOptions & { headers?: Record<string, string> }): Promise<Buffer | null> {
        return new Promise((resolve, reject) => {
            const target = new URL(url);
            const transport = target.protocol === "http:" ? http : https;
            const req = transport.request(target, {
                method: "GET",
                headers: options?.headers,
                rejectUnauthorized: options?.avoidSSLVerify !== true,
            }, res => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => {
                    const status = res.statusCode ?? 0;
                    resolve(status >= 200 && status < 300 ? Buffer.concat(chunks) : null);
                });
            });
            req.on("error", reject);
            req.end();
        });
    }

    function request<T>(method: string, url: string, body: string | undefined,
        options: OpenIdHttpOptions & { headers?: Record<string, string> }): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const target = new URL(url);
            const transport = target.protocol === "http:" ? http : https;

            const req = transport.request(target, {
                method,
                headers: { Accept: "application/json", ...options.headers },
                // `rejectUnauthorized: false` is the whole point of `avoidSSLVerify`; it is opt-in per
                // configuration and must never be the default.
                rejectUnauthorized: options.avoidSSLVerify !== true,
            }, res => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    const status = res.statusCode ?? 0;
                    if (status < 200 || status >= 300) {
                        reject(new Error(`${method} ${url} failed with ${status}: ${text.substring(0, 500)}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(text) as T);
                    } catch {
                        reject(new Error(`${method} ${url} did not return JSON: ${text.substring(0, 500)}`));
                    }
                });
            });

            req.on("error", reject);
            if (body != null)
                req.write(body);
            req.end();
        });
    }
}

/** The OAuth 2.0 token-endpoint response (Signum's OpenIDTokenResponse). */
export interface OAuthTokenResponse {
    access_token?: string;
    id_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
}
