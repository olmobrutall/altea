import * as React from "react";
import type { RouteObject } from "react-router";
import { ajaxGet, ajaxPost, ServiceError, AuthTokenFilter, SessionSharing, type AjaxOptions } from "@altea/altea/client/Services";
import * as AppContext from "@altea/altea/client/AppContext";
import { loadReflectionMetadata, setExtraHeaders } from "@altea/altea/client/ReflectionClient";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import type { UserEntity } from "../data/User";

// Port of Signum's AuthClient (AuthClient.tsx) — the CLIENT authentication hub: route registration
// (startPublic), token storage, the request-interception seam (bearer header + token refresh +
// auth-expiry redirect), auto-login, current-user access, and the /api/auth API. As in Signum this is
// ONE file (a .tsx, since startPublic registers JSX routes).
//
// altea divergences, documented inline:
//  - Signum's `startPublic({routes, …})` → `startPublic(cb)` taking the ClientBuilder (owns cb.routes).
//  - the interception seam is `Services.AuthTokenFilter.addAuthToken` (a bare `let`), not Signum's
//    `.Options.addAuthToken`.
//  - the server emits a BARE exceptionType ("AuthenticationException"), so the auth-expiry check matches
//    the bare name, not Signum's `.AuthenticationException`.
//  - UserTicket cookie login is deferred (`registerUserTicketAuthenticator` is a seam).
//  - `onLogin`/`onLogout` are host hooks (set in MainPublic) — they throw until set, like Signum.

export namespace AuthClient {

    let pendingPasswordChangeUser: UserEntity | undefined;
    export function getPendingPasswordChangeUser(): UserEntity | undefined { return pendingPasswordChangeUser; }
    export function setPendingPasswordChangeUser(v: UserEntity | undefined): void { pendingPasswordChangeUser = v; }

    // Signum's AuthClient.PasswordValidationResult — a host-supplied password strength/policy check
    // surfaced on the change-password page.
    export interface PasswordValidationResult { message: string; level: "error" | "warning"; }

    export const Options = {
        AuthHeader: "Authorization",
        validatePassword: undefined as ((password: string, user: UserEntity) => Promise<PasswordValidationResult | null>) | undefined,
        onLogout: (): Promise<void> => { throw new Error("AuthClient.Options.onLogout must be set (see MainPublic)"); },
        onLogin: (_back?: string): void => { throw new Error("AuthClient.Options.onLogin must be set (see MainPublic)"); },
        userTicket: false,
        // altea addition (no Signum counterpart) — DEVELOPMENT ONLY: the login form drops its password
        // input and sends the user name as the password. Meant for a local host seeded by
        // EastwindMigrations.ensureUser, which hashes each user's name as their password, so any seeded
        // user (System, Steven, Anne, …) is one field away. Purely a CLIENT convenience: the request is
        // still the normal /api/auth/login, so a wrong name fails exactly as it would when typed by hand.
        // The host sets it (see eastwind's MainPublic) behind a dev-only flag; it lives here, on the
        // eagerly-loaded hub, rather than on LoginPage's LoginOptions, which is lazily imported.
        passwordIsUsername: false,
    };

    let notifyLogout = false;

    // Signum's AuthClient.startPublic: push the /auth/* routes and wire the cross-tab logout listener.
    // Called from MainPublic (NOT the admin bundle) with the app's routes array, so login / change
    // password are available even when no user is logged in and the full/admin bundle isn't loaded.
    export function startPublic(routes: RouteObject[], options?: { userTicket?: boolean; notifyLogout?: boolean }): void {
        Options.userTicket = options?.userTicket ?? false;

        routes.push({ path: "/auth/login", element: <ImportComponent onImport={() => import("./public/LoginPage")} /> });
        routes.push({ path: "/auth/changePassword", element: <ImportComponent onImport={() => import("./public/ChangePasswordPage")} /> });
        routes.push({ path: "/auth/changePasswordSuccess", element: <ImportComponent onImport={() => import("./public/ChangePasswordSuccessPage")} /> });

        if (options?.notifyLogout ?? true) {
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

    // Signum's authenticators chain (cookie / AD login attempts at boot). Empty until a provider registers.
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

    // Signum's `logout()` — server logout, then clear local state + notify other tabs.
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

    // The interception seam (Signum's addAuthToken): attach the bearer token, refresh on New_Token, and
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
                    void API.fetchCurrentUser().then(cu => setCurrentUser(cu));
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

    // Signum's registerUserTicketAuthenticator — cookie login. Deferred seam (no cookie plumbing yet).
    export function registerUserTicketAuthenticator(): void {
        // authenticators.push(loginFromCookie);  // enabled when UserTicket is ported
    }

    // Signum's autoLogin: resolve the current user at boot from a stored token (or the authenticators).
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

    export type AuthenticationType = "database" | "resetPassword" | "changePassword" | "api-key" | "azureAD" | "cookie" | "windows";

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
        export function changePassword(request: ChangePasswordRequest): Promise<LoginResponse> {
            return ajaxPost({ url: "/api/auth/changePassword" }, request);
        }
        export function fetchCurrentUser(refreshToken = false): Promise<UserEntity> {
            return ajaxGet({ url: "/api/auth/currentUser" + (refreshToken ? "?refreshToken=true" : ""), cache: "no-cache" });
        }
        export function logout(): Promise<void> {
            return ajaxPost({ url: "/api/auth/logout" }, undefined);
        }
    }
}

// Compare two users by identity for the change-notification (Signum's `is(a, b, true)`).
function sameUser(a: UserEntity | undefined, b: UserEntity | undefined): boolean {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return a.id === b.id;
}

// Install the interception seam at module load (Signum's top-level `AuthTokenFilter.Options.addAuthToken = …`).
AuthTokenFilter.addAuthToken = AuthClient.addAuthToken;

// Attach the bearer token to the reflection-metadata fetch so the server ships the ROLE-FILTERED blob
// (Signum ships it role-filtered inherently; altea refetches it per credential change).
setExtraHeaders(() => {
    const token = AuthClient.getAuthToken();
    return token ? { [AuthClient.Options.AuthHeader]: "Bearer " + token } : {};
});

// On any credential change (login / logout / switch user), refetch the (now role-appropriate) metadata
// blob and re-render — so the visible query/type set matches the new role.
AuthClient.onCurrentUserChanged.push(() => {
    void loadReflectionMetadata().then(() => AppContext.resetUI());
});
