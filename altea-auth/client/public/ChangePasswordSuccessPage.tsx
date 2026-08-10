import * as React from "react";
import { LoginAuthMessage } from "../../data/AuthMessages";

// Port of Signum's ChangePasswordSuccessPage.tsx (Login/ChangePasswordSuccessPage.tsx).
export default function ChangePasswordSuccessPage(): React.JSX.Element {
    return (
        <div className="container sf-change-password-success">
            <div className="row">
                <div className="col-md-6 offset-md-3">
                    <h1 className="sf-entity-title h2">{LoginAuthMessage.PasswordChanged.niceToString()}</h1>
                    <p>{LoginAuthMessage.PasswordHasBeenChangedSuccessfully.niceToString()}</p>
                </div>
            </div>
        </div>
    );
}
