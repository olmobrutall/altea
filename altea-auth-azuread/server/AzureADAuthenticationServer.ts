import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserWithClaims } from "@altea/altea/data/security";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { Lite } from "@altea/altea/data/lite";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { AuthServer } from "@altea/altea-auth/server/AuthServer";
import { AuthTokenServer } from "@altea/altea-auth/server/AuthTokenServer";
import { OpenIdConnect } from "@altea/altea-auth/server/OpenIdConnect";
import { ActiveDirectoryPermission } from "@altea/altea-auth/data/BaseAD";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { table } from "@altea/altea/server/table";
import { ADGroupEntity, ADGroupOperation, type ADGroupRequest } from "../data/ADGroup";
import { Operations } from "@altea/altea/server/operationLogic";
import type { AzureADClientConfig } from "../data/AzureAD";
import { claimsContextFor } from "./AzureADAuthorizer";
import { AzureADLogic } from "./AzureADLogic";
import { CachedProfilePhotoLogic } from "./CachedProfilePhotoLogic";
import { toAzureSize } from "../data/CachedProfilePhoto";

// The server half of the MSAL flow, plus the profile-photo routes. Port of
// Signum.Authorization.AzureAD's AzureAuthenticationServer.cs + AzureADAuthenticationController.cs +
// ADGroup/ADGroupController.cs — the module's HTTP surface: sign in with an MSAL-acquired token, import an
// AD group, and serve a user's photo.
//
// altea divergences, documented inline:
//  - `ValidateToken` → altea-auth's `OpenIdConnect.validateToken` (see its header). The ISSUER is chosen by
//    the configuration (`getIssuer`), because a work/school tenant validates against the multi-tenant
//    "common" discovery document whose advertised issuer is templated.
//  - the find-or-create block is `ADAuthorizer.findOrCreateUser`.
//  - The browser-visible configuration is served from an ANONYMOUS endpoint, since there is no
//    server-rendered page to inject it into; altea
//    serves it from the anonymous `/api/auth/azureADConfig` endpoint (no server-rendered page).
//  - `extraValidAudiences` lets a second app registration's tokens through.
//  - `Response.GetTypedHeaders().CacheControl = …` → an explicit `Cache-Control` header.

interface LoginWithAzureADRequest { idToken?: string; accessToken?: string }
interface LoginResponse { authenticationType: string; token: string; userEntity: UserEntity }

interface ResLike {
    setHeader(name: string, value: string): void;
    status(code: number): { end(): void };
    type(t: string): { send(body: unknown): void };
}

export namespace AzureADAuthenticationServer {

    /** How long a cached profile photo stays fresh: 7 HOURS. (Signum writes `new TimeSpan(7, 0, 0)`,
     *  which is hours rather than days — worth stating, since the shape reads like a date.) */
    export let pictureMaxAgeSeconds = 7 * 60 * 60;

    /** Extra `aud` values to accept (a second app registration). */
    export let extraValidAudiences: (() => string[]) | undefined;

    export function start(ws: WebBuilder, options: { adGroups: boolean }): void {

        // POST /api/auth/loginWithAzureAD?adVariant=default&throwErrors=true
        ws.post("/api/auth/loginWithAzureAD",
            { req: CustomType<LoginWithAzureADRequest>(), res: CustomType<LoginResponse | null>(), allowAnonymous: true },
            async (req, res) => {
                const request = (await req.jsonTyped()) as LoginWithAzureADRequest | undefined;
                const query = req.query;
                const adVariant = (query["adVariant"] as string | undefined) ?? null;
                const throwErrors = (query["throwErrors"] ?? "true") !== "false";

                const user = await loginAzureADAuthentication(
                    request?.idToken ?? "", request?.accessToken ?? "", adVariant, throwErrors);

                if (user == null) {
                    res.jsonTyped(null);
                    return;
                }

                res.jsonTyped({
                    authenticationType: "azureAD",
                    token: AuthTokenServer.createToken(user),
                    userEntity: user,
                });
            });

        // GET /api/auth/azureADConfig?adVariant=default — the browser-visible configuration.
        ws.get("/api/auth/azureADConfig",
            { res: CustomType<AzureADClientConfig | null>(), allowAnonymous: true },
            async (req, res) => {
                const query = req.query;
                const adVariant = (query["adVariant"] as string | undefined) ?? null;
                const config = AzureADLogic.authorizer?.getConfigFor(adVariant) ?? null;
                res.jsonTyped(config?.toClientConfig() ?? null);
            });

        // GET /api/azureUserPhoto/:size/:oid — the photo straight from Graph.
        ws.get("/api/azureUserPhoto/:size/:oid",
            { params: CustomType<{ size: string; oid: string }>(), allowAnonymous: true },
            async (req, res) => {
                const { size, oid } = req.params;
                cacheControl(res);

                const bytes = await AzureADLogic.getUserPhoto(oid, toAzureSize(Number(size))).catch(() => null);
                if (bytes == null) {
                    res.status(404).end();
                    return;
                }

                sendJpeg(res, bytes);
            });

        // GET /api/cachedAzureUserPhoto/:size/:oid → the URL of the LOCALLY stored copy (or null).
        // AUTHENTICATED: it reads the database.
        ws.get("/api/cachedAzureUserPhoto/:size/:oid",
            { params: CustomType<{ size: string; oid: string }>(), res: CustomType<string | null>() },
            async (req, res) => {
                const { size, oid } = req.params;
                cacheControl(res);

                if (!CachedProfilePhotoLogic.isStarted)
                    throw new Error("CachedProfilePhotoLogic is not started");

                const cpp = await CachedProfilePhotoLogic.getOrCreateCachedPicture(oid, Number(size));
                res.jsonTyped(cpp.photo == null ? null : photoUrl(cpp.photo.entityId, cpp.photo.rootType));
            });

        if (options.adGroups) {
            // POST /api/createADGroup — import a directory group as a local ADGroupEntity row.
            ws.post("/api/createADGroup",
                { req: CustomType<ADGroupRequest>(), res: CustomType<Lite<ADGroupEntity>>() },
                async (req, res) => {
                    if (!(await PermissionLogic.isAuthorized(ActiveDirectoryPermission.InviteUsersFromAD)))
                        throw new UnauthorizedAccessException(`Not authorized for '${ActiveDirectoryPermission.InviteUsersFromAD.key}'`);

                    const request = (await req.jsonTyped()) as ADGroupRequest | undefined;
                    if (request == null)
                        throw new Error("No ADGroupRequest in the request body");

                    const groupId = request.id;
                    const existing = await table(ADGroupEntity).filter(g => g.id == groupId).singleOrNull() as ADGroupEntity | null;
                    if (existing != null) {
                        res.jsonTyped(existing.toLite());
                        return;
                    }

                    const group = ADGroupEntity.create({ displayName: request.displayName });
                    // The row IS the directory group: its uuid PK is the Entra object id.
                    group.id = groupId;
                    await Operations.execute(group, ADGroupOperation.Save);
                    res.jsonTyped(group.toLite());
                });
        }
    }

    /**
     * Validate the token MSAL
     * acquired in the browser and map its identity onto a local user.
     */
    export async function loginAzureADAuthentication(
        idToken: string, accessToken: string, adVariant: string | null, throwErrors: boolean,
    ): Promise<UserEntity | null> {
        return await AuthLogic.withDisabled(async () => {
            try {
                const authorizer = AzureADLogic.authorizer;
                if (authorizer == null)
                    return null;

                const config = authorizer.getConfigFor(adVariant);
                if (config == null || !config.enabled)
                    return null;

                const discoveryEndpoint = config.getDiscoveryEndpoint();
                const discovery = await OpenIdConnect.getConfiguration(discoveryEndpoint);

                const claims = await OpenIdConnect.validateToken(idToken, {
                    discoveryEndpoint,
                    audience: [config.applicationID, ...(extraValidAudiences?.() ?? [])],
                    issuer: config.getIssuer(discovery.issuer),
                });

                const ctx = claimsContextFor(config, claims, accessToken);
                const user = await authorizer.findOrCreateUser(ctx);

                UserHolder.setCurrent(new UserWithClaims(user));
                for (const fn of AuthServer.userLogged) fn(user);
                AuthLogic.onUserLogingIn(user, "AzureAD");
                return user;
            } catch (e) {
                await logException(e);
                if (throwErrors)
                    throw e;
                return null;
            }
        });
    }

    function cacheControl(res: ResLike): void {
        res.setHeader("Cache-Control", `private, max-age=${pictureMaxAgeSeconds}`);
    }

    function sendJpeg(res: ResLike, bytes: Buffer): void {
        res.setHeader("Content-Type", "image/jpeg");
        res.type("image/jpeg").send(bytes);
    }

    /** The owner-addressed download URL altea-files serves (see @altea/altea-files' FilesServer). */
    function photoUrl(entityId: string | null, rootType: string | null): string | null {
        return entityId == null || rootType == null
            ? null
            : `/api/files/downloadEmbeddedFilePath/${rootType}/${entityId}?route=photo`;
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
