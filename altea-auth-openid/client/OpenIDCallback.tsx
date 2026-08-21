import * as React from "react";
import { QueryString } from "@altea/altea/client/QueryString";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { OpenIDAuthenticator } from "./OpenIDAuthenticator";

// Port of Signum.Authorization.OpenID's OpenIDCallback.tsx — the page the provider redirects back to with
// `?code=…&state=…`. It posts the code to the server, stores the returned token, and continues to wherever
// the user was heading.
//
// altea divergences: the error branch RENDERS the failure (Signum's version had its ternary inverted, so a
// successful callback showed "Error" and a failure showed the spinner) and keeps the message, rather than
// only rethrowing.

export default function OpenIDCallback(): React.JSX.Element {

    const [error, setError] = React.useState<string | undefined>(undefined);

    React.useEffect(() => { void handleCallback(); }, []);

    async function handleCallback(): Promise<void> {
        const qs = QueryString.parse(window.location.search);
        const code = qs["code"] as string | undefined;
        const state = qs["state"] as string | undefined;

        const storedState = sessionStorage.getItem("openIDState");
        sessionStorage.removeItem("openIDState");

        const returnUrl = sessionStorage.getItem("openIDReturnUrl") ?? undefined;
        sessionStorage.removeItem("openIDReturnUrl");

        try {
            if (!code)
                throw new Error("No 'code' in query string");

            // The state check is what makes this callback CSRF-safe: only a redirect started by this tab
            // carries the value stored above.
            if (!state || state !== storedState)
                throw new Error("Invalid 'state' in query string");

            const loginResponse = await OpenIDAuthenticator.API.loginWithOpenID(
                code, OpenIDAuthenticator.getRedirectUri(), { throwErrors: true });

            if (loginResponse == null)
                throw new Error("The OpenID identity is not associated with a user in this application");

            OpenIDAuthenticator.setOpenIDActive(true);
            AuthClient.setAuthToken(loginResponse.token, loginResponse.authenticationType);
            AuthClient.setCurrentUser(loginResponse.userEntity);
            AuthClient.Options.onLogin(returnUrl);
        } catch (e) {
            // Clear the flag, or the silent authenticator would bounce straight back here on every load.
            OpenIDAuthenticator.setOpenIDActive(false);
            setError(e instanceof Error ? e.message : String(e));
            throw e;
        }
    }

    return (
        <div className="d-flex justify-content-center align-items-center" style={{ height: "100vh" }}>
            {error == null
                ? <div className="spinner-border text-primary" role="status">
                    <span className="visually-hidden">Signing in…</span>
                </div>
                : <div className="text-danger" role="alert">{error}</div>}
        </div>
    );
}
