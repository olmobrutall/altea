import { AsyncLocalStorage } from "node:async_hooks";
import { OpenIdConnect } from "@altea/altea-auth/server/OpenIdConnect";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { AzureADConfigurationEmbedded } from "../data/AzureAD";

// Port of Signum.Authorization.AzureAD's SignumTokenCredentials.cs + every `new GraphServiceClient(…)` call
// site — the ONE place this module talks to Microsoft Graph.
//
// altea divergences, documented inline:
//  - Signum uses `Azure.Identity`'s `ClientSecretCredential` + the generated `Microsoft.Graph` SDK. altea
//    calls the Graph REST API directly over the HTTP helper altea-auth already has (see
//    @altea/altea-auth's OpenIdConnect): the module needs exactly five Graph calls (list users, list
//    groups, transitive members, transitive memberOf, photo bytes) and each is one GET with OData query
//    parameters. Two large SDKs to spell those is a worse trade than the ~80 lines below, and the token
//    endpoint is the same client-credentials POST `ClientSecretCredential` makes.
//  - `AsyncThreadVariable<TokenCredential?> OverridenTokenCredential` → an AsyncLocalStorage scope
//    (`withAccessToken`), the same override seam with altea's async propagation.
//  - Signum caches nothing (the credential object caches internally); altea caches the app token until
//    shortly before it expires, per tenant+client.

/** A bearer token to use INSTEAD of the application's own (Signum's AccessTokenCredential). */
const overriddenToken = new AsyncLocalStorage<string>();

interface CachedToken { token: string; expiresAt: number }

export namespace MicrosoftGraph {

    const tokenCache = new Map<string, CachedToken>();

    /** Signum's `SignumTokenCredentials.OverrideAuthenticationProvider(accessToken)`. */
    export function withAccessToken<R>(accessToken: string, fn: () => R): R {
        return overriddenToken.run(accessToken, fn);
    }

    /** Drop every cached application token (a configuration change invalidates them). */
    export function clearTokenCache(): void {
        tokenCache.clear();
    }

    /**
     * Signum's `GetAuthorizerTokenCredential()` — the token every Graph call rides on: the ambient
     * override if one is in scope (a delegated call, made with the signed-in user's own token), else the
     * application's own client-credentials token.
     */
    export async function accessToken(config: AzureADConfigurationEmbedded): Promise<string> {
        const overridden = overriddenToken.getStore();
        if (overridden != null)
            return overridden;

        if (config.clientSecret == null || config.clientSecret === "")
            throw new Error("Microsoft Graph needs a Client Secret in the Azure AD configuration"
                + " (Azure sign-in itself does not).");

        const key = `${config.directoryID}|${config.applicationID}`;
        const cached = tokenCache.get(key);
        // 60 s of slack: a token that expires mid-flight would fail the call it was fetched for.
        if (cached != null && cached.expiresAt - 60_000 > Date.now())
            return cached.token;

        const response = await OpenIdConnect.postForm<{ access_token?: string; expires_in?: number }>(
            `https://login.microsoftonline.com/${config.directoryID}/oauth2/v2.0/token`,
            {
                grant_type: "client_credentials",
                client_id: config.applicationID,
                client_secret: config.clientSecret,
                scope: "https://graph.microsoft.com/.default",
            });

        if (response.access_token == null)
            throw new Error("The Azure AD token endpoint returned no access_token");

        tokenCache.set(key, {
            token: response.access_token,
            expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
        });
        return response.access_token;
    }

    /** One Graph GET. `path` is relative to `/v1.0` (e.g. `users`, `groups/{id}/transitiveMembers`). */
    export async function get<T>(config: AzureADConfigurationEmbedded, path: string, params?: GraphQueryParameters): Promise<T> {
        using _prof = HeavyProfiler.log("Microsoft Graph", () => path);

        const token = await accessToken(config);
        const url = `https://graph.microsoft.com/v1.0/${path}${queryString(params)}`;

        return await OpenIdConnect.getJson<T>(url, undefined, {
            Authorization: `Bearer ${token}`,
            // Required by Graph for the advanced queries ($count / $search / OR over directory objects).
            ConsistencyLevel: "eventual",
        });
    }

    /** One Graph GET returning raw bytes (a profile photo). Null when Graph has none. */
    export async function getBytes(config: AzureADConfigurationEmbedded, path: string): Promise<Buffer | null> {
        using _prof = HeavyProfiler.log("Microsoft Graph", () => path);

        const token = await accessToken(config);
        return await OpenIdConnect.getBytes(`https://graph.microsoft.com/v1.0/${path}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    }

    /** The OData query parameters the two directory queries build (Signum's `req.QueryParameters`). */
    export interface GraphQueryParameters {
        filter?: string | null;
        search?: string | null;
        select?: string[] | null;
        orderby?: string[] | null;
        top?: number | null;
        count?: boolean;
    }

    function queryString(params: GraphQueryParameters | undefined): string {
        if (params == null)
            return "";

        const parts: string[] = [];
        if (params.filter) parts.push("$filter=" + encodeURIComponent(params.filter));
        // $search values are already quoted by the converter ("displayName:foo"), and Graph wants them
        // percent-encoded like any other parameter.
        if (params.search) parts.push("$search=" + encodeURIComponent(params.search));
        if (params.select?.length) parts.push("$select=" + encodeURIComponent(params.select.join(",")));
        if (params.orderby?.length) parts.push("$orderby=" + encodeURIComponent(params.orderby.join(",")));
        if (params.top != null) parts.push("$top=" + params.top);
        if (params.count) parts.push("$count=true");

        return parts.length === 0 ? "" : "?" + parts.join("&");
    }
}

/** A Graph collection response (`{ value: [...], "@odata.count": n }`). */
export interface GraphCollection<T> {
    value?: T[];
    "@odata.count"?: number;
}

/** The Graph `user` fields this module reads. */
export interface GraphUser {
    id?: string;
    displayName?: string;
    userPrincipalName?: string;
    mail?: string;
    givenName?: string;
    surname?: string;
    jobTitle?: string;
    department?: string;
    officeLocation?: string;
    employeeType?: string;
    onPremisesImmutableId?: string;
    onPremisesExtensionAttributes?: Record<string, string | null>;
    companyName?: string;
    creationType?: string;
    accountEnabled?: boolean;
}

/** The Graph `group` fields this module reads. */
export interface GraphGroup {
    id?: string;
    displayName?: string;
    description?: string;
    securityEnabled?: boolean;
    visibility?: string;
}
