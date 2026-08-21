import { WebBuilder, CustomType, setAuthorizeRequest, type HttpMeta } from "@altea/altea/server/webApi";
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
import { AuthTokenServer, type AuthTokenConfiguration } from "./AuthTokenServer";
import { AuthReflectionServer } from "./AuthReflection";
import { AuthAdminServer } from "./AuthAdminServer";
import { ActiveDirectoryServer } from "./ActiveDirectoryServer";

// Port of Signum's AuthServer + AuthController (AuthServer.cs + AuthController.cs) — the HTTP surface of
// authentication: a per-request user-context middleware plus the /api/auth/* endpoints. The large
// authorization-integration block of Signum's AuthServer.Start (Type/Property/Query/Operation/Permission
// reflection extensions) belongs to Phases 4-5 and is intentionally absent here.
//
// SECURE BY DEFAULT (Signum's SignumAuthenticationFilter). Two cooperating pieces:
//  1. A per-request `app.use` middleware opens a UserHolder scope and authenticates via the token
//     authenticator chain (setting the current user when a valid token is present).
//  2. An authorization gate installed via `setAuthorizeRequest` runs in every route wrapper AFTER
//     routing: it DENIES the request (throws AuthenticationException → 403) unless a user is
//     authenticated OR the matched route is declared `allowAnonymous`. So a route is protected unless
//     it opts out — the login endpoint, the boot reflection metadata, and client-error reporting are
//     the anonymous opt-outs.
// A configured AnonymousUser (AuthLogic.anonymousUserName) still counts as "authenticated" for the gate.
// Seams left as no-ops: rememberMe cookie (UserTicket), SessionLog, OnUserPreLogin.

interface LoginRequest { userName?: string; password?: string; rememberMe?: boolean; }
interface ChangePasswordRequest { oldPassword?: string; newPassword?: string; }
interface LoginResponse { authenticationType: string; token: string; userEntity: UserEntity; }

// Minimal Express request/response shapes — altea-auth does not depend on @types/express, so the
// middleware types the raw Express objects structurally (a supertype of Express's Request/Response,
// so the handler is still assignable where Express expects a RequestHandler).
interface ReqLike { header(name: string): string | undefined; query: Record<string, unknown>; body?: string; }
interface ResLike { status(code: number): ResLike; json(body: unknown): void; end(): void; setHeader(name: string, value: string): void; }
type NextLike = (err?: unknown) => void;

export namespace AuthServer {
    export let avoidExplicitErrorMessages = false;

    // Signum's UserLoggingOut / UserPreLogin / UserLogged events (host hooks; SessionLog wires here later).
    export const userLoggingOut: ((user: UserWithClaims | undefined) => void)[] = [];
    export const userLogged: ((user: UserEntity) => void)[] = [];

    /** Wire authentication: token config + per-request middleware + the /api/auth routes. Call BEFORE
     *  SignumServer.start(ws) so the middleware runs before the framework routes and the auth routes are
     *  registered before the terminal exception filter. */
    export function start(ws: WebBuilder, encryptionKey?: string, config?: Partial<AuthTokenConfiguration>): void {
        // The token-encryption key comes from AUTH_TOKEN_KEY unless one is passed explicitly; a dev
        // fallback is used with a warning (NEVER a real secret — set AUTH_TOKEN_KEY for anything but local
        // dev). Read here (rather than in the host) so wiring is self-contained: AuthLogic.start calls
        // AuthServer.start(sb.webBuilder) when a web builder is present, like Signum's AuthServer.Start.
        let key = encryptionKey ?? process.env["AUTH_TOKEN_KEY"];
        if (key == null || key === "") {
            key = "eastwind-dev-only-token-key";
            console.warn("[auth] AUTH_TOKEN_KEY not set — using an insecure dev fallback. Set it in the environment.");
        }
        AuthTokenServer.start(key, config);
        installMiddleware(ws);
        // Secure-by-default gate: deny any route that is not allowAnonymous when no user is authenticated.
        setAuthorizeRequest(authorizeGate);
        startRoutes(ws);
        // The rest of the auth HTTP surface: the role-filtered reflection blob (a limited role's
        // non-readable types' queries are dropped from /api/reflection/metadata) and the rule-pack admin
        // endpoints (/api/authAdmin/*). Registered here so AuthLogic.start wires ALL auth routes in one
        // call; their handlers/filters run at request time, after the authorization logics have started.
        AuthReflectionServer.install();
        AuthAdminServer.start(ws);
        // The shared BaseAD routes (find / import a directory user). Signum's ActiveDirectoryController
        // lives in Signum.Authorization and is always discovered by ASP.NET, so it is always reachable;
        // altea registers it here for the same reason — and because a host may install BOTH a directory
        // module and none of them may own the route. With no `IDirectoryInviter` authorizer set the routes
        // answer a clear error, and the permission gate answers false.
        ActiveDirectoryServer.start(ws);
    }

    // Signum's SignumAuthenticationFilter authorization check (the AllowAnonymous / anonymous-user
    // resolution having already run in the middleware). Runs inside the request's user scope.
    function authorizeGate(meta: HttpMeta): void {
        if (!meta.allowAnonymous && UserHolder.current() == null)
            throw new AuthenticationException(LoginAuthMessage.NotUserLogged.niceToString());
    }

    function installMiddleware(ws: WebBuilder): void {
        const middleware = (req: ReqLike, res: ResLike, next: NextLike): void => {
            // Open a fresh per-request user scope; authenticate within it, then continue the pipeline
            // INSIDE the scope so downstream handlers see UserHolder.current() (AsyncLocalStorage
            // propagates across the awaited continuation).
            UserHolder.withScope(() => {
                authenticate(req, res).then(
                    uwc => { if (uwc != null) UserHolder.setCurrent(uwc); next(); },
                    next,
                );
            });
        };
        (ws.app.use as (h: unknown) => void)(middleware);
    }

    async function authenticate(req: ReqLike, res: ResLike): Promise<UserWithClaims | undefined> {
        const reqLike = { header: (n: string) => req.header(n) ?? undefined, hasQuery: (n: string) => req.query[n] != null };
        const resLike = { setHeader: (n: string, v: string) => { res.setHeader(n, v); } };
        for (const authenticator of AuthTokenServer.authenticators) {
            const result = await authenticator(reqLike, resLike);
            if (result != null)
                return result;
        }
        // Permissive fallback: a configured AnonymousUser, else undefined (request proceeds anonymous).
        const anon = await AuthLogic.anonymousUser();
        return anon != null ? new UserWithClaims(anon) : undefined;
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
                // rememberMe → UserTicket cookie (deferred seam): data.rememberMe intentionally unused.

                const token = AuthTokenServer.createToken(user);
                res.jsonTyped({ authenticationType: "database", token, userEntity: user });
            });

        // GET /api/auth/currentUser → the full current user, or null when anonymous.
        ws.get("/api/auth/currentUser",
            { res: CustomType<UserEntity | null>() },
            async (_req, res) => {
                const current = UserHolder.current();
                if (current == null) { res.jsonTyped(null); return; }
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

        // POST /api/auth/logout — clears the server session hooks (client drops its token).
        ws.post("/api/auth/logout", {}, async (_req, res) => {
            for (const fn of userLoggingOut) fn(UserHolder.current());
            // UserTicket cookie removal is a deferred seam.
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

// Signum's UserEntity.OnValidatePassword (min 5 chars). Kept here for now (a UserEntity.validatePassword
// hook can host it later).
function validatePassword(password: string): string | null {
    return password.length >= 5 ? null : LoginAuthMessage.ThePasswordMustHaveAtLeast0Characters.niceToString(5);
}

// Signum's AuthController exception → field-error mapping (respecting AvoidExplicitErrorMessages).
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
// ValidationError. altea's ModelState is ONE string per field (not Signum's string[]), matching
// webApi's res.modelState / the exceptionFilter's IntegrityCheck body.
function modelError(res: ResLike, field: string, message: string): void {
    res.status(400).json({ [field]: message });
}
