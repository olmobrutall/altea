import * as React from "react";
import { useLocation } from "react-router";
import * as AppContext from "@altea/altea/client/AppContext";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { LoginOptions, type LoginContext } from "@altea/altea-auth/client/public/LoginPage";
import { OpenIDMessage, type OpenIDClientConfig, type OpenIDEndpoints } from "../data/OpenID";

// Port of Signum.Authorization.OpenID's OpenIDAuthenticator.tsx — the browser half of the
// authorization-code flow: a sign-in button that redirects to the provider, and a silent re-login that
// rides the provider's own SSO session on every page load.
//
// altea divergences, documented inline:
//  - Signum reads the configuration from `window.__openIDConfig`, injected by Index.cshtml. altea has no
//    server-rendered page, so the configuration comes from the anonymous `/api/auth/openIDConfig` endpoint,
//    fetched ONCE by `registerOpenIDAuthenticator` (which is therefore async) and cached. `Options
//    .getOpenIDConfig` stays as the override seam, so a host can still supply it another way.
//  - That same payload carries the provider ENDPOINTS, so starting the redirect needs no extra round trip
//    (Signum calls /api/auth/openIDEndpoints at click time).
//  - `Reflection.isStarted()` (Signum's "call me before autoLogin" guard) has no altea counterpart; the
//    ordering requirement is documented on `registerOpenIDAuthenticator` instead.
//  - `LoginOptions` lives on altea-auth's LoginPage module (see its header).

type OpenIDSettings = OpenIDClientConfig & OpenIDEndpoints;

export namespace OpenIDAuthenticator {

    let settings: OpenIDSettings | null = null;

    export const Options = {
        /** Override to supply the configuration from somewhere else (Signum's `window.__openIDConfig`). */
        getOpenIDConfig: function (): OpenIDSettings | null {
            return settings;
        },
    };

    /**
     * Signum's `registerOpenIDAuthenticator`. Call it from MainPublic BEFORE `AuthClient.autoLogin`, and
     * AWAIT it: the login button and the silent authenticator both need the configuration, which is a
     * server round trip in altea (see the header).
     */
    export async function registerOpenIDAuthenticator(buttonContent?: React.ReactNode): Promise<void> {
        settings = await API.getConfig().catch(() => null);

        // Not configured / disabled: leave the ordinary login form exactly as it was.
        if (Options.getOpenIDConfig() == null)
            return;

        LoginOptions.customLoginButtons = ctx => {
            const config = Options.getOpenIDConfig();
            return config == null ? null : <OpenIDSignIn ctx={ctx} buttonContent={buttonContent} />;
        };

        LoginOptions.showLoginForm = "initially_not";

        AuthClient.authenticators.push(loginWithOpenIDSilent);
    }

    /** The dedicated callback route, NOT the application root (Signum's getRedirectUri). */
    export function getRedirectUri(): string {
        return window.location.origin + AppContext.toAbsoluteUrl("/openid-callback");
    }

    /** Signum's `redirectToIdP` — start the authorization-code flow. Never resolves: the tab navigates. */
    export async function redirectToIdP(config: OpenIDSettings, returnUrl?: string, options?: { prompt?: string }): Promise<void> {
        const state = generateState();
        sessionStorage.setItem("openIDState", state);

        if (returnUrl)
            sessionStorage.setItem("openIDReturnUrl", returnUrl);
        else
            sessionStorage.removeItem("openIDReturnUrl");

        const params = new URLSearchParams({
            response_type: "code",
            client_id: config.clientId,
            redirect_uri: getRedirectUri(),
            scope: config.scopes.join(" "),
            state,
        });

        if (options?.prompt)
            params.set("prompt", options.prompt);

        window.location.href = `${config.authorizationEndpoint}?${params.toString()}`;
    }

    /** Signum's `signOut` — end the provider's session too, so the next sign-in really asks. */
    export async function signOut(): Promise<void> {
        setOpenIDActive(false);

        const config = Options.getOpenIDConfig();
        if (config?.endSessionEndpoint == null)
            return;

        const params = new URLSearchParams({
            client_id: config.clientId,
            post_logout_redirect_uri: window.location.origin + AppContext.toAbsoluteUrl("/"),
        });

        window.location.href = `${config.endSessionEndpoint}?${params.toString()}`;
        return new Promise(() => { /* never resolves — the browser is navigating away */ });
    }

    function generateState(): string {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return Array.from(array, b => b.toString(16).padStart(2, "0")).join("");
    }

    /**
     * Signum's `loginWithOpenIDSilent` — registered in `AuthClient.authenticators`, so it runs on every
     * page load. If this browser has signed in through the provider before, redirect there again: while the
     * provider's SSO session is alive the round trip is invisible.
     */
    export async function loginWithOpenIDSilent(): Promise<AuthClient.AuthenticatedUser | undefined> {
        if (location.search.includes("avoidOID"))
            return undefined;

        const config = Options.getOpenIDConfig();
        if (config == null)
            return undefined;

        if (!localStorage.getItem("openIDActive"))
            return undefined;

        // The callback page is mid-flow; redirecting again would loop.
        if (window.location.pathname.toLowerCase().includes("openid-callback"))
            return undefined;

        const returnUrl = window.location.pathname + window.location.search + window.location.hash;
        await redirectToIdP(config, returnUrl);
        return new Promise(() => { /* never resolves — the browser is navigating away */ });
    }

    /** Whether this browser has an OpenID session worth resuming (Signum's localStorage flag). */
    export function setOpenIDActive(active: boolean): void {
        if (active)
            localStorage.setItem("openIDActive", "1");
        else
            localStorage.removeItem("openIDActive");
    }

    export namespace API {
        export function loginWithOpenID(code: string, redirectUri: string, opts: { throwErrors: boolean }):
            Promise<AuthClient.API.LoginResponse | undefined> {
            return ajaxPost({
                url: `/api/auth/loginWithOpenID?throwErrors=${opts.throwErrors}`,
                avoidAuthToken: true,
            }, { code, redirectUri });
        }

        export function getConfig(): Promise<OpenIDSettings | null> {
            return ajaxGet({ url: "/api/auth/openIDConfig", avoidAuthToken: true });
        }

        export function getEndpoints(): Promise<OpenIDEndpoints> {
            return ajaxGet({ url: "/api/auth/openIDEndpoints", avoidAuthToken: true });
        }
    }
}

export function OpenIDSignIn({ ctx, buttonContent }: { ctx: LoginContext; buttonContent?: React.ReactNode }): React.JSX.Element {
    const config = OpenIDAuthenticator.Options.getOpenIDConfig();

    // When the router bounced an unauthenticated deep link to /auth/login it left the original location
    // in `location.state.back`, so a successful sign-in can return there.
    const loc = useLocation();
    const back = (loc.state as { back?: { pathname: string; search?: string; hash?: string } } | null)?.back;

    function handleClick(e: React.MouseEvent): void {
        if (config == null)
            return;
        const returnUrl = back ? back.pathname + (back.search ?? "") + (back.hash ?? "") : undefined;
        // Shift / Alt forces the provider's account chooser (Signum's convention).
        const prompt = e.shiftKey || e.altKey ? "login" : undefined;
        void OpenIDAuthenticator.redirectToIdP(config, returnUrl, { prompt });
    }

    return (
        <div className="row mt-4">
            <div className="col-md-6 offset-md-3">
                <button type="button"
                    className={`btn btn-primary w-100${ctx.loading != null ? " disabled" : ""}`}
                    onClick={handleClick}>
                    {buttonContent ?? OpenIDMessage.SignInWithOpenID.niceToString()}
                </button>
            </div>
        </div>
    );
}
