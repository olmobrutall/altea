import { msg } from "@altea/altea/data/utils/localization";

// Port of Signum's AuthMessages.cs + the message enums scattered across UserEntity.cs. altea message
// containers are `{ Member: msg("Default text") }` objects (a bare `msg()` infers the default from the
// member name); `.niceToString(...args)` formats {0}/{1} placeholders and prefers a loaded translation.
// The C# `[Description("…")]` becomes the msg() argument; members with no Description pass bare msg().

// Signum's LoginAuthMessage (login / change-password / profile UI text).
export const LoginAuthMessage = {
    ThePasswordMustHaveAtLeast0Characters: msg("The password must have at least {0} characters"),
    NotUserLogged: msg(),
    Username0IsNotValid: msg("Username {0} is not valid"),
    User0IsDeactivated: msg("User {0} is deactivated"),
    IncorrectPassword: msg(),
    Login: msg(),
    MyProfile: msg(),
    Password: msg(),
    ChangePassword: msg(),
    SwitchUser: msg(),
    Logout: msg("Logout"),
    EnterYourUserNameAndPassword: msg(),
    Username: msg(),
    EMailAddress: msg("E-Mail Address"),
    EmailAddressOrUsername: msg("E-Mail Address or Username"),
    RememberMe: msg(),
    IHaveForgottenMyPassword: msg(),
    ShowLoginForm: msg("Show login form"),
    IForgotMyPassword: msg("I forgot my password"),
    EnterYourUserEmail: msg(),
    SendEmail: msg(),
    GiveUsYourUserEmailToResetYourPassword: msg("Give us your user's email and we will send you an email so you can reset your password."),
    RequestAccepted: msg(),
    PasswordMustHaveAValue: msg("The password must have a value"),
    PasswordsAreDifferent: msg(),
    PasswordChanged: msg(),
    PasswordHasBeenChangedSuccessfully: msg("The password has been changed successfully"),
    NewPassword: msg("New password"),
    EnterTheNewPassword: msg(),
    ConfirmNewPassword: msg(),
    EnterActualPasswordAndNewOne: msg("Enter your current password and the new one"),
    CurrentPassword: msg("Current password"),
    PasswordMustBeChanged: msg("Password must be changed"),
    YouMustChangeYourPasswordBeforeContinuing: msg("You must change your password before continuing"),
    WeHaveSentYouAnEmailToResetYourPassword: msg("We have sent you an email with a link that will allow you to reset your password."),
    UserNameMustHaveAValue: msg("The user name must have a value"),
    InvalidUsernameOrPassword: msg(),
    InvalidUsername: msg(),
    InvalidPassword: msg(),
    AnErrorOccurredRequestNotProcessed: msg("An error occurred, request not processed."),
    TheUserIsNotLongerInTheDatabase: msg(),
    Register0: msg("Register {0}"),
    Success: msg("Success"),
    _0HasBeenSucessfullyAssociatedWithUser1InThisDevice: msg("{0} has been successfully associated with user {1} in this device."),
    TryToLogInWithIt: msg("Try to log-in with it!"),
    LoginWith0: msg("Login with {0}"),
    SignInWithMicrosoft: msg("Sign in with Microsoft"),
    InvalidTokenDate0: msg("Invalid token date {0}"),
    NoLocalUserFound: msg(),
};

// Signum's AuthMessage (authorization error / rule-pack overview text).
export const AuthMessage = {
    NotAuthorizedTo0The1WithId2: msg("Not authorized to {0} the '{1}' with Id {2}"),
    NotAuthorizedToRetrieve0: msg("Not authorized to retrieve '{0}'"),
    NotAuthorizedTo01: msg("Not authorized to {0} '{1}'"),
    OnlyActive: msg(),
    IncludeTrivialMerges: msg(),
    DefaultAuthorization: msg("Default Authorization: "),
    MaximumOfThe0: msg("Maximum of the {0}"),
    MinumumOfThe0: msg("Minimum of the {0}"),
    SameAs0: msg("Same as {0}"),
    Nothing: msg(),
    Everything: msg(),
    UnableToDetermineIfYouCanRead0: msg("Unable to determine if you can read {0}"),
    TheQueryDoesNotEnsureThatYouCanRead0: msg("The query does not ensure that you can read {0}"),
};

// Signum's UserMessage (UserEntity.cs).
export const UserMessage = {
    UserIsNotActive: msg(),
};

// Signum's UserExternalIdMessage (UserEntity.cs).
export const UserExternalIdMessage = {
    TheUser0IsConnectedToAnExternalProviderAndCanNotHaveALocalPasswordSet:
        msg("The user {0} is connected to an external provider and can not have a local password set"),
};

// Signum's AuthAdminMessage (Rules/AuthAdminMessage.cs) — only the members needed by the entity
// PropertyValidations so far; the rule-pack-admin members are added with the authorization phase.
export const AuthAdminMessage = {
    TheUserStateMustBeDisabled: msg(),
    PasswordChangeIsNotCompleted: msg(),
    Check: msg(),
    Uncheck: msg(),
    _0InDB: msg("{0} in DB"),
    _0InUI: msg("{0} in UI"),
    Save: msg("Save"),
    ResetChanges: msg("Reset changes"),
    /** Why a property route is not readable — the reason PropertyRoute.isAllowed() returns. */
    Property0IsNotAllowed: msg("Property {0} is not allowed"),
    SwitchTo: msg("Switch to…"),
    TypePermissionOverview: msg("Type permission overview"),
    Overriden: msg("Overridden"),
    TypeRules: msg("Type rules"),
    PermissionRules: msg("Permission rules"),
    DownloadAuthRules: msg("Download AuthRules"),
    Allowed: msg("Allowed"),
    Allow: msg("Allow"),
    Deny: msg("Deny"),
    Search: msg("Search…"),
};
