import { ajaxGet } from "@altea/altea/client/Services";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { QueryString } from "@altea/altea/client/QueryString";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { RestApiKeyEntity } from "../data/Rest";

// Port of Signum.Rest's RestApiKeyClient.tsx — the key's editor, plus the boot-time authenticator that
// turns a `?apiKey=` in the address bar into a logged-in session (how Swagger / an MCP client lands in the
// app already authenticated).
export namespace RestApiKeyClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(RestApiKeyEntity)
            .withView(() => import("./Templates/RestApiKey"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.user),
                    token(a => a.apiKey),
                ],
            }));
    }

    /**
     * Signum's `registerAuthenticator` — FIRST in the chain, so a `?apiKey=` wins over a stored token.
     * Kept separate from `start` for the same reason Signum keeps it separate: a host may want the key
     * ENTITY without letting an url parameter log anyone in.
     */
    export function registerAuthenticator(): void {
        AuthClient.authenticators.unshift(loginFromApiKey);
    }

    export function loginFromApiKey(): Promise<AuthClient.AuthenticatedUser | undefined> {
        const query = QueryString.parse(window.location.search) as Record<string, string>;

        if (!("apiKey" in query))
            return Promise.resolve(undefined);

        return API.loginFromApiKey(query["apiKey"]!);
    }

    export namespace API {

        export function generateRestApiKey(): Promise<string> {
            return ajaxGet({ url: "/api/restApiKey/generate" });
        }

        export function getCurrentRestApiKey(): Promise<string | null> {
            return ajaxGet({ url: "/api/restApiKey/current" });
        }

        /** `avoidAuthToken`: the key IS the credential — a stale bearer token must not shadow it. */
        export function loginFromApiKey(apiKey: string): Promise<AuthClient.API.LoginResponse> {
            return ajaxGet({
                url: "/api/auth/loginFromApiKey?" + QueryString.stringify({ apiKey }),
                avoidAuthToken: true,
            });
        }
    }
}
