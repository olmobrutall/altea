import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Dropdown, DropdownContent, DropdownItem, DropdownSeparator, DropdownTrigger } from "@altea/altea/client/ui/Dropdown";
import * as AppContext from "@altea/altea/client/AppContext";
import { LoginAuthMessage } from "../../data/AuthMessages";
import { UserEntity } from "../../data/User";
import { AuthClient } from "../AuthClient";

// Port of Signum.Authorization's Login/LoginDropdown.tsx — the header user menu.
// divergences: `LinkContainer` (react-router-bootstrap, not a dep) → `AppContext.navigate` onClick;
// `SmallProfilePhoto` becomes a plain user icon, and there is no culture picker here.

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
            <button type="button" className="nav-link sf-login" onClick={() => AppContext.navigate("/auth/login")}>
                {LoginDropdown.customLoginIcon(user)}
                <span> {LoginAuthMessage.Login.niceToString()}</span>
            </button>
        );

    const cpv = p.changePasswordVisible ?? true;
    const suv = p.switchUserVisible ?? true;
    const pv = p.profileVisible ?? true;

    // Navigator on demand, not imported: this dropdown renders the logged-out "Login" link, so it is in
    // the app shell's static graph, which Navigator's guard forbids.
    function handleProfileClick(): void {
        void import("@altea/altea/client/Navigator")
            .then(({ Navigator }) => Navigator.API.fetchEntityPack(user!.toLite()).then(pack => Navigator.view(pack)))
            .then(u => u && AuthClient.API.fetchCurrentUser(true).then(nu => AuthClient.setCurrentUser(nu)));
    }

    const extraButtons = p.extraMenuItems && p.extraMenuItems(user);

    return (
        <div className="nav-item dropdown sf-login-dropdown">
          <Dropdown>
            <DropdownTrigger asChild>
              <button type="button" id="sfLoginDropdown" className="nav-link dropdown-toggle">
                <span className="inline-flex items-center">
                    {p.renderIcon ? p.renderIcon(user) : LoginDropdown.customLoginIcon(user)}
                    &nbsp;
                    {p.renderName ? p.renderName(user) : user.toString()}
                </span>
              </button>
            </DropdownTrigger>
            <DropdownContent align="end">
            {pv && (
                <DropdownItem id="sf-auth-profile" onClick={handleProfileClick}>
                    <FontAwesomeIcon aria-hidden={true} icon="user-pen" className="fa-fw me-2" /> {LoginAuthMessage.MyProfile.niceToString()}
                </DropdownItem>
            )}
            {cpv && (
                <DropdownItem onClick={() => AppContext.navigate("/auth/changePassword")}>
                    <FontAwesomeIcon aria-hidden={true} icon="key" className="fa-fw me-2" /> {LoginAuthMessage.ChangePassword.niceToString()}
                </DropdownItem>
            )}
            {extraButtons}
            {(cpv || pv || extraButtons) && <DropdownSeparator />}
            {suv && (
                <DropdownItem onClick={() => AppContext.navigate("/auth/login")}>
                    <FontAwesomeIcon aria-hidden={true} icon="user-group" className="me-2" /> {LoginAuthMessage.SwitchUser.niceToString()}
                </DropdownItem>
            )}
            <DropdownItem id="sf-auth-logout" onClick={() => AuthClient.logout()}>
                <FontAwesomeIcon icon="right-from-bracket" aria-hidden={true} className="fa-fw me-2" /> {LoginAuthMessage.Logout.niceToString()}
            </DropdownItem>
            </DropdownContent>
          </Dropdown>
        </div>
    );
}

namespace LoginDropdown {
    export function customLoginIcon(user: UserEntity | null | undefined): React.JSX.Element {
        return <FontAwesomeIcon icon="user" className="me-1" />;
    }
}

export default LoginDropdown;
