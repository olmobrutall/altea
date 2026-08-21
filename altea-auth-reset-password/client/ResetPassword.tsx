import * as React from "react";
import { useLocation } from "react-router";
import { classes } from "@altea/altea/data/globals";
import type { ModelState } from "@altea/altea/data/validation";
import { ValidationError } from "@altea/altea/client/Services";
import { QueryString } from "@altea/altea/client/QueryString";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { LoginAuthMessage } from "@altea/altea-auth/data/AuthMessages";
import { ResetPasswordAuthMessage } from "../data/ResetPassword";
import { ResetPasswordClient } from "./ResetPasswordClient";

// Port of Signum's ResetPassword.tsx — the page a mailed link lands on: type the new password twice, and
// the response logs you straight in. `?code=OK` is the post-success state Signum navigates to.
//
// altea divergences: altea's ModelState maps a field to ONE message (Signum's is a string[]), and the
// server's flat 400 body has exactly that shape — so `error(field)` is a direct lookup.

export default function ResetPassword(): React.JSX.Element {
    const location = useLocation();

    const [modelState, setModelState] = React.useState<ModelState | undefined>(undefined);
    const [success, setSuccess] = React.useState(false);
    const [successRequestNewLink, setSuccessRequestNewLink] = React.useState(false);
    const [showRequestNewLink, setShowRequestNewLink] = React.useState(false);

    const newPassword = React.useRef<HTMLInputElement>(null);
    const newPassword2 = React.useRef<HTMLInputElement>(null);
    const code = String(QueryString.parse(location.search).code ?? "");

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
        e.preventDefault();

        if (!validateNewPassword())
            return;

        try {
            const lr = await ResetPasswordClient.API.resetPassword({
                code,
                newPassword: newPassword.current!.value,
            });

            AuthClient.setAuthToken(lr.token, lr.authenticationType);
            AuthClient.setCurrentUser(lr.userEntity);
            AuthClient.Options.onLogin("/auth/resetPassword?code=OK");

            setSuccess(true);
        } catch (ex) {
            if (ex instanceof ValidationError && ex.modelState)
                setModelState(ex.modelState);
            else
                setShowRequestNewLink(true);

            throw ex;
        }
    }

    function validateNewPassword(): boolean {
        if (!newPassword.current!.value) {
            setModelState({ newPassword: LoginAuthMessage.PasswordMustHaveAValue.niceToString() });
            return false;
        }
        if (!newPassword2.current!.value) {
            setModelState({ newPassword2: LoginAuthMessage.PasswordMustHaveAValue.niceToString() });
            return false;
        }
        if (newPassword2.current!.value !== newPassword.current!.value) {
            setModelState({
                newPassword: LoginAuthMessage.PasswordsAreDifferent.niceToString(),
                newPassword2: LoginAuthMessage.PasswordsAreDifferent.niceToString(),
            });
            return false;
        }
        setModelState({});
        return true;
    }

    function error(field: string): string | undefined {
        return modelState && modelState[field];
    }

    function handleRequestNewLinkClick(e: React.MouseEvent): void {
        e.preventDefault();
        void ResetPasswordClient.API.requestNewLink(code).then(() => setSuccessRequestNewLink(true));
    }

    if (successRequestNewLink) {
        return (
            <div className="container sf-request-new-link">
                <div className="row">
                    <div className="col-md-6 offset-md-3">
                        <h2 className="sf-entity-title">{ResetPasswordAuthMessage.RequestNewLink.niceToString()}</h2>
                        <p>{ResetPasswordAuthMessage.NewLinkToResetPasswordHasBeenSentSuccessfully.niceToString()}</p>
                    </div>
                </div>
            </div>
        );
    }

    if (success || code === "OK") {
        return (
            <div className="container sf-reset-password">
                <div className="row">
                    <div className="col-md-6 offset-md-3">
                        <h2 className="sf-entity-title">{LoginAuthMessage.PasswordChanged.niceToString()}</h2>
                        <p>{LoginAuthMessage.PasswordHasBeenChangedSuccessfully.niceToString()}</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="container sf-reset-password">
            <div className="row">
                <div className="col-md-6 offset-md-3">
                    <form onSubmit={e => { void handleSubmit(e); }}>
                        <h2 className="sf-entity-title">{LoginAuthMessage.ChangePassword.niceToString()}</h2>
                        <p>{LoginAuthMessage.NewPassword.niceToString()}</p>

                        <div className={classes("form-group mb-3", error("newPassword") && "has-error")}>
                            <input type="password" className="form-control" id="newPassword" ref={newPassword}
                                autoComplete="new-password" onBlur={validateNewPassword}
                                placeholder={LoginAuthMessage.EnterTheNewPassword.niceToString()} />
                            {error("newPassword") && <span className="help-block text-danger">{error("newPassword")}</span>}
                        </div>
                        <div className={classes("form-group mb-3", error("newPassword2") && "has-error")}>
                            <input type="password" className="form-control" id="newPassword2" ref={newPassword2}
                                autoComplete="new-password" onBlur={validateNewPassword}
                                placeholder={LoginAuthMessage.ConfirmNewPassword.niceToString()} />
                            {error("newPassword2") && <span className="help-block text-danger">{error("newPassword2")}</span>}
                        </div>

                        <div className="d-flex">
                            <button type="submit" className="btn btn-primary" id="changePassword">
                                {LoginAuthMessage.ChangePassword.niceToString()}
                            </button>
                            {showRequestNewLink &&
                                <button className="btn btn-secondary ms-auto" id="requestNewLink" onClick={handleRequestNewLinkClick}>
                                    {ResetPasswordAuthMessage.RequestNewLink.niceToString()}
                                </button>}
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}
