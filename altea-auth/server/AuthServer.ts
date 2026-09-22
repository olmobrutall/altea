import { WebBuilder, CustomType, type HttpMeta } from "@altea/altea/server/webApi";
import { setAuthorizeRequest } from "@altea/altea/server/filters/authorizationFilter";
import { setUserCultureProvider } from "@altea/altea/server/filters/cultureFilter";
import { useUserScope } from "./filters/userScope";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserWithClaims } from "@altea/altea/data/security";
import { AuthenticationException } from "@altea/altea/server/exceptions";
import * as Database from "@altea/altea/server/Database";
import { PasswordEncoding } from "@altea/altea/server/passwordEncoding";
import { UserEntity } from "../data/User";
import { LoginAuthMessage } from "../data/AuthMessages";
import {
    AuthLogic, decodeHash,
    IncorrectUsernameException, IncorrectPasswordException, UserLockedException,
} from "./AuthLogic";
import { AuthTokenServer } from "./AuthTokenServer";
import type { AuthTokenConfigurationEmbedded } from "../data/AuthToken";
import { AuthReflectionServer } from "./AuthReflection";
import { AuthAdminServer } from "./AuthAdminServer";
import { ActiveDirectoryServer } from "./ActiveDirectoryServer";
import { UserTicketLogic } from "./UserTicketLogic";
import { UserTicketServer } from "./UserTicketServer";
import { SessionLogLogic } from "./SessionLogLogic";

// Port of Signum.Authorization's AuthServer.cs + AuthController.cs — see port/Auth.md.
//
// The HTTP surface of authentication: the per-request user scope plus the /api/auth/* endpoints. The
// role-filtering overlay on the reflection blob is installed from here too — see AuthReflection.
//
// SECURE BY DEFAULT. Two cooperating pieces, at two different levels:
//  1. `useUserScope` (filters/userScope) — APP-level Express middleware, mounted first: it opens a
//     UserHolder scope and authenticates via the token authenticator chain, setting the current user when
//     a valid token is present. App-level rather than a route filter because middleware outside routing
//     reads it (isolation, the REST log).
//  2. An authorization gate installed via `setAuthorizeRequest`, which core runs as a route FILTER, AFTER
//     routing (so meta.allowAnonymous is known): it DENIES the request (throws AuthenticationException →
//     403) unless a user is authenticated OR the matched route is declared `allowAnonymous`. So a route
//     is protected unless it opts out — the login endpoint, the boot reflection metadata, and
//     client-error reporting are the anonymous opt-outs.
// A configured AnonymousUser (AuthLogic.anonymousUserName) still counts as "authenticated" for the gate.
// Seams left as no-ops: OnUserPreLogin. (rememberMe → UserTicketServer, SessionLog → SessionLogLogic.)

interface LoginRequest { userName?: string; password?: string; rememberMe?: boolean; }
interface ChangePasswordRequest { oldPassword?: string; newPassword?: string; }
interface LoginResponse { authenticationType: string; token: string; userEntity: UserEntity; }

// Minimal Express request/response shapes — altea-auth does not depend on @types/express, so the
// middleware types the raw Express objects structurally (a supertype of Express's Request/Response,
// so the handler is still assignable where Express expects a RequestHandler).
interface ReqLike { header(name: string): string | undefined; query: Record<string, unknown>; body?: string; }
interface ResLike { status(code: number): ResLike; json(body: unknown): void; end(): void; setHeader(name: string, value: string): void; }
type NextLike = (err?: unknown) => void;

/** The request's Host header — the host it was addressed to. */
function hostOf(req: { header(name: string): string | undefined }): string | null {
    return req.header("host") ?? null;
}

export namespace AuthServer {
    export let avoidExplicitErrorMessages = false;

    // Host hooks: SessionLog wires onto these.
    export const userLoggingOut: ((user: UserWithClaims | undefined) => void)[] = [];
    export const userLogged: ((user: UserEntity) => void)[] = [];

    /** Wire authentication: token config + per-request middleware + the /api/auth routes. Call BEFORE
     *  SignumServer.start(ws) so the middleware runs before the framework routes and the auth routes are
     *  registered before the terminal exception filter. */
    export function start(ws: WebBuilder, encryptionKey?: string,
        getConfiguration?: () => Promise<AuthTokenConfigurationEmbedded>): void {
        // The token-encryption key comes from AUTH_TOKEN_KEY unless one is passed explicitly; a dev
        // fallback is used with a warning (NEVER a real secret — set AUTH_TOKEN_KEY for anything but local
        // dev). Read here (rather than in the host) so wiring is self-contained: AuthLogic.start calls
        // AuthServer.start(sb.webBuilder) when a web builder is present.
        let key = encryptionKey ?? process.env["AUTH_TOKEN_KEY"];
        if (key == null || key === "") {
            key = "eastwind-dev-only-token-key";
            console.warn("[auth] AUTH_TOKEN_KEY not set — using an insecure dev fallback. Set it in the environment.");
        }
        AuthTokenServer.start(key, getConfiguration);
        // The per-request user scope. APP-level, and mounted first, because things OUTSIDE routing read
        // it — altea-isolation resolves the tenant in its own `app.use`, altea-rest stamps the log row —
        // so it cannot be one of core's route filters. See filters/userScope.
        useUserScope(ws);
        // Secure-by-default gate: deny any route that is not allowAnonymous when no user is authenticated.
        setAuthorizeRequest(authorizeGate);
        startRoutes(ws);
        // The rest of the auth HTTP surface: the role-filtered reflection blob (a limited role's
        // non-readable types' queries are dropped from /api/reflection/metadata) and the rule-pack admin
        // endpoints (/api/authAdmin/*). Registered here so AuthLogic.start wires ALL auth routes in one
        // call; their handlers/filters run at request time, after the authorization logics have started.
        AuthReflectionServer.install();
        // Step 2 of webApi's culture chain (Signum's `UserHolder.CurrentUserCulture`): a logged-in user's
        // own preference, which beats the browser's Accept-Language but loses to the `language` cookie the
        // picker sets. Core cannot read it — it has no notion of a user — so auth fills the seam. The name
        // rides in the claims bag (see data/User's fillClaims), so this costs no retrieve.
        setUserCultureProvider(() => UserHolder.current()?.claims["Culture"] as string | undefined);
        AuthAdminServer.start(ws);
        // The shared BaseAD routes (find / import a directory user). Signum's ActiveDirectoryController
        // lives in the same assembly and is always discovered by ASP.NET, so it is always reachable;
        // altea registers it here for the same reason — and because a host may install BOTH a directory
        // module and none of them may own the route. With no `IDirectoryInviter` authorizer set the routes
        // answer a clear error, and the permission gate answers false.
        ActiveDirectoryServer.start(ws);
    }

    // The authorization check (the allowAnonymous / anonymous-user
    // resolution having already run in the middleware). Runs inside the request's user scope.
    function authorizeGate(meta: HttpMeta): void {
        if (!meta.allowAnonymous && UserHolder.current() == null)
            throw new AuthenticationException(LoginAuthMessage.NotUserLogged.niceToString());
    }

    export function startRoutes(ws: WebBuilder): void {
        // POST /api/auth/login — anonymous (you can't be logged in to log in). The client sends this
        // with avoidAuthToken so a stale token can't make the login request itself 403.
        ws.post("/api/auth/login",
            { req: CustomType<LoginRequest>(), res: CustomType<LoginResponse>(), allowAnonymous: true },
            async (req, res) => {
                const data = readBody<LoginRequest>(req);
                if (isEmpty(data.userName))
                    return modelError(res, "userName", LoginAuthMessage.UserNameMustHaveAValue.niceToString());
                if (isEmpty(data.password))
                    return modelError(res, "password", LoginAuthMessage.PasswordMustHaveAValue.niceToString());

                let user: UserEntity;
                try {
                    const result = AuthLogic.authorizer != null
                        ? await AuthLogic.authorizer.login(data.userName!, data.password!)
                        : await AuthLogic.login(data.userName!, data.password!);
                    user = result.user;
                } catch (e) {
                    return loginError(res, e, data.userName!);
                }

                UserHolder.setCurrent(new UserWithClaims(user));
                for (const fn of userLogged) fn(user);

                // SessionLog hangs off the `userLogged` event (guarded by
                // `SessionLogLogic.IsStarted`). altea calls it here for the same reason it is a call and not
                // a subscription: the row wants the REQUEST (host + user agent), which the event does not
                // carry. Awaited, so a login cannot outrun its own log row.
                if (SessionLogLogic.isStarted())
                    await SessionLogLogic.sessionStart(hostOf(req), req.header("user-agent") ?? null);

                // Silently a NO-OP when the UserTicket half was never started (the app did not call
                // UserTicketLogic.start): the checkbox is a client concern, and a login must not fail
                // because the server does not remember devices.
                if (data.rememberMe === true && UserTicketLogic.isStarted())
                    await UserTicketServer.onSaveCookie(req, res);

                const token = AuthTokenServer.createToken(user);
                res.jsonTyped({ authenticationType: "database", token, userEntity: user });
            });

        // GET /api/auth/currentUser → the full current user, or null when anonymous.
        ws.get("/api/auth/currentUser",
            { res: CustomType<UserEntity | null>() },
            async (_req, res) => {
                const current = UserHolder.current();
                if (current == null) { res.jsonTyped(null); return; }
                // With an anonymous
                // user configured, EVERY unauthenticated request has a current user — this one — and the
                // client must not read that as "logged in": `AppContext.currentUser` is what decides whether
                // the admin bundle loads, and `Home` sends a visitor with no user to the public catalog.
                const anon = await AuthLogic.anonymousUser();
                if (anon != null && current.user.is(anon)) { res.jsonTyped(null); return; }
                const user = await Database.retrieve(UserEntity, current.user.id);
                res.jsonTyped(user);
            });

        // GET /api/auth/relogin → refresh the token for the current user.
        ws.get("/api/auth/relogin",
            { res: CustomType<LoginResponse | null>() },
            async (_req, res) => {
                const current = UserHolder.current();
                if (current == null) { res.jsonTyped(null); return; }
                const user = await Database.retrieve(UserEntity, current.user.id);
                AuthLogic.onUserLogingIn(user, "Relogin");
                res.jsonTyped({ authenticationType: "relogin", token: AuthTokenServer.createToken(user), userEntity: user });
            });

        // POST /api/auth/loginFromCookie — the returning-browser path, ANONYMOUS by definition (the
        // caller has no token yet; the cookie is the credential). Answers null when this browser is not
        // remembered, which is what the client's authenticator chain reads as "try the next one".
        ws.post("/api/auth/loginFromCookie",
            { res: CustomType<LoginResponse | null>(), allowAnonymous: true },
            async (req, res) => {
                if (!UserTicketLogic.isStarted()) { res.jsonTyped(null); return; }

                const user = await UserTicketServer.loginFromCookie(req, res);
                if (user == null) { res.jsonTyped(null); return; }

                UserHolder.setCurrent(new UserWithClaims(user));
                for (const fn of userLogged) fn(user);
                AuthLogic.onUserLogingIn(user, "LoginFromCookie");

                res.jsonTyped({ authenticationType: "cookie", token: AuthTokenServer.createToken(user), userEntity: user });
            });

        // POST /api/auth/logout — clears the server session hooks (client drops its token).
        ws.post("/api/auth/logout", {}, async (req, res) => {
            const current = UserHolder.current();
            for (const fn of userLoggingOut) fn(current);

            // Signum declares SessionLogLogic.SessionEnd and never calls it, so its session rows never
            // close — see SessionLogLogic's header. This is that missing call. `timeOut` is null: this IS
            // the user leaving, not us noticing later that they had.
            if (SessionLogLogic.isStarted() && current != null) {
                const user = await Database.retrieve(UserEntity, current.user.id);
                await SessionLogLogic.sessionEnd(user, null);
            }
            // Logging out must stop the
            // browser being remembered, or the next boot would log straight back in.
            if (UserTicketLogic.isStarted())
                UserTicketServer.removeCookie(req, res);
            res.status(200).end();
        });

        // POST /api/auth/changePassword
        ws.post("/api/auth/changePassword",
            { req: CustomType<ChangePasswordRequest>(), res: CustomType<LoginResponse>() },
            async (req, res) => {
                const request = readBody<ChangePasswordRequest>(req);
                if (isEmpty(request.newPassword))
                    return modelError(res, "newPassword", LoginAuthMessage.PasswordMustHaveAValue.niceToString());

                const current = UserHolder.current();
                if (current == null)
                    return modelError(res, "newPassword", LoginAuthMessage.NotUserLogged.niceToString());
                const user = await Database.retrieve(UserEntity, current.user.id);

                const passwordError = validatePassword(request.newPassword!);
                if (passwordError != null)
                    return modelError(res, "newPassword", passwordError);

                // Verify the old password (unless the account has none set yet).
                if (isEmpty(request.oldPassword)) {
                    if (user.passwordHash != null)
                        return modelError(res, "oldPassword", LoginAuthMessage.PasswordMustHaveAValue.niceToString());
                } else {
                    const stored = decodeHash(user.passwordHash);
                    const candidates = [
                        PasswordEncoding.hashPassword(user.userName, request.oldPassword!),
                        ...PasswordEncoding.hashPasswordAlternatives(user.userName, request.oldPassword!),
                    ];
                    if (stored == null || !candidates.some(c => PasswordEncoding.sequenceEqual(c, stored)))
                        return modelError(res, "oldPassword", LoginAuthMessage.InvalidPassword.niceToString());
                }

                user.passwordHash = PasswordEncoding.hashPassword(user.userName, request.newPassword!);
                user.mustChangePassword = false;
                await AuthLogic.withDisabled(() => user.save());

                res.jsonTyped({ authenticationType: "changePassword", token: AuthTokenServer.createToken(user), userEntity: user });
            });
    }
}

// Minimum 5 characters. Kept here for now (a UserEntity.validatePassword
// hook can host it later).
function validatePassword(password: string): string | null {
    return password.length >= 5 ? null : LoginAuthMessage.ThePasswordMustHaveAtLeast0Characters.niceToString(5);
}

// The exception → field-error mapping (respecting avoidExplicitErrorMessages).
function loginError(res: ResLike, e: unknown, userName: string): void {
    if (AuthServer.avoidExplicitErrorMessages)
        return modelError(res, "login", LoginAuthMessage.InvalidUsernameOrPassword.niceToString());
    if (e instanceof IncorrectUsernameException)
        return modelError(res, "userName", LoginAuthMessage.InvalidUsername.niceToString());
    if (e instanceof IncorrectPasswordException)
        return modelError(res, "password", LoginAuthMessage.InvalidPassword.niceToString());
    if (e instanceof UserLockedException)
        return modelError(res, "password", LoginAuthMessage.User0IsDeactivated.niceToString(userName));
    return modelError(res, "login", e instanceof Error ? e.message : String(e));
}

function readBody<T>(req: { body?: string }): T {
    return (req.body != null && req.body !== "" ? JSON.parse(req.body) : {}) as T;
}

function isEmpty(s: string | undefined | null): boolean {
    return s == null || s === "";
}

// Flat ModelState (field → message), the shape the client's ThrowErrorFilter turns into a
// ValidationError. The ModelState is ONE string per field, matching
// webApi's res.modelState / the exceptionFilter's IntegrityCheck body.
function modelError(res: ResLike, field: string, message: string): void {
    res.status(400).json({ [field]: message });
}
