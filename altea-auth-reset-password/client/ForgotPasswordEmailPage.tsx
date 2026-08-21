import * as React from "react";
import { classes } from "@altea/altea/data/globals";
import type { ModelState } from "@altea/altea/data/validation";
import { ValidationError } from "@altea/altea/client/Services";
import { LoginAuthMessage } from "@altea/altea-auth/data/AuthMessages";
import { ResetPasswordClient } from "./ResetPasswordClient";

// Port of Signum's ForgotPasswordEmailPage.tsx — "give us your address and we will mail you a link".
//
// altea divergences: altea's ModelState maps a field to ONE message; Signum's `<AutoFocus>` wrapper has no
// altea counterpart, so the input carries `autoFocus` itself; and `type="texbox"` (a typo in the Signum
// source that made the browser fall back to `text`) is written as `type="email"`.

export default function ForgotPasswordEmailPage(): React.JSX.Element {

    const [modelState, setModelState] = React.useState<ModelState | undefined>(undefined);
    const [success, setSuccess] = React.useState(false);
    const [message, setMessage] = React.useState<string | undefined>(undefined);
    const [title, setTitle] = React.useState<string | undefined>(undefined);

    const email = React.useRef<HTMLInputElement>(null);

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
        e.preventDefault();

        if (!validateEmail())
            return;

        try {
            const response = await ResetPasswordClient.API.forgotPasswordEmail({ email: email.current!.value });
            setSuccess(response.success);
            setMessage(response.message);
            setTitle(response.title);
        } catch (e) {
            if (e instanceof ValidationError && e.modelState)
                setModelState(e.modelState);
            throw e;
        }
    }

    function validateEmail(): boolean {
        if (email.current?.value) {
            setModelState({});
            return true;
        }

        setModelState({ email: LoginAuthMessage.EnterYourUserEmail.niceToString() });
        return false;
    }

    function error(field: string): string | undefined {
        return modelState && modelState[field];
    }

    if (success) {
        return (
            <div className="container">
                <div className="row">
                    <div className="col-md-6 offset-md-3 forgot-password-success">
                        {title
                            ? <><h1 className="sf-entity-title h2">{title}</h1><p>{message}</p></>
                            : <h2 className="sf-entity-title">{message}</h2>}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="container">
            <div className="row">
                <div className="col-md-6 offset-md-3">
                    <form onSubmit={e => { void handleSubmit(e); }}>
                        <h1 className="sf-entity-title h2">{LoginAuthMessage.IForgotMyPassword.niceToString()}</h1>
                        <p>{LoginAuthMessage.GiveUsYourUserEmailToResetYourPassword.niceToString()}</p>

                        <div className={classes("form-group mb-3", error("email") && "has-error")}>
                            <input type="email" className="form-control" id="email" ref={email} autoFocus
                                autoComplete="email" onBlur={validateEmail}
                                placeholder={LoginAuthMessage.EnterYourUserEmail.niceToString()} />
                            {error("email") && <span className="help-block text-danger">{error("email")}</span>}
                            {message && <div className="form-text text-danger">{message}</div>}
                        </div>

                        <button type="submit" className="btn btn-primary" id="changePasswordRequest">
                            {LoginAuthMessage.SendEmail.niceToString()}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
