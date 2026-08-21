import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserWithClaims } from "@altea/altea/data/security";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { AuthServer } from "@altea/altea-auth/server/AuthServer";
import { AuthTokenServer } from "@altea/altea-auth/server/AuthTokenServer";
import { UserState, type UserEntity } from "@altea/altea-auth/data/User";
import { LoginAuthMessage } from "@altea/altea-auth/data/AuthMessages";
import { WindowsADMessage } from "../data/WindowsAD";
import { DirectoryServiceContext, WindowsADAuthorizer } from "./WindowsADAuthorizer";
import { WindowsADLogic } from "./WindowsADLogic";
import { WindowsDirectory, localNameOf } from "./WindowsDirectory";

// Port of Signum.Authorization.WindowsAD's WindowsADServer.cs + WindowsADController.cs — the two routes:
// integrated Windows sign-in, and the AD thumbnail photo.
//
// ══ THE ONE THING THAT DOES NOT PORT ═══════════════════════════════════════════════════════════════════
// Signum reads the caller's Windows identity from `HttpContext.User as WindowsPrincipal`, which IIS fills in
// after completing an SPNEGO / Kerberos handshake. Node has no SSPI: there is no supported, portable way to
// complete that handshake in-process, and the native modules that can (node-expose-sspi) are Windows-only
// node-gyp builds that break every non-Windows install of this package.
//
// So `negotiateProvider` is a SEAM, null by default: with none installed the endpoint answers a clear error
// instead of pretending. A Windows host that wants real SSO installs one — for example a reverse proxy that
// terminates Negotiate and forwards the resolved account, or an SSPI binding it depends on itself:
//
//     WindowsADServer.negotiateProvider = async req => {
//         const account = await mySspi.authenticate(req);        // or read a trusted proxy header
//         return { userName: account.name, sid: account.sid };   // sid may be null: AD is then queried
//     };
//
// Everything else in the module — the LDAP credential login, user search / import, the group→role mapping,
// the photo, the deactivate-users task — works with no provider at all.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
//
// Other altea divergences:
//  - the find-or-create block is `ADAuthorizer.findOrCreateUser`-shaped, though this path keeps Signum's own
//    ordering because it must look the user up BY SID first (the SID is what the handshake yields).
//  - `AuthServer.OnUserPreLogin` / `AddUserSession` → `UserHolder.setCurrent` + `AuthServer.userLogged`.
//  - `Response.GetTypedHeaders().CacheControl` → an explicit `Cache-Control` header.

/** What a Negotiate provider must yield: the Windows account name, and its SID when it knows it. */
export interface NegotiatedIdentity {
    /** `DOMAIN\user` or `user@domain` — whatever the handshake produced. */
    userName: string;
    /** The canonical SID string, or null to have it looked up in the directory. */
    sid: string | null;
}

interface LoginResponse { authenticationType: string; token: string; userEntity: UserEntity }

interface ResLike {
    setHeader(name: string, value: string): void;
    status(code: number): { end(): void };
    type(t: string): { send(body: unknown): void };
}

export namespace WindowsADServer {

    /** See the header. Null by default: this host cannot do integrated Windows authentication. */
    export let negotiateProvider: ((req: unknown) => Promise<NegotiatedIdentity | null>) | null = null;

    /** Signum's `PictureMaxAge` — 7 hours. */
    export let pictureMaxAgeSeconds = 7 * 60 * 60;

    export function start(ws: WebBuilder): void {

        // POST /api/auth/loginWindowsAuthentication?throwError=true
        ws.post("/api/auth/loginWindowsAuthentication",
            { res: CustomType<LoginResponse | null>(), allowAnonymous: true },
            async (req, res) => {
                const query = (req as unknown as { query: Record<string, unknown> }).query;
                const throwErrors = (query["throwError"] ?? "false") === "true";

                const user = await loginWindowsAuthentication(req, throwErrors);
                if (user == null) {
                    res.jsonTyped(null);
                    return;
                }

                res.jsonTyped({
                    authenticationType: "windows",
                    token: AuthTokenServer.createToken(user),
                    userEntity: user,
                });
            });

        // GET /api/adThumbnailphoto/:username — the AD thumbnailPhoto.
        ws.get("/api/adThumbnailphoto/:username",
            { params: CustomType<{ username: string }>(), allowAnonymous: true },
            async (req, res) => {
                const { username } = (req as unknown as { params: { username: string } }).params;
                const response = res as unknown as ResLike;
                response.setHeader("Cache-Control", `private, max-age=${pictureMaxAgeSeconds}`);

                const bytes = await WindowsADLogic.getProfilePicture(username).catch(() => null);
                if (bytes == null) {
                    response.status(404).end();
                    return;
                }

                response.setHeader("Content-Type", "image/jpeg");
                response.type("image/jpeg").send(bytes);
            });
    }

    /** Signum's `LoginWindowsAuthentication(ac, throwErrors)`. */
    export async function loginWindowsAuthentication(req: unknown, throwErrors: boolean): Promise<UserEntity | null> {
        return await AuthLogic.withDisabled(async () => {
            try {
                const authorizer = AuthLogic.authorizer;
                if (!(authorizer instanceof WindowsADAuthorizer))
                    return fail(throwErrors, "No WindowsADAuthorizer set in AuthLogic.authorizer");

                const config = authorizer.getConfig();
                if (config == null)
                    return fail(throwErrors, "No WindowsADConfiguration is set");

                if (!config.loginWithWindowsAuthenticator)
                    return fail(throwErrors, "loginWithWindowsAuthenticator is set to false");

                if (negotiateProvider == null)
                    return fail(throwErrors, WindowsADMessage.WindowsIntegratedAuthenticationIsNotConfiguredOnThisHost.niceToString());

                const identity = await negotiateProvider(req);
                if (identity == null)
                    return fail(throwErrors, "The Negotiate provider did not resolve a Windows identity");

                const userName = identity.userName;
                const localName = localNameOf(userName);

                // The SID is the stable identity. When the provider does not know it, ask the directory.
                const directoryUser = await WindowsDirectory.findByIdentity(config, userName);
                const sid = identity.sid ?? directoryUser?.sid ?? null;

                const ctx = new DirectoryServiceContext(config, localName, userName, directoryUser);

                let user = await authorizer.tryFindUser(sid, userName, config.allowMatchUsersBySimpleUserName)
                    // Signum also matches the LOCAL name here (`a.UserName == localName`), which the UPN
                    // match above does not cover when the two differ.
                    ?? await authorizer.tryFindUser(null, localName, config.allowMatchUsersBySimpleUserName);

                if (user == null) {
                    if (!config.autoCreateUsers)
                        return fail(throwErrors, LoginAuthMessage.NoLocalUserFound.niceToString());

                    user = await authorizer.onCreateUser(ctx);
                } else {
                    if (user.state === UserState.Deactivated)
                        return fail(throwErrors, LoginAuthMessage.User0IsDeactivated.niceToString(user.userName));

                    if (config.autoUpdateUsers)
                        await authorizer.updateUser(user, ctx);
                }

                if (user.state === UserState.Deactivated)
                    return fail(throwErrors, LoginAuthMessage.User0IsDeactivated.niceToString(user.userName));

                UserHolder.setCurrent(new UserWithClaims(user));
                for (const fn of AuthServer.userLogged) fn(user);
                AuthLogic.onUserLogingIn(user, "WindowsAuthentication");
                return user;
            } catch (e) {
                await logException(e);
                if (throwErrors)
                    throw e;
                return null;
            }
        });
    }

    /** Signum's `throwErrors ? throw … : false` — the silent path must return null, not raise. */
    function fail(throwErrors: boolean, message: string): null {
        if (throwErrors)
            throw new Error(message);
        return null;
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
