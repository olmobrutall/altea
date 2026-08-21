import * as React from "react";
import * as msal from "@azure/msal-browser";
import * as AppContext from "@altea/altea/client/AppContext";
import { ajaxGet, ajaxPost } from "@altea/altea/client/Services";
import { classes } from "@altea/altea/data/globals";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import MessageModal, { type MessageModalHandler } from "@altea/altea/client/Modals/MessageModal";
import ErrorModal from "@altea/altea/client/Modals/ErrorModal";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { LoginOptions, type LoginContext } from "@altea/altea-auth/client/public/LoginPage";
import { LoginAuthMessage, ResetPasswordB2CMessage } from "@altea/altea-auth/data/AuthMessages";
import type { AzureADClientConfig } from "../data/AzureAD";

// Port of Signum.Authorization.AzureAD's AzureADAuthenticator.tsx — the browser half: MSAL acquires an
// id_token in a popup (or silently, from its own cache) and posts it to the server.
//
// altea divergences, documented inline:
//  - Signum reads the configuration from `window.__azureADConfig`, injected by Index.cshtml. altea has no
//    server-rendered page, so `registerAzureADAuthenticator` FETCHES it (per AD variant) from the anonymous
//    `/api/auth/azureADConfig` endpoint and caches it — which makes registration async. `Options
//    .getAzureADConfig` remains the override seam.
//  - `Reflection.isStarted()` (Signum's "register me before autoLogin" guard) has no altea counterpart; the
//    ordering requirement is documented on `registerAzureADAuthenticator` instead.
//  - `(newClient as any).browserStorage.setInteractionInProgress(false)` — Signum reaches into MSAL's
//    private storage because a CANCELLED logout leaves an "interaction in progress" flag that blocks the
//    next login until cookies are cleared. MSAL v4 exposes no supported way to clear it either, so the
//    same reach-in is kept, isolated in `clearInteractionInProgress` with this note.

export namespace AzureADAuthenticator {

    /** Per-variant configuration, fetched once by `registerAzureADAuthenticator`. */
    const configs = new Map<string, AzureADClientConfig | null>();

    export const Options = {
        getAzureADConfig: function (adVariant: string): AzureADClientConfig | undefined {
            return configs.get(adVariant) ?? undefined;
        },
    };

    let currentMsalClient: msal.PublicClientApplication | null = null;

    /**
     * Signum's `registerAzureADAuthenticator()`. Call from MainPublic BEFORE `AuthClient.autoLogin`, and
     * AWAIT it: the login buttons and the silent authenticator both need the configuration, which is a
     * server round trip in altea (see the header).
     */
    export async function registerAzureADAuthenticator(adVariants: string[] = ["default"]): Promise<void> {
        await Promise.all(adVariants.map(async v => {
            configs.set(v, await API.getConfig(v).catch(() => null));
        }));

        if (Options.getAzureADConfig("default") == null && getCurrentADConfig() == null)
            return; // not configured / disabled: leave the ordinary login form alone

        LoginOptions.customLoginButtons = ctx => {
            const config = Options.getAzureADConfig("default");
            if (config == null)
                return null;

            switch (config.type) {
                case "AzureAD": return <MicrosoftSignIn ctx={ctx} />;
                // B2C and External ID both drive named user flows, so they share the button set.
                case "B2C":
                case "ExternalID": return <AzureB2CSignIn ctx={ctx} />;
                default: return null;
            }
        };

        LoginOptions.showLoginForm = "initially_not";

        const config = getCurrentADConfig();
        currentMsalClient = config ? await getMsalClient(config) : null;

        AuthClient.authenticators.push(loginWithAzureADSilent);
    }

    async function getMsalClient(config: AzureADClientConfig): Promise<msal.PublicClientApplication> {
        const msalConfig: msal.Configuration = {
            auth: {
                clientId: config.applicationId,
                redirectUri: window.location.origin + AppContext.toAbsoluteUrl("/"),
                postLogoutRedirectUri: window.location.origin + AppContext.toAbsoluteUrl("/"),
            },
            cache: {
                cacheLocation: "localStorage",
                storeAuthStateInCookie: true,
            },
        };

        // A non-Microsoft authority must be declared trusted, or MSAL refuses to redirect to it.
        if (config.type === "B2C")
            msalConfig.auth.knownAuthorities = [`${config.tenantName}.b2clogin.com`];
        else if (config.type === "ExternalID")
            msalConfig.auth.knownAuthorities = [config.tenantName!];

        // MSAL v3+ requires initialize() before any request.
        const client = new msal.PublicClientApplication(msalConfig);
        await client.initialize();
        return client;
    }

    export type B2C_UserFlows = "signInSignUp_UserFlow" | "signIn_UserFlow" | "signUp_UserFlow"
        | "resetPassword_UserFlow" | "editProfile_UserFlow";

    /** Signum's getAuthority. */
    export function getAuthority(config: AzureADClientConfig, b2cUserFlow?: B2C_UserFlows): string {
        if (config.type === "AzureAD")
            return "https://login.microsoftonline.com/" + config.tenantId;

        if (config.type === "ExternalID")
            return config.signInSignUp_UserFlow!; // already a URL

        if (config.type === "B2C") {
            const userFlow = b2cUserFlow ? config[b2cUserFlow]! : (config.signInSignUp_UserFlow || config.signIn_UserFlow!);
            return `https://${config.tenantName}.b2clogin.com/${config.tenantName}.onmicrosoft.com/${userFlow}`;
        }

        throw new Error("Unexpected AzureAD type");
    }

    /** Signum's signIn — the interactive popup flow. */
    export async function signIn(ctx: LoginContext, adVariant: string, b2cUserFlow?: B2C_UserFlows, e?: React.MouseEvent): Promise<void> {
        e?.preventDefault();
        ctx.setLoading(adVariant);

        const config = Options.getAzureADConfig(adVariant)!;
        const newClient = await getMsalClient(config);
        clearInteractionInProgress(newClient);

        try {
            const authResult = await newClient.loginPopup({
                scopes: config.scopes,
                // Shift / Alt forces the account chooser (Signum's convention).
                prompt: e?.shiftKey || e?.altKey ? "select_account" : undefined,
                authority: getAuthority(config, b2cUserFlow),
            });

            setMsalAccount(authResult.account.username, adVariant);

            const loginResponse = await API.loginWithAzureAD(authResult.idToken, authResult.accessToken,
                { adVariant, throwErrors: true });

            if (loginResponse == null)
                throw new Error("User " + authResult.account.username + " not found in the database");

            currentMsalClient = newClient;
            AuthClient.setAuthToken(loginResponse.token, loginResponse.authenticationType);
            AuthClient.setCurrentUser(loginResponse.userEntity);
            AuthClient.Options.onLogin();
        } catch (e) {
            ctx.setLoading(undefined);

            if (e instanceof msal.BrowserAuthError && (e.errorCode == "user_login_error" || e.errorCode == "user_cancelled"))
                return;

            // AADB2C90091: the user cancelled the B2C flow. AADB2C90118: they asked to reset the password.
            if (e instanceof msal.AuthError && e.errorCode == "access_denied" && e.errorMessage.startsWith("AADB2C90091"))
                return;

            if (e instanceof msal.AuthError && e.errorCode == "access_denied" && e.errorMessage.startsWith("AADB2C90118")) {
                await resetPasswordB2C(ctx, adVariant);
                return;
            }

            void ErrorModal.showErrorModal(e, () => signOut());
        }
    }

    /**
     * Signum's resetPasswordB2C — B2C signals "I forgot my password" as an error on the sign-in popup, and
     * the reset itself is another user flow. The confirmation modal is not decoration: opening a popup from
     * an async continuation gets blocked by the browser, so the click on the modal's button is what opens it.
     */
    export async function resetPasswordB2C(ctx: LoginContext, adVariant: string): Promise<void> {
        ctx.setLoading("azureAD");

        let promise: Promise<void> | undefined;
        const modalRef = React.createRef<MessageModalHandler>();

        await MessageModal.show({
            modalRef,
            title: ResetPasswordB2CMessage.ResetPasswordRequested.niceToString(),
            message: ResetPasswordB2CMessage.DoYouWantToContinue.niceToString(),
            buttonContent: a => a == "ok" ? ResetPasswordB2CMessage.ResetPassword.niceToString() : undefined,
            onButtonClicked: a => {
                if (a == "ok")
                    promise = runResetPasswordFlow(adVariant);
                modalRef.current!.handleButtonClicked(a);
            },
            buttons: "ok_cancel",
        });

        await promise;
        ctx.setLoading(undefined);

        async function runResetPasswordFlow(adVariant: string): Promise<void> {
            const config = Options.getAzureADConfig(adVariant)!;
            const newClient = await getMsalClient(config);

            try {
                clearInteractionInProgress(newClient);

                await newClient.loginPopup({
                    scopes: config.scopes,
                    authority: getAuthority(config, "resetPassword_UserFlow"),
                });

                await MessageModal.show({
                    title: LoginAuthMessage.PasswordChanged.niceToString(),
                    message: LoginAuthMessage.PasswordHasBeenChangedSuccessfully.niceToString(),
                    buttons: "ok",
                });
            } catch (e) {
                if (e instanceof msal.InteractionRequiredAuthError ||
                    (e instanceof msal.BrowserAuthError && (e.errorCode == "user_login_error" || e.errorCode == "user_cancelled")))
                    return;

                void ErrorModal.showErrorModal(e, () => signOut());
            }
        }
    }

    /** Signum's loginWithAzureADSilent — registered in `AuthClient.authenticators`, runs at every boot. */
    export async function loginWithAzureADSilent(): Promise<AuthClient.AuthenticatedUser | undefined> {
        if (location.search.includes("avoidAD"))
            return undefined;

        const account = localStorage.getItem("msalAccount");
        if (!account)
            return undefined;

        const adVariant = getCurrentADVariant() ?? "default";
        const config = getCurrentADConfig();
        if (config == null)
            return undefined;

        const newClient = await getMsalClient(config);

        try {
            const tokenResponse = await newClient.acquireTokenSilent({
                scopes: config.scopes,
                account: newClient.getAccountByUsername(account) ?? undefined,
                authority: getAuthority(config),
            });

            currentMsalClient = newClient;
            return await API.loginWithAzureAD(tokenResponse.idToken, tokenResponse.accessToken,
                { adVariant, throwErrors: false });
        } catch (e) {
            if (e instanceof msal.InteractionRequiredAuthError ||
                (e instanceof msal.BrowserAuthError && (e.errorCode == "user_login_error" || e.errorCode == "user_cancelled")))
                return undefined;

            console.log(e);
            return undefined;
        }
    }

    export function cleanMsalAccount(): void {
        localStorage.removeItem("msalAccount");
        localStorage.removeItem("msalAdVariant");
    }

    export function setMsalAccount(accountName: string, adVariant: string): void {
        localStorage.setItem("msalAccount", accountName);
        localStorage.setItem("msalAdVariant", adVariant);
    }

    export function getCurrentMsalAccount(): msal.AccountInfo | null | undefined {
        const account = localStorage.getItem("msalAccount");
        if (!account || !currentMsalClient)
            return null;

        return currentMsalClient.getAccountByUsername(account) ?? undefined;
    }

    export function getCurrentADVariant(): string | null {
        return localStorage.getItem("msalAdVariant");
    }

    export function getCurrentADConfig(): AzureADClientConfig | undefined {
        return Options.getAzureADConfig(getCurrentADVariant() ?? "default");
    }

    /** Signum's getAccessToken — a Graph token for the SIGNED-IN user (delegated calls). */
    export async function getAccessToken(): Promise<string> {
        const ai = getCurrentMsalAccount();
        if (!ai)
            throw new Error("User account missing from session. Please sign out and sign in again.");

        const config = getCurrentADConfig()!;
        const res = await acquireTokenSilentOrPopup({
            scopes: config.scopes,
            account: ai,
            authority: getAuthority(config, undefined),
        });
        return res.accessToken;
    }

    async function acquireTokenSilentOrPopup(request: msal.SilentRequest): Promise<msal.AuthenticationResult> {
        try {
            return await currentMsalClient!.acquireTokenSilent(request);
        } catch (e) {
            if (e instanceof msal.AuthError &&
                (e.errorCode === "consent_required" || e.errorCode === "interaction_required" || e.errorCode === "login_required"))
                return await currentMsalClient!.acquireTokenPopup(request);
            throw e;
        }
    }

    export async function signOut(): Promise<void> {
        const account = getCurrentMsalAccount();
        const config = getCurrentADConfig();
        if (account && config && currentMsalClient) {
            await currentMsalClient.logoutPopup({ authority: getAuthority(config), account });
            currentMsalClient.setActiveAccount(null);
            currentMsalClient = null;
            cleanMsalAccount();
        }
    }

    /**
     * Signum's `(client as any).browserStorage.setInteractionInProgress(false)`. A CANCELLED logout popup
     * leaves MSAL's "interaction in progress" flag set, and every later login then fails until the user
     * clears cookies and local storage. MSAL exposes no supported way to reset it, so the private reach-in
     * is kept — but isolated here, and tolerant of the internals moving.
     */
    function clearInteractionInProgress(client: msal.PublicClientApplication): void {
        try {
            (client as unknown as { browserStorage?: { setInteractionInProgress(v: boolean): void } })
                .browserStorage?.setInteractionInProgress(false);
        } catch {
            // A newer MSAL that renamed or removed it: nothing to clear, and nothing worth failing over.
        }
    }

    export namespace API {
        export function loginWithAzureAD(jwt: string, accessToken: string, opts: { throwErrors: boolean; adVariant: string | null }):
            Promise<AuthClient.API.LoginResponse | undefined> {
            const query = `throwErrors=${opts.throwErrors}` + (opts.adVariant ? `&adVariant=${encodeURIComponent(opts.adVariant)}` : "");
            return ajaxPost({ url: "/api/auth/loginWithAzureAD?" + query, avoidAuthToken: true },
                { idToken: jwt, accessToken });
        }

        export function getConfig(adVariant: string): Promise<AzureADClientConfig | null> {
            return ajaxGet({ url: `/api/auth/azureADConfig?adVariant=${encodeURIComponent(adVariant)}`, avoidAuthToken: true });
        }
    }
}

/** The "Sign in with Microsoft" branded button. `iconUrl` is overridable, as in Signum. */
export const MicrosoftSignInOptions = {
    iconUrl: AppContext.toAbsoluteUrl("/signin_light.svg"),
};

export function MicrosoftSignIn({ ctx, adVariant = "default" }: { ctx: LoginContext; adVariant?: string }): React.JSX.Element {
    const label = LoginAuthMessage.SignInWithMicrosoft.niceToString();
    return (
        <div className="row mt-2">
            <div className="col-md-6 offset-md-3">
                <LinkButton title={label} className={ctx.loading != null ? "disabled" : undefined}
                    onClick={e => { void AzureADAuthenticator.signIn(ctx, adVariant, undefined, e); }}>
                    <img src={MicrosoftSignInOptions.iconUrl} alt={label} />
                </LinkButton>
            </div>
        </div>
    );
}

export function AzureB2CSignIn({ ctx, adVariant = "default" }: { ctx: LoginContext; adVariant?: string }): React.JSX.Element {
    const config = AzureADAuthenticator.Options.getAzureADConfig(adVariant);
    const hasSignInFlow = Boolean(config?.signIn_UserFlow);
    const hasSignUpFlow = Boolean(config?.signUp_UserFlow);

    if (hasSignInFlow && hasSignUpFlow) {
        return (
            <div className="row mt-4">
                <div className="col-md-6 offset-md-3">
                    <div className="hstack">
                        <button type="button" className={classes("btn btn-secondary me-2", ctx.loading != null && "disabled")}
                            onClick={e => { void AzureADAuthenticator.signIn(ctx, adVariant, "signIn_UserFlow", e); }}>
                            {LoginAuthMessage.SignInWithAzureB2C.niceToString()}
                        </button>
                        <button type="button" className={classes("btn btn-primary", ctx.loading != null && "disabled")}
                            onClick={e => { void AzureADAuthenticator.signIn(ctx, adVariant, "signUp_UserFlow", e); }}>
                            {LoginAuthMessage.SignUpWithAzureB2C.niceToString()}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="row mt-4">
            <div className="col-md-6 offset-md-3">
                <button type="button" className={classes("btn btn-primary", ctx.loading != null && "disabled")}
                    onClick={e => { void AzureADAuthenticator.signIn(ctx, adVariant, undefined, e); }}>
                    {LoginAuthMessage.LoginWithAzureB2C.niceToString()}
                </button>
            </div>
        </div>
    );
}
