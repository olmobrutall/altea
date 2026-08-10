import * as React from "react";
import { classes, Dic, ifError } from "@altea/altea/data/globals";
import * as AppContext from "@altea/altea/client/AppContext";
import type { ModelState } from "@altea/altea/data/validation";
import { ValidationError } from "@altea/altea/client/Services";
import { useStateWithPromise } from "@altea/altea/client/Hooks";
import { QueryString } from "@altea/altea/client/QueryString";
import { LoginAuthMessage } from "../../data/AuthMessages";
import { AuthClient } from "../AuthClient";

// Port of Signum's ChangePasswordPage.tsx (Login/ChangePasswordPage.tsx). altea divergence: altea's
// ModelState is ONE string per field (Signum's was string[]), so the field helpers use "" for "no
// error" and error(field) returns the string directly.

export default function ChangePasswordPage(): React.JSX.Element {
    const [modelState, setModelState] = useStateWithPromise<ModelState | undefined>(undefined);

    const currentUser = AuthClient.currentUser();
    const pendingUser = AuthClient.getPendingPasswordChangeUser();
    const user = currentUser ?? pendingUser;
    const mustChangePassword = pendingUser != null || currentUser?.mustChangePassword === true;
    const [passValidation, setPassValidation] = React.useState<AuthClient.PasswordValidationResult | null>(null);

    const oldPassword = React.useRef<HTMLInputElement>(null);
    const newPassword = React.useRef<HTMLInputElement>(null);
    const newPassword2 = React.useRef<HTMLInputElement>(null);

    function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
        e.preventDefault();

        const ms: ModelState = { ...validateOldPassword(), ...comparePasswords() };
        void setModelState(ms);

        if (Dic.getValues(ms).some(v => v !== ""))
            return;
        if (passValidation?.level === "error")
            return;

        const request: AuthClient.API.ChangePasswordRequest = {
            oldPassword: oldPassword.current!.value,
            newPassword: newPassword.current!.value,
        };

        AuthClient.API.changePassword(request)
            .then(lr => {
                AuthClient.setAuthToken(lr.token, lr.authenticationType);
                AuthClient.setCurrentUser(lr.userEntity);
                AuthClient.setPendingPasswordChangeUser(undefined);

                if (mustChangePassword) {
                    const back = QueryString.parse(window.location.search).back as string | undefined;
                    AuthClient.Options.onLogin(back);
                } else {
                    AppContext.resetUI();
                    AppContext.navigate("/auth/changePasswordSuccess");
                }
            })
            .catch(ifError(ValidationError, e => {
                if (e.modelState)
                    void setModelState(e.modelState);
            }));
    }

    function error(field: string): string | undefined {
        return modelState && modelState[field] ? modelState[field] : undefined;
    }

    function handleOldPasswordBlur(): void {
        void setModelState(prev => ({ ...prev, ...validateOldPassword() }));
    }

    async function handlePasswordChange(): Promise<void> {
        if (newPassword.current!.value && AuthClient.Options.validatePassword && user) {
            const result = await AuthClient.Options.validatePassword(newPassword.current!.value, user);
            setPassValidation(result);
            if (result?.level === "error")
                void setModelState(prev => ({ ...prev, newPassword: result.message, newPassword2: "" }));
            else
                void setModelState(prev => ({ ...prev, newPassword: "", newPassword2: "" }));
        } else {
            setPassValidation(null);
            void setModelState(prev => ({ ...prev, newPassword: "", newPassword2: "" }));
        }
    }

    function validateOldPassword(): ModelState {
        return { oldPassword: oldPassword.current!.value ? "" : LoginAuthMessage.PasswordMustHaveAValue.niceToString() };
    }

    function comparePasswords(): ModelState {
        const pwd1 = newPassword.current!.value;
        const pwd2 = newPassword2.current!.value;
        if (!pwd1 && !pwd2)
            return { newPassword: LoginAuthMessage.PasswordMustHaveAValue.niceToString(), newPassword2: "" };
        if (pwd1 !== pwd2)
            return { newPassword: "", newPassword2: LoginAuthMessage.PasswordsAreDifferent.niceToString() };
        return { newPassword: "", newPassword2: "" };
    }

    function handlePasswordBlur(): void {
        void setModelState(prev => ({ ...prev, ...comparePasswords() }));
    }

    return (
        <div className="container sf-reset-password">
            <div className="row">
                <div className="col-md-6 offset-md-3">
                    <form onSubmit={handleSubmit} className="w-100">
                        <h1 className="sf-entity-title h2">{LoginAuthMessage.ChangePassword.niceToString()}</h1>
                        {mustChangePassword && (
                            <div className="alert alert-warning" role="alert">
                                <strong>{LoginAuthMessage.PasswordMustBeChanged.niceToString()}</strong>
                                <p className="mb-0">{LoginAuthMessage.YouMustChangeYourPasswordBeforeContinuing.niceToString()}</p>
                            </div>
                        )}
                        <p>{LoginAuthMessage.EnterActualPasswordAndNewOne.niceToString()}</p>
                        <div className={classes("form-group form-group-sm", error("oldPassword") && "has-error")}>
                            <label className="col-form-label col-form-label-sm">{LoginAuthMessage.CurrentPassword.niceToString()}</label>
                            <div>
                                <input type="password" className="form-control form-control-sm" id="currentPassword" ref={oldPassword} onBlur={handleOldPasswordBlur} autoComplete="old-password" />
                                {error("oldPassword") && <span className="help-block text-danger">{error("oldPassword")}</span>}
                            </div>
                        </div>
                        <div className={classes("form-group form-group-sm", error("newPassword") && "has-error")}>
                            <label className="col-form-label col-form-label-sm">{LoginAuthMessage.EnterTheNewPassword.niceToString()}</label>
                            <div>
                                <input type="password" className={classes("form-control form-control-sm", passValidation && "is-invalid")} id="newPassword" ref={newPassword} onChange={handlePasswordChange} onBlur={handlePasswordBlur} autoComplete="new-password" />
                                {passValidation && <span className={classes("help-block", passValidation.level === "error" ? "text-danger" : "text-warning")}>{passValidation.message}</span>}
                                {error("newPassword") && <span className="help-block text-danger">{error("newPassword")}</span>}
                            </div>
                        </div>
                        <div className={classes("form-group form-group-sm", error("newPassword2") && "has-error")}>
                            <label className="col-form-label col-form-label-sm">{LoginAuthMessage.ConfirmNewPassword.niceToString()}</label>
                            <div>
                                <input type="password" className="form-control form-control-sm" id="newPassword2" ref={newPassword2} onBlur={handlePasswordBlur} autoComplete="new-password" />
                                {error("newPassword2") && <span className="help-block text-danger">{error("newPassword2")}</span>}
                            </div>
                        </div>
                        <button type="submit" className="btn btn-primary mt-2" id="changePassword">{LoginAuthMessage.ChangePassword.niceToString()}</button>
                    </form>
                </div>
            </div>
        </div>
    );
}
