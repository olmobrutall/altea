import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ajaxPost } from "@altea/altea/client/Services";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { LoginOptions } from "@altea/altea-auth/client/public/LoginPage";
import { WindowsADMessage } from "../data/WindowsAD";

// The "Login with Windows user" button and the silent attempt at boot.
//
// **This registration moves the app's bearer token to `Altea_Authorization`.** When the host sits behind
// IIS or a proxy doing Negotiate, the standard `Authorization` header is TAKEN — the proxy puts its own
// `Negotiate …` challenge there — so the token needs a header of its own. That is only correct when
// integrated authentication is actually in play, which is why it happens HERE and nowhere else.
//
// See port/AuthDirectory.md.

export namespace WindowsADAuthenticator {

    export const Options = {
        /** Skip the silent attempt. */
        disabled: false,
        /** The header the bearer token rides on while a proxy owns `Authorization`. */
        authHeader: "Altea_Authorization",
    };

    /**
     * Call from MainPublic BEFORE `AuthClient.autoLogin`.
     *
     * Requires the SERVER to have a Negotiate provider installed — see
     * `@altea/altea-auth-windowsad/server/WindowsADServer`'s header. Without one the endpoint answers
     * "not configured", the silent attempt quietly gives up, and the button reports it.
     */
    export function registerWindowsAuthenticator(): void {
        AuthClient.authenticators.push(loginWindowsAuthentication);
        AuthClient.Options.AuthHeader = Options.authHeader;
        LoginOptions.showLoginForm = "initially_not";
        LoginOptions.customLoginButtons = () => <LoginWithWindowsButton />;
    }

    /** The boot attempt: never throws, so a host without Negotiate just shows the ordinary login page. */
    export function loginWindowsAuthentication(): Promise<AuthClient.AuthenticatedUser | undefined> {
        if (Options.disabled)
            return Promise.resolve(undefined);

        return API.loginWindowsAuthentication(false).catch(() => undefined);
    }

    export namespace API {
        export function loginWindowsAuthentication(throwError: boolean): Promise<AuthClient.API.LoginResponse | undefined> {
            return ajaxPost({
                url: `/api/auth/loginWindowsAuthentication?throwError=${throwError}`,
                avoidAuthToken: true,
            }, undefined);
        }
    }
}

export function LoginWithWindowsButton(): React.JSX.Element {

    function handleClick(): void {
        void WindowsADAuthenticator.API.loginWindowsAuthentication(true).then(lr => {
            if (lr == null) {
                void MessageModal.showError(
                    WindowsADMessage.LooksLikeYourWindowsUserIsNotAllowedToUseThisApplication.niceToString(),
                    WindowsADMessage.NoWindowsUserFound.niceToString());
                return;
            }

            AuthClient.setAuthToken(lr.token, lr.authenticationType);
            // `avoidReRender`: onLogin rebuilds the app (and reloads the metadata blob) — the listener's own
            // remount in between only flashes the page back to its idle state (see AuthClient).
            AuthClient.setCurrentUser(lr.userEntity, /* avoidReRender */ true);
            AuthClient.Options.onLogin();
        });
    }

    return (
        <div className="row mt-2">
            <div className="col-md-6 offset-md-3">
                <button type="button" onClick={handleClick} className="btn btn-info">
                    <FontAwesomeIcon aria-hidden={true} icon={["fab", "windows"]} />{" "}
                    {WindowsADMessage.LoginWithWindowsUser.niceToString()}
                </button>
            </div>
        </div>
    );
}
