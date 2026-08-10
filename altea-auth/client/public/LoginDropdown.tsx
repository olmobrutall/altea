import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Nav, NavDropdown } from "react-bootstrap";
import * as AppContext from "@altea/altea/client/AppContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { LoginAuthMessage } from "../../data/AuthMessages";
import { UserEntity } from "../../data/User";
import { AuthClient } from "../AuthClient";

// Port of Signum's LoginDropdown.tsx (Login/LoginDropdown.tsx) — the header user menu. altea
// divergences: `LinkContainer` (react-router-bootstrap, not a dep) → `AppContext.navigate` onClick;
// `SmallProfilePhoto` (Signum.Files, not ported) → a plain user icon; `CultureClient` dropped.

function LoginDropdown(p: {
    renderName?: (u: UserEntity) => React.ReactElement | string | null;
    renderIcon?: (u: UserEntity) => React.ReactNode;
    changePasswordVisible?: boolean;
    switchUserVisible?: boolean;
    profileVisible?: boolean;
    extraMenuItems?: (user: UserEntity) => React.ReactNode | undefined | null;
}): React.JSX.Element {
    const user = AuthClient.currentUser();

    if (!user)
        return (
            <Nav.Link className="sf-login" onClick={() => AppContext.navigate("/auth/login")}>
                {LoginDropdown.customLoginIcon(user)}
                <span> {LoginAuthMessage.Login.niceToString()}</span>
            </Nav.Link>
        );

    const cpv = p.changePasswordVisible ?? true;
    const suv = p.switchUserVisible ?? true;
    const pv = p.profileVisible ?? true;

    function handleProfileClick(): void {
        void Navigator.API.fetchEntityPack(user!.toLite())
            .then(pack => Navigator.view(pack))
            .then(u => u && AuthClient.API.fetchCurrentUser(true).then(nu => AuthClient.setCurrentUser(nu)));
    }

    const extraButtons = p.extraMenuItems && p.extraMenuItems(user);

    return (
        <NavDropdown
            className="sf-login-dropdown"
            id="sfLoginDropdown"
            title={
                <span className="d-inline-flex align-items-center">
                    {p.renderIcon ? p.renderIcon(user) : LoginDropdown.customLoginIcon(user)}
                    &nbsp;
                    {p.renderName ? p.renderName(user) : user.toString()}
                </span>
            }
            align="end"
        >
            {pv && (
                <NavDropdown.Item id="sf-auth-profile" onClick={handleProfileClick}>
                    <FontAwesomeIcon aria-hidden={true} icon="user-pen" className="fa-fw me-2" /> {LoginAuthMessage.MyProfile.niceToString()}
                </NavDropdown.Item>
            )}
            {cpv && (
                <NavDropdown.Item onClick={() => AppContext.navigate("/auth/changePassword")}>
                    <FontAwesomeIcon aria-hidden={true} icon="key" className="fa-fw me-2" /> {LoginAuthMessage.ChangePassword.niceToString()}
                </NavDropdown.Item>
            )}
            {extraButtons}
            {(cpv || pv || extraButtons) && <NavDropdown.Divider />}
            {suv && (
                <NavDropdown.Item onClick={() => AppContext.navigate("/auth/login")}>
                    <FontAwesomeIcon aria-hidden={true} icon="user-group" className="me-2" /> {LoginAuthMessage.SwitchUser.niceToString()}
                </NavDropdown.Item>
            )}
            <NavDropdown.Item id="sf-auth-logout" onClick={() => AuthClient.logout()}>
                <FontAwesomeIcon icon="right-from-bracket" aria-hidden={true} className="fa-fw me-2" /> {LoginAuthMessage.Logout.niceToString()}
            </NavDropdown.Item>
        </NavDropdown>
    );
}

namespace LoginDropdown {
    export function customLoginIcon(user: UserEntity | null | undefined): React.JSX.Element {
        return <FontAwesomeIcon icon="user" className="me-1" />;
    }
}

export default LoginDropdown;
