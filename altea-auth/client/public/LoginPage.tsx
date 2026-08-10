import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { ModelState } from "@altea/altea/data/validation";
import { ValidationError } from "@altea/altea/client/Services";
import * as AppContext from "@altea/altea/client/AppContext";
import { QueryString } from "@altea/altea/client/QueryString";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { LoginAuthMessage } from "../../data/AuthMessages";
import { AuthClient } from "../AuthClient";

// Port of Signum's LoginPage.tsx (Login/LoginPage.tsx). altea divergences: helper imports come from
// altea paths (classes ← data/globals, JavascriptMessage ← data/uiMessages, ValidationError/QueryString/
// LinkButton ← altea client); the ./Login.css import is dropped (styling is plain Bootstrap classes).
// LoginContext / LoginOptions are React-typed, so they live here (the AuthClient hub is React-free)
// rather than under the AuthClient namespace — the UI files import them from this module.

export interface LoginContext {
    loading: string | undefined;
    setLoading: (loading: string | undefined) => void;
    userNameRef?: React.RefObject<HTMLInputElement | null>;
}

export const LoginOptions = {
    customLoginButtons: null as ((ctx: LoginContext) => React.ReactNode) | null,
    showLoginForm: "yes" as "yes" | "no" | "initially_not",
    usernameLabel: (): string => LoginAuthMessage.Username.niceToString(),
    resetPasswordControl: (): React.ReactElement | null => null,
};

export default function LoginPage(): React.JSX.Element {
    AppContext.useTitle(AuthClient.currentUser() ? LoginAuthMessage.SwitchUser.niceToString() : LoginAuthMessage.Login.niceToString());

    const [loading, setLoading] = React.useState<string | undefined>(undefined);
    const ctx: LoginContext = { loading, setLoading };

    const [showLoginForm, setShowLoginForm] = React.useState<boolean>(LoginOptions.showLoginForm == "yes");

    return (
        <div className="container sf-login-page">
            <div className="row">
                <div className="col-md-6 offset-md-3">
                    <h1 className="sf-entity-title h2">{AuthClient.currentUser() ? LoginAuthMessage.SwitchUser.niceToString() : LoginAuthMessage.Login.niceToString()}</h1>
                </div>
            </div>
            {showLoginForm && <LoginForm ctx={ctx} />}
            {LoginOptions.customLoginButtons && LoginOptions.customLoginButtons(ctx)}
            {LoginOptions.showLoginForm == "initially_not" && showLoginForm == false &&
                <div className="row">
                    <div className="col-md-6 offset-md-3 mt-2">
                        <LinkButton title={undefined} className="ms-1" id="sf-show-login-form" onClick={() => setShowLoginForm(true)}>
                            {LoginAuthMessage.ShowLoginForm.niceToString()}
                        </LinkButton>
                    </div>
                </div>
            }
        </div>
    );
}

export function LoginForm(p: { ctx: LoginContext }): React.JSX.Element {
    const userName = React.useRef<HTMLInputElement>(null);
    p.ctx.userNameRef = userName;
    const password = React.useRef<HTMLInputElement>(null);
    const rememberMe = React.useRef<HTMLInputElement>(null);
    const [modelState, setModelState] = React.useState<ModelState | undefined>(undefined);

    React.useEffect(() => { userName.current!.focus(); }, []);

    function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
        e.preventDefault();

        const request: AuthClient.API.LoginRequest = {
            userName: userName.current!.value,
            password: password.current!.value,
            rememberMe: rememberMe.current ? rememberMe.current.checked : undefined,
        };

        p.ctx.setLoading("password");
        AuthClient.API.login(request)
            .then(lr => {
                setModelState(undefined);
                AuthClient.setAuthToken(lr.token, lr.authenticationType);

                const back = QueryString.parse(window.location.search).back as string | undefined;
                if (lr.userEntity.mustChangePassword) {
                    AuthClient.setPendingPasswordChangeUser(lr.userEntity);
                    AppContext.navigate("/auth/changePassword" + (back ? "?back=" + encodeURIComponent(back) : ""));
                } else {
                    AuthClient.setCurrentUser(lr.userEntity);
                    AuthClient.Options.onLogin(back);
                }
            })
            .catch((e: ValidationError) => {
                p.ctx.setLoading(undefined);
                if (e.modelState)
                    setModelState(e.modelState);
                else
                    throw e;
            });
    }

    function error(field: string): string | undefined {
        return modelState && modelState[field];
    }

    return (
        <form onSubmit={handleSubmit} className="mb-4">
            <div className="row">
                <div className="col-md-6 offset-md-3">
                    <p>{LoginAuthMessage.EnterYourUserNameAndPassword.niceToString()}</p>
                    <hr />
                </div>
            </div>
            <div className="row">
                <div className="col-md-6 offset-md-3">
                    <div className={classes("form-group mb-3", error("userName") && "has-error")}>
                        <label className="sr-only" htmlFor="userName">{LoginOptions.usernameLabel()}</label>
                        <div className="input-group mb-2 mr-sm-2 mb-sm-0">
                            <div className="input-group-text"><FontAwesomeIcon aria-hidden={true} icon="user" style={{ width: "16px" }} /></div>
                            <input type="text" className="form-control" id="userName" autoComplete="username" ref={userName} placeholder={LoginOptions.usernameLabel()} disabled={p.ctx.loading != null} />
                        </div>
                        {error("userName") && <span className="help-block text-danger">{error("userName")}</span>}
                    </div>
                </div>
            </div>
            <div className="row">
                <div className="col-md-6 offset-md-3">
                    <div className={classes("form-group mb-3", error("password") && "has-error")}>
                        <label className="sr-only" htmlFor="password">{LoginAuthMessage.Password.niceToString()}</label>
                        <div className="input-group mb-2 mr-sm-2 mb-sm-0">
                            <div className="input-group-text"><FontAwesomeIcon aria-hidden={true} icon="key" style={{ width: "16px" }} /></div>
                            <input ref={password} type="password" name="password" className="form-control" id="password" autoComplete="current-password" placeholder={LoginAuthMessage.Password.niceToString()} disabled={p.ctx.loading != null} />
                        </div>
                        {error("password") && <span className="help-block text-danger">{error("password")}</span>}
                    </div>
                </div>
            </div>

            <div className="row" style={{ paddingTop: "1rem" }}>
                <div className="col-md-6 offset-md-3">
                    <button type="submit" id="login" className="btn btn-success" disabled={p.ctx.loading != null}>
                        {p.ctx.loading == "password"
                            ? <FontAwesomeIcon aria-hidden={true} icon="gear" className="fa-fw" style={{ fontSize: "larger" }} spin />
                            : <FontAwesomeIcon aria-hidden={true} icon="right-to-bracket" />}
                        &nbsp;
                        {p.ctx.loading == "password" ? JavascriptMessage.loading.niceToString() : AuthClient.currentUser() ? LoginAuthMessage.SwitchUser.niceToString() : LoginAuthMessage.Login.niceToString()}
                    </button>
                    {error("login") && <span className="help-block text-danger ms-2">{error("login")}</span>}
                    {!p.ctx.loading && LoginOptions.resetPasswordControl()}
                </div>
            </div>
        </form>
    );
}
