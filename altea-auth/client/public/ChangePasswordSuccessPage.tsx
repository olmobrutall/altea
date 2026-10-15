import * as React from "react";
import { LoginAuthMessage } from "../../data/AuthMessages";

// Port of Signum.Authorization's Login/ChangePasswordSuccessPage.tsx.
export default function ChangePasswordSuccessPage(): React.JSX.Element {
    return (
        <div className="sf-container sf-change-password-success">
            <div className="sf-row">
                <div className="md:col-span-6 md:col-start-4">
                    <h1 className="sf-entity-title text-h2 font-medium">{LoginAuthMessage.PasswordChanged.niceToString()}</h1>
                    <p>{LoginAuthMessage.PasswordHasBeenChangedSuccessfully.niceToString()}</p>
                </div>
            </div>
        </div>
    );
}
