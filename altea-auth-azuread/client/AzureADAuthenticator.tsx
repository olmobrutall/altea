import * as React from "react";
import * as msal from "@azure/msal-browser";
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
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
//  - The configuration comes from an ANONYMOUS endpoint, because there is no
//    server-rendered page, so `registerAzureADAuthenticator` FETCHES it (per AD variant) from the anonymous
//    `/api/auth/azureADConfig` endpoint and caches it — which makes registration async. `Options
//    .getAzureADConfig` remains the override seam.
//  - There is no "register me before autoLogin" guard to lean on; the
//    ordering requirement is documented on `registerAzureADAuthenticator` instead.
//  - MSAL 5 lands the popup on `redirectUri`, so the app's entry point must call `handlePopupResponse`
//    FIRST and stop when it returns true — that document is the popup, not the application.

export namespace AzureADAuthenticator {

    /** Per-variant configuration, fetched once by `registerAzureADAuthenticator`. */
    const configs = new Map<string, AzureADClientConfig | null>();

    export const Options = {
        getAzureADConfig: function (adVariant: string): AzureADClientConfig | undefined {
            return configs.get(adVariant) ?? undefined;
        },
    };

    let currentMsalClient: msal.IPublicClientApplication | null = null;

    /**
     * Call from MainPublic BEFORE `AuthClient.autoLogin`, and
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

    async function getMsalClient(config: AzureADClientConfig): Promise<msal.IPublicClientApplication> {
        const msalConfig: msal.Configuration = {
            auth: {
                clientId: config.applicationId,
                redirectUri: window.location.origin + AppContext.toAbsoluteUrl("/"),
                postLogoutRedirectUri: window.location.origin + AppContext.toAbsoluteUrl("/"),
            },
            cache: {
                cacheLocation: "localStorage",
            },
            system: {
                popupBridgeTimeout: 15 * 60 * 1000, // the default 60s is too short for a B2C sign-up or MFA
            },
        };

        // A non-Microsoft authority must be declared trusted, or MSAL refuses to redirect to it.
        if (config.type === "B2C")
            msalConfig.auth.knownAuthorities = [`${config.tenantName}.b2clogin.com`];
        else if (config.type === "ExternalID")
            msalConfig.auth.knownAuthorities = [config.tenantName!];

        // Builds the client AND initializes it, which MSAL v3+ requires before any request.
        return msal.createStandardPublicClientApplication(msalConfig);
    }

    /** MSAL 5 does not notice when the user CLOSES the popup: it keeps waiting until `popupBridgeTimeout`. */
    function onPopupClosed(client: msal.IPublicClientApplication, onClosed: () => void): () => void {
        let interval: number | undefined;
        const callbackId = client.addEventCallback(msg => {
            const popup = (msg.payload as msal.PopupEvent | null)?.popupWindow;
            if (popup)
                interval = window.setInterval(() => { if (popup.closed) { stop(); onClosed(); } }, 500);
        }, [msal.EventType.POPUP_OPENED]);

        function stop(): void {
            window.clearInterval(interval);
            if (callbackId)
                client.removeEventCallback(callbackId);
        }

        return stop;
    }

    /**
     * MSAL 5 lands `loginPopup` / `logoutPopup` on `redirectUri` INSIDE the popup, and that page has to
     * hand the response back to the main window, which then closes the popup. So the application's entry
     * point calls this FIRST and starts nothing when it returns true — that document is the popup.
     */
    export async function handlePopupResponse(): Promise<boolean> {
        const hasState = (str: string): boolean => str.length > 1 && new URLSearchParams(str.substring(1)).has("state");
        if (!hasState(window.location.hash) && !hasState(window.location.search))
            return false;

        try {
            await broadcastResponseToMainFrame();
            return true;
        } catch (e) {
            console.log(e); // a `state` in the url that is not an MSAL response
            return false;
        }
    }

    export type B2C_UserFlows = "signInSignUp_UserFlow" | "signIn_UserFlow" | "signUp_UserFlow"
        | "resetPassword_UserFlow" | "editProfile_UserFlow";

    /** The authority URL for the configured Azure product. */
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

    /** The interactive popup flow. */
    export async function signIn(ctx: LoginContext, adVariant: string, b2cUserFlow?: B2C_UserFlows, e?: React.MouseEvent): Promise<void> {
        e?.preventDefault();
        ctx.setLoading(adVariant);

        const config = Options.getAzureADConfig(adVariant)!;
        let stopWatchingPopup: (() => void) | undefined;

        try {
            const newClient = await getMsalClient(config);

            stopWatchingPopup = onPopupClosed(newClient, () => ctx.setLoading(undefined));

            const authResult = await newClient.loginPopup({
                scopes: config.scopes,
                // Shift / Alt forces the account chooser.
                prompt: e?.shiftKey || e?.altKey ? "select_account" : undefined,
                authority: getAuthority(config, b2cUserFlow),
                // Without this, a CANCELLED logout leaves MSAL's "interaction in progress" flag set and
                // every later login fails until the user clears cookies and local storage.
                overrideInteractionInProgress: true,
            });

            setMsalAccount(authResult.account.username, adVariant);

            const loginResponse = await API.loginWithAzureAD(authResult.idToken, authResult.accessToken,
                { adVariant, throwErrors: true });

            if (loginResponse == null)
                throw new Error("User " + authResult.account.username + " not found in the database");

            currentMsalClient = newClient;
            AuthClient.setAuthToken(loginResponse.token, loginResponse.authenticationType);
            // `avoidReRender`: onLogin rebuilds the app (and reloads the metadata blob) — the listener's own
            // remount in between only flashes the page back to its idle state (see AuthClient).
            AuthClient.setCurrentUser(loginResponse.userEntity, /* avoidReRender */ true);
            AuthClient.Options.onLogin();
        } catch (e) {
            // The user closed the popup and started a NEW login; that one now owns ctx.loading.
            if (e instanceof msal.BrowserAuthError && e.errorCode == "interaction_in_progress_cancelled")
                return;

            ctx.setLoading(undefined);

            if (e instanceof msal.BrowserAuthError && e.errorCode == "user_cancelled")
                return;

            // AADB2C90091: the user cancelled the B2C flow. AADB2C90118: they asked to reset the password.
            if (e instanceof msal.AuthError && e.errorCode == "access_denied" && e.errorMessage.startsWith("AADB2C90091"))
                return;

            if (e instanceof msal.AuthError && e.errorCode == "access_denied" && e.errorMessage.startsWith("AADB2C90118")) {
                await resetPasswordB2C(ctx, adVariant);
                return;
            }

            void ErrorModal.showErrorModal(e, () => signOut());
        } finally {
            stopWatchingPopup?.();
        }
    }

    /**
     * B2C signals "I forgot my password" as an error on the sign-in popup, and
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

            try {
                const newClient = await getMsalClient(config);

                await newClient.loginPopup({
                    scopes: config.scopes,
                    authority: getAuthority(config, "resetPassword_UserFlow"),
                    overrideInteractionInProgress: true,
                });

                await MessageModal.show({
                    title: LoginAuthMessage.PasswordChanged.niceToString(),
                    message: LoginAuthMessage.PasswordHasBeenChangedSuccessfully.niceToString(),
                    buttons: "ok",
                });
            } catch (e) {
                if (e instanceof msal.InteractionRequiredAuthError ||
                    (e instanceof msal.BrowserAuthError &&
                        (e.errorCode == "user_cancelled" || e.errorCode == "interaction_in_progress_cancelled")))
                    return;

                void ErrorModal.showErrorModal(e, () => signOut());
            }
        }
    }

    /** Registered in `AuthClient.authenticators`, runs at every boot. */
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

        try {
            const newClient = await getMsalClient(config);

            const ai = newClient.getAccount({ username: account });
            if (!ai)
                return undefined;

            const tokenResponse = await newClient.acquireTokenSilent({
                scopes: config.scopes,
                account: ai,
                authority: getAuthority(config),
            });

            currentMsalClient = newClient;
            return await API.loginWithAzureAD(tokenResponse.idToken, tokenResponse.accessToken,
                { adVariant, throwErrors: false });
        } catch (e) {
            if (e instanceof msal.InteractionRequiredAuthError ||
                (e instanceof msal.BrowserAuthError && e.errorCode == "user_cancelled"))
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

        return currentMsalClient.getAccount({ username: account }) ?? undefined;
    }

    export function getCurrentADVariant(): string | null {
        return localStorage.getItem("msalAdVariant");
    }

    export function getCurrentADConfig(): AzureADClientConfig | undefined {
        return Options.getAzureADConfig(getCurrentADVariant() ?? "default");
    }

    /** A Graph token for the SIGNED-IN user (delegated calls). */
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

/** The "Sign in with Microsoft" branded button. `iconUrl` is overridable. */
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
