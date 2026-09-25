import * as React from "react";
import type { RouteObject } from "react-router";
import { ajaxGet, ajaxPost, ServiceError, AuthTokenFilter, SessionSharing, type AjaxOptions } from "@altea/altea/client/Services";
import * as AppContext from "@altea/altea/client/AppContext";
import { loadReflectionMetadata, setExtraHeaders } from "@altea/altea/client/ReflectionClient";
import { setAccessTokenFactory } from "@altea/altea/client/useWebSocket";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { Metadata } from "@altea/altea/data/metadata";
import type { UserEntity } from "../data/User";
import type { PermissionSymbol } from "@altea/altea/data/permissionSymbol";
import { AuthMessage } from "../data/AuthMessages";
import { TypeAllowedBasic, PropertyAllowed } from "../data/Rules";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import type { Type, Entity, BaseEntity } from "@altea/altea/data/entity";

// Signum's `PropertyRoute.member.minPropertyAllowed` / `maxPropertyAllowed`, on the route itself:
// `UserEntity.propertyRoute(u => u.mixin(UserCareerMixin).careerPaths).propertyAllowed()?.max`. See
// AuthClient.propertyAllowed; undefined when the role cannot read the route's root type.
declare module "@altea/altea/data/propertyRoute" {
    interface PropertyRoute {
        propertyAllowed(): { min: PropertyAllowed; max: PropertyAllowed } | undefined;
    }
}

PropertyRoute.prototype.propertyAllowed = function (this: PropertyRoute) {
    return AuthClient.propertyAllowed(this.rootType, this.propertyString());
};

// Port of Signum.Authorization's AuthClient.tsx — see port/Auth.md.
//
// The CLIENT authentication hub: route registration (startPublic), token storage, the
// request-interception seam (bearer header + token refresh + auth-expiry redirect), auto-login,
// current-user access, and the /api/auth API. ONE file, and a .tsx because startPublic registers JSX
// routes.
//
// The server emits a BARE exceptionType ("AuthenticationException"), so the auth-expiry check matches the
// bare name. `onLogin` / `onLogout` are host hooks set in MainPublic — they THROW until set.

export namespace AuthClient {

    let pendingPasswordChangeUser: UserEntity | undefined;
    export function getPendingPasswordChangeUser(): UserEntity | undefined { return pendingPasswordChangeUser; }
    export function setPendingPasswordChangeUser(v: UserEntity | undefined): void { pendingPasswordChangeUser = v; }

    // A host-supplied password strength/policy check
    // surfaced on the change-password page.
    export interface PasswordValidationResult { message: string; level: "error" | "warning"; }

    export const Options = {
        AuthHeader: "Authorization",
        validatePassword: undefined as ((password: string, user: UserEntity) => Promise<PasswordValidationResult | null>) | undefined,
        onLogout: (): Promise<void> => { throw new Error("AuthClient.Options.onLogout must be set (see MainPublic)"); },
        onLogin: (_back?: string): void => { throw new Error("AuthClient.Options.onLogin must be set (see MainPublic)"); },
        userTicket: false,
        // DEVELOPMENT ONLY: the login form drops its password
        // input and sends the user name as the password. Meant for a local host seeded by
        // the app's own code migrations, which hash each user's name as their password, so any seeded
        // user (System, Steven, Anne, …) is one field away. Purely a CLIENT convenience: the request is
        // still the normal /api/auth/login, so a wrong name fails exactly as it would when typed by hand.
        // The host sets it (see eastwind's MainPublic) behind a dev-only flag; it lives here, on the
        // eagerly-loaded hub, rather than on LoginPage's LoginOptions, which is lazily imported.
        passwordIsUsername: false,
    };

    let notifyLogout = false;
    let logoutListenerRegistered = false;

    // Push the /auth/* routes and wire the cross-tab logout listener.
    // Called from MainPublic (NOT the admin bundle) with the app's routes array, so login / change
    // password are available even when no user is logged in and the full/admin bundle isn't loaded.
    export function startPublic(routes: RouteObject[], options?: { userTicket?: boolean; notifyLogout?: boolean }): void {
        Options.userTicket = options?.userTicket ?? false;

        routes.push({ path: "/auth/login", element: <ImportComponent onImport={() => import("./public/LoginPage")} /> });
        routes.push({ path: "/auth/changePassword", element: <ImportComponent onImport={() => import("./public/ChangePasswordPage")} /> });
        routes.push({ path: "/auth/changePasswordSuccess", element: <ImportComponent onImport={() => import("./public/ChangePasswordSuccessPage")} /> });

        // The cross-tab logout listener is registered AT MOST ONCE. Registering it unconditionally — as
        // Signum does — is a real leak here: a host that follows Southwind's MainPublic calls
        // startPublic from `reload()`, i.e. once per login AND once per logout, so after N credential
        // changes one "log out" broadcast runs logoutInternal N times.
        if ((options?.notifyLogout ?? true) && !logoutListenerRegistered) {
            logoutListenerRegistered = true;
            notifyLogout = true;
            window.addEventListener("storage", se => {
                if (se.key == "requestLogout" + SessionSharing.getAppName()) {
                    const userName = (se.newValue ?? "").split("&&")[0];
                    if (currentUser()?.userName == userName)
                        void logoutInternal();
                }
            });
        }
    }

    // The authenticator chain: cookie / AD login attempts at boot. Empty until a provider registers.
    export const authenticators: Array<() => Promise<AuthenticatedUser | undefined>> = [];

    export interface AuthenticatedUser {
        userEntity: UserEntity;
        token: string;
        authenticationType: AuthenticationType;
    }

    export async function authenticate(): Promise<AuthenticatedUser | undefined> {
        for (const f of authenticators) {
            const aUser = await f();
            if (aUser)
                return aUser;
        }
        return undefined;
    }

    // The in-flight refresh, if any — so N concurrent stale responses cause ONE re-fetch.
    let refreshing: Promise<void> | undefined;
    function refreshCurrentUser(): Promise<void> {
        return refreshing ??= API.fetchCurrentUser(false, /* avoidTokenRefresh */ true)
            .then(cu => { setCurrentUser(cu); }, () => { /* the error filter already handled it */ })
            .finally(() => { refreshing = undefined; });
    }

    /**
     * Signum's `TypeInfo.minTypeAllowed` / `maxTypeAllowed`: the current role's worst and best UI allowance for
     * a type across its condition slices, from the metadata blob. Undefined before the blob is applied, or for
     * a type it does not list (the role cannot read it).
     */
    export function typeAllowed(type: Type<Entity>): { min: TypeAllowedBasic; max: TypeAllowedBasic } | undefined {
        const tm = Metadata.tryType(type.name);
        if (tm == null)
            return undefined;
        const max = tm.maxTypeAllowed ?? TypeAllowedBasic.Write;
        return { min: tm.minTypeAllowed ?? max, max };
    }

    /**
     * Signum's `MemberInfo.minPropertyAllowed` / `maxPropertyAllowed`: the current role's worst and best
     * allowance for a route (root entity type + its property string), from the metadata blob. A route with no
     * entry follows its type. Undefined when the blob does not list the type.
     */
    export function propertyAllowed(rootType: Type<BaseEntity>, path: string): { min: PropertyAllowed; max: PropertyAllowed } | undefined {
        const tm = Metadata.tryType(rootType.name);
        if (tm == null)
            return undefined;
        const rm = tm.routes?.[path];
        const max = rm?.propertyAllowed ?? (tm.maxTypeAllowed ?? TypeAllowedBasic.Write) as number as PropertyAllowed;
        return { min: rm?.minPropertyAllowed ?? max, max };
    }

    export function currentUser(): UserEntity | undefined {
        return AppContext.currentUser as UserEntity | undefined;
    }

    export const onCurrentUserChanged: Array<(newUser: UserEntity | undefined, avoidReRender?: boolean) => void> = [];

    export function setCurrentUser(user: UserEntity | undefined, avoidReRender?: boolean): void {
        const changed = !sameUser(AppContext.currentUser as UserEntity | undefined, user);
        AppContext.setCurrentUser(user);
        if (changed)
            onCurrentUserChanged.forEach(f => f(user, avoidReRender));
    }

    // Server logout, then clear local state + notify other tabs.
    export function logout(): void {
        const user = currentUser();
        if (user == null)
            return;
        void API.logout().then(() => {
            void logoutInternal();
            logoutOtherTabs(user);
        });
    }

    async function logoutInternal(): Promise<void> {
        setAuthToken(undefined, undefined);
        setCurrentUser(undefined);
        await Options.onLogout();
    }

    export function logoutOtherTabs(user: UserEntity): void {
        if (notifyLogout)
            localStorage.setItem("requestLogout" + SessionSharing.getAppName(), user.userName + "&&" + Date.now());
    }

    // The interception seam: attach the bearer token, refresh on New_Token, and
    // on an auth-expiry error clear state + redirect to the login page.
    export function addAuthToken(options: AjaxOptions, makeCall: () => Promise<Response>): Promise<Response> {
        const token = getAuthToken();
        if (!token)
            return makeCall();

        options.headers ??= {};
        options.headers[Options.AuthHeader] = "Bearer " + token;

        return makeCall().then(
            r => {
                const newToken = r.headers.get("New_Token");
                if (newToken) {
                    setAuthToken(newToken, getAuthenticationType());
                    // `avoidTokenRefresh`: this call runs through THIS SAME wrapper, so without it its own
                    // response re-enters here and the two recurse. Signum has the identical shape and only
                    // escapes because the token just stored is fresh, so the next response carries no
                    // header — a termination condition that depends on the server's clock and refresh
                    // interval, not on the code. Shorten the interval (or run two hosts whose clocks
                    // disagree) and it never terminates.
                    //
                    // Coalesced as well: a page issues several requests at once, they all carry the SAME
                    // stale token, so every one of their responses carries New_Token. Without this, one
                    // expiry means N identical re-fetches — and in altea each resolves to setCurrentUser,
                    // whose listener reloads the whole metadata blob and remounts the app.
                    if (!options.avoidTokenRefresh)
                        void refreshCurrentUser();
                }
                return r;
            },
            (e: unknown) => {
                if (e instanceof ServiceError && e.httpError.exceptionType?.endsWith("AuthenticationException")) {
                    setAuthToken(undefined, undefined);
                    setCurrentUser(undefined);
                    AppContext.resetUI();
                    AppContext.navigate("/auth/login");
                }
                throw e;
            },
        );
    }

    export function getAuthToken(): string | undefined {
        return sessionStorage.getItem("authToken") || undefined;
    }
    export function getAuthenticationType(): AuthenticationType | undefined {
        return (sessionStorage.getItem("authenticationType") as AuthenticationType | null) ?? undefined;
    }
    export function setAuthToken(authToken: string | undefined, authenticationType: AuthenticationType | undefined): void {
        sessionStorage.setItem("authToken", authToken ?? "");
        sessionStorage.setItem("authenticationType", authenticationType ?? "");
    }

    /**
     * Ask the server whether THIS browser is remembered.
     *
     * There is NO client-side cookie read to skip the request with, and none to remove: the cookie is
     * HttpOnly (see server/UserTicketServer for why). The endpoint answers null for "no cookie" just as it
     * does for "dead cookie", and clears it server-side in that same response. The cost is one POST per
     * anonymous boot; the gain is that a 60-day credential is not exposed to script.
     */
    export function loginFromCookie(): Promise<AuthenticatedUser | undefined> {
        return API.loginFromCookie().then(au => au ?? undefined);
    }

    // Must run before Reflection starts, i.e. before
    // autoLogin, because the chain is consulted at boot (see MainPublic).
    export function registerUserTicketAuthenticator(): void {
        if (!authenticators.includes(loginFromCookie))
            authenticators.push(loginFromCookie);
    }

    // Resolve the current user at boot from a stored token (or the authenticators).
    export function autoLogin(): Promise<UserEntity | undefined> {
        if (AppContext.currentUser)
            return Promise.resolve(AppContext.currentUser as UserEntity);

        const loginWithAuthToken = (): Promise<UserEntity | undefined> =>
            API.fetchCurrentUser().then(
                u => {
                    if (u.mustChangePassword) {
                        pendingPasswordChangeUser = u;
                        return undefined;
                    }
                    setCurrentUser(u);
                    AppContext.resetUI();
                    return u;
                },
                e => {
                    console.error("autoLogin: stored token rejected:", e);
                    setAuthToken(undefined, undefined);
                    return undefined;
                },
            );

        if (getAuthToken())
            return loginWithAuthToken();

        return authenticate().then(au => {
            if (!au)
                return undefined;
            setAuthToken(au.token, au.authenticationType);
            if (au.userEntity.mustChangePassword) {
                pendingPasswordChangeUser = au.userEntity;
                if (AppContext._internalRouter)
                    AppContext.navigate("/auth/changePassword");
                return undefined;
            }
            setCurrentUser(au.userEntity);
            AppContext.resetUI();
            return au.userEntity;
        });
    }

    // Every `authenticationType` a login route can answer with. Three are not in Signum's TS union:
    // "relogin" (/api/auth/relogin), "openID" (@altea/altea-auth-openid) and "adRegistry" (a Windows AD
    // LDAP bind — its WindowsADAuthorizer returns that one too, it just never reached the union there).
    export type AuthenticationType = "database" | "resetPassword" | "changePassword" | "api-key"
        | "azureAD" | "cookie" | "windows" | "relogin" | "openID" | "adRegistry";

    // It lives HERE rather than in core's client, because permissions are an authorization concept and
    // the value it reads is stamped by this module (server/AuthReflection) onto the permission
    // container's own metadata entry — see the FieldMetadata expansion in ../data/Rules. ABSENT means
    // allowed, so with auth off, or before the blob lands, everything is authorized.
    export function isPermissionAuthorized(permission: PermissionSymbol): boolean {
        const dot = permission.key.indexOf(".");
        if (dot < 0)
            return true;
        const tm = Metadata.tryType(permission.key.slice(0, dot));
        return tm?.fields[permission.key.slice(dot + 1)]?.allowed !== false;
    }

    /** Throws when the current role lacks it. */
    export function assertPermissionAuthorized(permission: PermissionSymbol): void {
        if (!isPermissionAuthorized(permission))
            throw new Error(AuthMessage.NotAuthorizedTo01.niceToString("execute", permission.niceToString()));
    }

    export namespace API {
        export interface LoginRequest { userName: string; password: string; rememberMe?: boolean; }
        export interface LoginResponse { authenticationType: AuthenticationType; message?: string; token: string; userEntity: UserEntity; }
        export interface ChangePasswordRequest { oldPassword: string; newPassword: string; }

        // login is sent WITHOUT the auth token (a stale token must not make the login request itself 403).
        export function login(loginRequest: LoginRequest): Promise<LoginResponse> {
            return ajaxPost({ url: "/api/auth/login", avoidAuthToken: true }, loginRequest);
        }
        export function relogin(): Promise<LoginResponse> {
            return ajaxGet({ url: "/api/auth/relogin" });
        }
        // Sent WITHOUT the auth token, for the same reason login is: at boot there may be a stale one, and
        // the cookie is this request's only credential. Answers null when the browser is not remembered.
        export function loginFromCookie(): Promise<LoginResponse | null> {
            return ajaxPost({ url: "/api/auth/loginFromCookie", avoidAuthToken: true }, undefined);
        }
        export function changePassword(request: ChangePasswordRequest): Promise<LoginResponse> {
            return ajaxPost({ url: "/api/auth/changePassword" }, request);
        }
        export function fetchCurrentUser(refreshToken = false, avoidTokenRefresh = false): Promise<UserEntity> {
            return ajaxGet({
                url: "/api/auth/currentUser" + (refreshToken ? "?refreshToken=true" : ""),
                cache: "no-cache",
                // Set only by the refresh path itself (see addAuthToken) — everyone else wants the normal
                // behaviour, including `fetchCurrentUser(true)`, whose whole point is to force a refresh.
                avoidTokenRefresh,
            });
        }
        export function logout(): Promise<void> {
            return ajaxPost({ url: "/api/auth/logout" }, undefined);
        }
    }
}

// Compare two users by IDENTITY for the change-notification.
function sameUser(a: UserEntity | undefined, b: UserEntity | undefined): boolean {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return a.id === b.id;
}

// Install the interception seam at module load.
AuthTokenFilter.addAuthToken = AuthClient.addAuthToken;

// A WebSocket cannot carry the `Authorization` header, so a hub connection authenticates with its first
// frame instead (see altea/client/useWebSocket.tsx). Same token, same lifetime — installed here so core's
// socket layer stays auth-agnostic, exactly like `setExtraHeaders` below.
setAccessTokenFactory(() => AuthClient.getAuthToken() ?? undefined);

// Attach the bearer token to the reflection-metadata fetch so the server ships the ROLE-FILTERED blob
// — which is why it is refetched per credential change.
setExtraHeaders(() => {
    const token = AuthClient.getAuthToken();
    return token ? { [AuthClient.Options.AuthHeader]: "Bearer " + token } : {};
});

// On any credential change (login / logout / switch user), refetch the (now role-appropriate) metadata
// blob and re-render — so the visible query/type set matches the new role.
//
// `avoidReRender` — a parameter Signum declares on setCurrentUser and neither passes nor honours —
// means the CALLER is rebuilding the application itself. Every login path hands straight off
// to `Options.onLogin`, whose host implementation throws the React root away and builds a new one over a
// new route table, loading the blob on its way (eastwind's MainPublic `reload()`). Doing it here too is
// not merely a duplicate request: the refetch resolves in a fraction of the rebuild, so its `resetUI()`
// remounts the tree UNDER the login form, which comes back with fresh state — an enabled user name box
// and a "Login" button — for the second or so the rebuild still has to run. Disabled, then writable
// again, then gone: the one state the form must never show is the one that invites a second submit.
AuthClient.onCurrentUserChanged.push((_user, avoidReRender) => {
    if (avoidReRender)
        return;
    void loadReflectionMetadata().then(() => AppContext.resetUI());
});
