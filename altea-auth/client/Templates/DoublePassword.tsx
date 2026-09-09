import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { classes } from "@altea/altea/data/globals/helpers";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { UserEntity } from "../../data/User";
import { LoginAuthMessage } from "../../data/AuthMessages";
import { AuthClient } from "../AuthClient";

// Port of Signum.Authorization's Templates/DoublePassword.tsx — "type the new password twice". It binds a
// plain `string` context and writes it only once BOTH boxes agree, so a half-typed password is never
// committed to the entity.
//
// altea divergences:
//  - the owning USER is OPTIONAL. Signum reads `ctx.frame!.pack.entity as UserEntity` unconditionally, so
//    the component only works inside a UserEntity frame — and Southwind's own RegisterUser page, which
//    renders it over a `RegisterUserModel` with a hand-made frame that carries no `pack`, throws a
//    TypeError on the first keystroke there. Here the user is found with `tryFindParentCtx(UserEntity)`
//    (which needs no frame at all): when there is one, `passwordIsChanging` is maintained exactly as in
//    Signum; when there is none, the component is just two password boxes over a string — which is what a
//    registration form needs.
//  - `frame?.revalidate()` is optional for the same reason.
//  - altea entities are snapshot-diffed, so Signum's `user.modified = true` has no counterpart: writing
//    `passwordIsChanging` IS the modification.
export function DoublePassword(p: {
    ctx: TypeContext<string>;
    initialOpen: boolean;
    mandatory: boolean;
    onChange?: () => void;
}): React.JSX.Element {

    const [isOpen, setIsOpen] = React.useState(p.initialOpen);
    const [passValidation, setPassValidation] = React.useState<AuthClient.PasswordValidationResult | null>(null);
    const newPass = React.useRef<HTMLInputElement>(null);
    const newPass2 = React.useRef<HTMLInputElement>(null);
    const forceUpdate = useForceUpdate();

    /** The UserEntity this password belongs to, when there is one (see the header). */
    function tryUser(): UserEntity | undefined {
        return p.ctx.tryFindParentCtx(UserEntity)?.value;
    }

    async function handlePasswordChange(): Promise<void> {
        const ctx = p.ctx;
        const user = tryUser();
        if (user != null)
            user.passwordIsChanging = true;

        if (newPass.current!.value && AuthClient.Options.validatePassword && user != null) {
            const result = await AuthClient.Options.validatePassword(newPass.current!.value, user);

            setPassValidation(result);

            if (result?.level === "error") {
                ctx.error = result.message;
            } else {
                ctx.error = undefined;
                if (newPass.current?.value && newPass2.current?.value && newPass.current.value !== newPass2.current.value)
                    ctx.error = LoginAuthMessage.PasswordsAreDifferent.niceToString();
            }
        } else {
            setPassValidation(null);
            ctx.error = undefined;
        }
        forceUpdate();
        ctx.frame?.revalidate();
    }

    function handlePasswordBlur(): void {
        const ctx = p.ctx;

        const firstValue = newPass.current!.value;
        const secondValue = newPass2.current!.value;

        if (passValidation?.level === "error") {
            ctx.error = passValidation.message;
        } else if (firstValue && secondValue && firstValue === secondValue) {
            ctx.error = undefined;
            ctx.value = firstValue;
            const user = tryUser();
            if (user != null)
                user.passwordIsChanging = false;
            setPassValidation(null);
            p.onChange?.();
        } else if (firstValue || secondValue) {
            ctx.error = LoginAuthMessage.PasswordsAreDifferent.niceToString();
        }
        forceUpdate();
        ctx.frame?.revalidate();
    }

    if (!isOpen) {
        return (
            <FormGroup label={LoginAuthMessage.NewPassword.niceToString()} ctx={p.ctx}>
                {() => <LinkButton title={undefined} className="btn btn-tertiary btn-sm" onClick={() => setIsOpen(true)}>
                    <FontAwesomeIcon aria-hidden={true} icon="key" /> {LoginAuthMessage.ChangePassword.niceToString()}
                </LinkButton>}
            </FormGroup>
        );
    }

    return (
        <div>
            <FormGroup label={LoginAuthMessage.NewPassword.niceToString()} ctx={p.ctx} error={null}>
                {inputId => (
                    <>
                        <input id={inputId} type="password" ref={newPass} autoComplete="new-password"
                            placeholder={LoginAuthMessage.NewPassword.niceToString()}
                            className={classes(p.ctx.formControlClass,
                                p.mandatory && !newPass.current?.value ? "sf-mandatory" : null,
                                passValidation && "is-invalid")}
                            onChange={handlePasswordChange}
                            onBlur={handlePasswordBlur} />
                        {passValidation && <span className={classes("help-block",
                            passValidation.level === "error" ? "text-danger" : "text-warning")}>{passValidation.message}</span>}
                    </>
                )}
            </FormGroup>
            <FormGroup ctx={p.ctx} label={LoginAuthMessage.ConfirmNewPassword.niceToString()} error={null}>
                {inputId => (
                    <input id={inputId} type="password" ref={newPass2} autoComplete="new-password"
                        placeholder={LoginAuthMessage.ConfirmNewPassword.niceToString()}
                        className={classes(p.ctx.formControlClass,
                            p.mandatory && !newPass2.current?.value ? "sf-mandatory" : null)}
                        onBlur={handlePasswordBlur} />
                )}
            </FormGroup>
        </div>
    );
}
