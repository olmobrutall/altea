import "@altea/altea/server";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { AuthenticationException } from "@altea/altea/server/exceptions";
import { AuthTokenServer, type Authenticator } from "@altea/altea-auth/server/AuthTokenServer";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserWithClaims } from "@altea/altea/data/security";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RestApiKeyEntity } from "../data/Rest";
import { RestApiKeyLogic } from "./RestApiKeyLogic.server";

// Port of Signum.Rest's RestApiKeyServer.cs + RestApiKeyController.cs — the authenticator that turns an
// API key into an authenticated user, and the two endpoints the client needs to show a user their key.
//
// altea divergences:
//  - **the authenticator is ASYNC and reads the key through `AuthRequestLike.query`**, a member added to
//    altea-auth for this: the chain previously only needed `hasQuery` (the token authenticator asks whether
//    `?refreshToken` is present), never a query VALUE. It matters that it returns every occurrence, because
//    Signum REFUSES a request carrying more than one key rather than picking one — a request with two keys
//    is ambiguous about who it acts as.
//  - **`AuthLogic.Disable()` → `ExecutionMode.global()`**: resolving the key's user must not itself be
//    subject to the type/row rules of a user who is not authenticated yet.
//  - **`/api/auth/loginFromApiKey` lives HERE**, not in altea-auth. Signum puts it on its AuthController
//    because that is where `AuthTokenServer.CreateToken` is; altea-auth exports `createToken`, so the
//    route can live with the module that owns the concept and altea-auth needs no knowledge of API keys.
export namespace RestApiKeyServer {

    let started = false;

    export function start(ws: WebBuilder): void {
        if (started)
            return;
        started = true;

        // FIRST in the chain, as Signum inserts it at index 0: a request that carries an API key is
        // authenticating with it, and must not fall through to a stale bearer token.
        AuthTokenServer.authenticators.unshift(apiKeyAuthenticator);

        startRoutes(ws);
    }

    export const apiKeyAuthenticator: Authenticator = async req => {
        const fromQuery = req.query(RestApiKeyLogic.apiKeyQueryParameter);
        const fromHeader = req.header(RestApiKeyLogic.apiKeyHeader);

        const keys = [...new Set([...fromQuery, ...(fromHeader != null && fromHeader !== "" ? [fromHeader] : [])])];

        if (keys.length === 0)
            return undefined;

        if (keys.length > 1)
            throw new AuthenticationException(
                "Request contains multiple API Keys. Please use a single API Key per request for authentication.");

        const key = keys[0]!;

        return await ExecutionMode.global(async () => {
            const cache = await RestApiKeyLogic.restApiKeyCache.value();
            const apiKey = cache.get(key);
            if (apiKey == null)
                throw new AuthenticationException(`Could not authenticate with the API Key ${key}.`);

            const user = await table(UserEntity).filter(u => u.id == apiKey.user.id).singleOrNull() as UserEntity | null;
            if (user == null)
                throw new AuthenticationException(`The user of API Key ${key} is no longer in the database.`);

            return new UserWithClaims(user);
        });
    };

    function startRoutes(ws: WebBuilder): void {

        // A fresh key, for the editor's "generate" button. Nothing is stored — the caller puts it on the
        // entity and saves.
        ws.get("/api/restApiKey/generate",
            { res: CustomType<string>() },
            (_req, res) => {
                res.jsonTyped(RestApiKeyLogic.generateRestApiKey());
            });

        // The current user's own key, if they have one. Signum reads it in ExecutionMode.Global for the
        // same reason: a user may read THEIR key without being allowed to read the RestApiKey type.
        ws.get("/api/restApiKey/current",
            { res: CustomType<string | null>() },
            async (_req, res) => {
                const me = UserHolder.current()?.user;
                if (me == null) {
                    res.jsonTyped(null);
                    return;
                }
                const key = await ExecutionMode.global(async () => {
                    const found = await table(RestApiKeyEntity).filter(k => k.user.id == me.id).toArray();
                    return found.length === 0 ? null : found[0]!.apiKey;
                });
                res.jsonTyped(key);
            });

        // Signum's `AuthController.LoginFromApiKey`: the caller has ALREADY been authenticated by the
        // authenticator above (the key rode on this very request), so this only mints the bearer token the
        // SPA will use from here on. `allowAnonymous` because the request carries no token yet — the gate
        // must not reject it before the authenticator's user is read back here.
        ws.get("/api/auth/loginFromApiKey",
            { res: CustomType<LoginFromApiKeyResponse>(), allowAnonymous: true },
            async (_req, res) => {
                const current = UserHolder.current()?.user;
                if (current == null)
                    throw new AuthenticationException("No API Key was supplied.");

                const user = await ExecutionMode.global(async () =>
                    await table(UserEntity).filter(u => u.id == current.id).singleOrNull() as UserEntity | null);
                if (user == null)
                    throw new AuthenticationException("The user of this API Key is no longer in the database.");

                res.jsonTyped({ userEntity: user, token: AuthTokenServer.createToken(user), authenticationType: "api-key" });
            });
    }

    /** altea-auth's `LoginResponse` shape, declared here so this module needn't import the client's. */
    export interface LoginFromApiKeyResponse {
        userEntity: UserEntity;
        token: string;
        authenticationType: string;
    }
}
