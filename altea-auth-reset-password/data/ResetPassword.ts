import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import { entity, uniqueIndex, quoted, legacyPropertyRoute } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";

// A single-use, time-limited code mailed to a user so they can set a new password without being logged in.
//
// **`isValid()` / `isExpired()` are QUERY-ONLY.** They are `@quoted`, but the comparison inside is a
// relational operator on Temporal values — which the LINQ provider translates and JavaScript does not
// support, since Temporal deliberately has no `valueOf`. The in-memory answer comes from `validate()`
// below, which does the same comparison through `Temporal.PlainDateTime.compare`.
//
// Port of Signum.Authorization.ResetPassword's ResetPasswordRequest.cs — see docs/port/ResetPassword.md.

/** How long a mailed reset code stays usable. Two hours, as in Signum — but settable here. */
export const RESET_PASSWORD_VALID_HOURS = 2;

@reflect
@entity("System", "Transactional")
export class ResetPasswordRequestEntity extends Entity {
    // A plain unique index: there is no per-index opt-out from the isolation rewrite to express.
    @uniqueIndex
    @stringLengthValidator({ max: 100 })
    code: string;

    user: UserEntity;

    requestDate: Temporal.PlainDateTime = Clock.now;

    used: boolean = false;

    /** QUERY-ONLY — see the header; use `validate()` in memory. */
    @legacyPropertyRoute
    @quoted
    isValid(): boolean {
        return !this.used && !this.isExpired();
    }

    /** QUERY-ONLY — see the header. */
    @legacyPropertyRoute
    @quoted
    isExpired(): boolean {
        return this.requestDate.add({ hours: RESET_PASSWORD_VALID_HOURS }) <= Clock.now;
    }

    /**
     * Null when the code may still be used, else WHY it may not. The in-memory
     * twin of `isValid()` (see the header note on why they cannot be one method).
     */
    validate(): string | null {
        if (this.used)
            return `${ResetPasswordMessage.TheCodeOfYourLinkHasAlreadyBeenUsed.niceToString()}. `
                + ResetPasswordAuthMessage.PleaseConsiderRequestingANewLink.niceToString();

        const expiresOn = this.requestDate.add({ hours: RESET_PASSWORD_VALID_HOURS });
        if (Temporal.PlainDateTime.compare(Clock.now, expiresOn) >= 0)
            return `${ResetPasswordMessage.YourResetPasswordRequestHasExpired.niceToString()}. `
                + ResetPasswordAuthMessage.PleaseConsiderRequestingANewLink.niceToString();

        return null;
    }

    // No `toString()`, so the table has no
    // ToStr column — a request is short-lived bookkeeping nobody browses by name. Entity's own
    // "<nice name> <id>" default (which IS translatable) stands in.
}

// ---- E-mail models ---------------------------------------------------------------------------------------
//
// The two email models this module declares:
// `UserLockedMail : EmailModel<UserEntity>` are plain C# classes whose public `Url` field the template
// reads as `@[m:Url]`. altea's templating resolves a `@[m:…]` member off the REGISTERED model TYPE's
// reflection metadata, so the shape has to be a declared model entity — these two — while the object the
// renderer actually walks is assembled on the server (see ResetPasswordRequestLogic).

/** "Here is your reset link". The NAME is Signum's exactly, because it is the EmailModel registry ROW
 *  (mailing.email_model.class_name) — so "Mail" here would read as a model Southwind
 *  does not have plus one of its own that was gone. */
@reflect
export class ResetPasswordRequestEmail extends ModelEntity {
    /** The absolute link the recipient clicks (`@[m:url]` in the template). */
    url: string;
}

/** "your account was locked; here is a reset link". */
@reflect
export class UserLockedMail extends ModelEntity {
    url: string;
}

/** The request's operations. */
export namespace ResetPasswordRequestOperation {
    export const Execute: ExecuteSymbol<ResetPasswordRequestEntity> = init();
}

// The e-mail bodies and the page text.
export const ResetPasswordMessage = {
    YouRecentlyRequestedANewPassword: msg("You recently requested a new password"),
    YourUsernameIs: msg("Your username is:"),
    YouCanResetYourPasswordByFollowingTheLinkBelow: msg("You can reset your password by following the link below"),
    ResetPasswordRequestSubject: msg("Reset password request"),
    YourResetPasswordRequestHasExpired: msg("Your reset password request has expired"),
    WeHaveSendYouAnEmailToResetYourPassword: msg("We have send you an email to reset your password"),
    EmailNotFound: msg("Email not found"),
    YourAccountHasBeenLockedDueToSeveralFailedLogins: msg("Your account has been locked due to several failed logins"),
    YourAccountHasBeenLocked: msg("Your account has been locked"),
    TheCodeOfYourLinkIsIncorrect: msg(),
    TheCodeOfYourLinkHasAlreadyBeenUsed: msg(),
    IfEmailIsValidWeWillSendYouAnEmailToResetYourPassword: msg(),
};

// Text an ANONYMOUS visitor sees.
export const ResetPasswordAuthMessage = {
    PleaseConsiderRequestingANewLink: msg(),
    RequestNewLink: msg(),
    NewLinkToResetPasswordHasBeenSentSuccessfully: msg(),
};

setDefaultDatabaseSchema("auth");
