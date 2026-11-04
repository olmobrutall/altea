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
import type { LoginResponse } from "@altea/altea-auth/data/AuthDtos";
import { LoginAuthMessage } from "@altea/altea-auth/data/AuthMessages";
import { WindowsADMessage } from "../data/WindowsAD";
import { DirectoryServiceContext, WindowsADAuthorizer } from "./WindowsADAuthorizer";
import { WindowsADLogic } from "./WindowsADLogic";
import { localNameOf } from "./WindowsDirectory";

// The two routes: integrated Windows sign-in, and the AD thumbnail photo.
//
// ══ THE ONE THING THAT DOES NOT PORT ═══════════════════════════════════════════════════════════════════
// Reading the caller's Windows identity needs a completed SPNEGO / Kerberos handshake, which IIS does for
// an ASP.NET host. Node has no SSPI and no portable way to complete that handshake in-process.
//
// So `negotiateProvider` is a SEAM, null by default: with none installed the endpoint answers a clear error
// instead of pretending. This package ships two, each behind an optional dependency: KerberosNegotiate (a
// Linux host with a keytab — production) and SspiNegotiate (a Windows workstation, where Windows checks the
// token — local development). A host may also install its own, e.g. one reading a trusted proxy's header:
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
// This path looks the user up BY SID first — the SID is what the handshake yields — rather than going
// straight through `ADAuthorizer.findOrCreateUser`.
//
// See port/AuthDirectory.md.

/** What a Negotiate provider must yield: the Windows account name, and its SID when it knows it. */
export interface NegotiatedIdentity {
    /** `DOMAIN\user` or `user@domain` — whatever the handshake produced. */
    userName: string;
    /** The canonical SID string, or null to have it looked up in the directory. */
    sid: string | null;
    /** The server's final SPNEGO token, sent back for mutual authentication (`WWW-Authenticate: Negotiate …`). */
    responseToken?: string | null;
}

/**
 * A handshake that needs another round trip (NTLM inside Negotiate: the browser's NEGOTIATE message is answered
 * with a CHALLENGE, and only its AUTHENTICATE message names the user). The endpoint answers
 * `401 WWW-Authenticate: Negotiate <continueToken>`, and the browser sends its next token on the same connection.
 * A Kerberos ticket completes in one step and never yields this.
 */
export interface NegotiateContinue {
    continueToken: string;
}

export type NegotiateProvider = (req: unknown) => Promise<NegotiatedIdentity | NegotiateContinue | null>;

/** The base64 SPNEGO token of an `Authorization: Negotiate …` header, or null when the browser sent none. */
export function negotiateToken(req: unknown): string | null {
    const header = (req as { headers?: Record<string, string | string[] | undefined> }).headers?.["authorization"];
    const value = Array.isArray(header) ? header[0] : header;
    const match = value == null ? null : /^Negotiate\s+(\S+)/i.exec(value);
    return match?.[1] ?? null;
}


interface ResLike {
    setHeader(name: string, value: string): void;
    status(code: number): { end(): void };
    type(t: string): { send(body: unknown): void };
}

export namespace WindowsADServer {

    /** See the header. Null by default: this host cannot do integrated Windows authentication. */
    export let negotiateProvider: NegotiateProvider | null = null;

    /** 7 hours. */
    export let pictureMaxAgeSeconds = 7 * 60 * 60;

    export function start(ws: WebBuilder): void {

        // POST /api/auth/loginWindowsAuthentication?throwError=true
        ws.post("/api/auth/loginWindowsAuthentication",
            { res: CustomType<LoginResponse | null>(), allowAnonymous: true },
            async (req, res) => {
                const query = req.query;
                const throwErrors = (query["throwError"] ?? "false") === "true";

                // A browser sends its Windows ticket only when asked (IIS asks for an ASP.NET host): answer the
                // first, ticketless request with the Negotiate challenge, and the browser retries with one.
                if (negotiateProvider != null && negotiateToken(req) == null) {
                    res.setHeader("WWW-Authenticate", "Negotiate");
                    res.status(401).end();
                    return;
                }

                let continueToken: string | undefined;
                const user = await loginWindowsAuthentication(req, throwErrors, identity => {
                    if (identity.responseToken)
                        res.setHeader("WWW-Authenticate", `Negotiate ${identity.responseToken}`);
                }, token => { continueToken = token; });
                if (continueToken != null) {
                    res.setHeader("WWW-Authenticate", `Negotiate ${continueToken}`);
                    res.status(401).end();
                    return;
                }
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
                const { username } = req.params;
                const response = res;
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

    /**
     * Integrated sign-in: resolve the caller's Windows identity, then find or create the local user.
     * `onContinue` receives the token of a handshake that needs another round trip (see NegotiateContinue);
     * the result is then null and the caller answers the 401 with it.
     */
    export async function loginWindowsAuthentication(req: unknown, throwErrors: boolean,
        onNegotiated?: (identity: NegotiatedIdentity) => void,
        onContinue?: (continueToken: string) => void): Promise<UserEntity | null> {
        return await AuthLogic.withDisabled(async () => {
            try {
                const authorizer = AuthLogic.authorizer;
                if (!(authorizer instanceof WindowsADAuthorizer))
                    return fail(throwErrors, "No WindowsADAuthorizer set in AuthLogic.authorizer");

                const config = await authorizer.getConfig();
                if (config == null)
                    return fail(throwErrors, "No WindowsADConfiguration is set");

                if (!config.loginWithWindowsAuthenticator)
                    return fail(throwErrors, "loginWithWindowsAuthenticator is set to false");

                if (negotiateProvider == null)
                    return fail(throwErrors, WindowsADMessage.WindowsIntegratedAuthenticationIsNotConfiguredOnThisHost.niceToString());

                const negotiated = await negotiateProvider(req);
                if (negotiated != null && "continueToken" in negotiated) {
                    if (onContinue == null)
                        return fail(throwErrors, "The Negotiate handshake needs another round trip, which this caller cannot answer");
                    onContinue(negotiated.continueToken);
                    return null;
                }
                const identity = negotiated;
                if (identity == null)
                    return fail(throwErrors, "The Negotiate provider did not resolve a Windows identity");

                onNegotiated?.(identity);

                const userName = identity.userName;
                const localName = localNameOf(userName);

                const ctx = new DirectoryServiceContext(config, localName, userName);

                // As Signum: the local user first — by the SID the handshake gave, then by name — and the
                // directory only when a user has to be created or updated. A sign-in of a known user then
                // needs no LDAP round trip (and works when the directory is slow or out of reach).
                const findUser = (sid: string | null): Promise<UserEntity | null> =>
                    authorizer.tryFindUser(sid, userName, config.allowMatchUsersBySimpleUserName)
                        // The LOCAL name is matched too, which the UPN
                        // match above does not cover when the two differ.
                        .then(u => u ?? authorizer.tryFindUser(null, localName, config.allowMatchUsersBySimpleUserName));

                let user = await findUser(identity.sid);

                if (user == null) {
                    // A Kerberos ticket names the account but carries no SID: the directory's SID still finds
                    // a user whose account was renamed.
                    const directoryUser = await ctx.getDirectoryUser();
                    if (identity.sid == null && directoryUser.sid != null)
                        user = await findUser(directoryUser.sid);
                }

                if (user == null) {
                    if (!config.autoCreateUsers)
                        return fail(throwErrors, LoginAuthMessage.NoLocalUserFound.niceToString());

                    user = await authorizer.onCreateUser(ctx);
                } else {
                    if (user.state === UserState.Deactivated)
                        return fail(throwErrors, LoginAuthMessage.User0IsDeactivated.niceToString(user.userName));

                    if (config.autoUpdateUsers) {
                        await ctx.getDirectoryUser();
                        await authorizer.updateUser(user, ctx);
                    }
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

    /** The silent path must return null, not raise. */
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
