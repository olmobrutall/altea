import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import { entity, uniqueIndex, quoted, stringLengthValidator } from "@altea/altea/data/decorators";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";

// Port of Signum.Authorization.ResetPassword's ResetPasswordRequest.cs — a single-use, time-limited code
// mailed to a user so they can set a new password without being logged in.
//
// altea divergences, documented inline:
//  - Signum's `[ExpressionField] bool IsValid / IsExpired` become `@quoted` methods, altea's one form for
//    "a body that is both an in-memory function and a SQL expression". BUT the comparison inside is a
//    relational operator on Temporal values, which the LINQ provider translates and JS does NOT support
//    (Temporal deliberately has no `valueOf`), so `isValid()` / `isExpired()` are QUERY-ONLY. The
//    in-memory answer comes from `validate()` below, which does the same comparison with
//    `Temporal.PlainDateTime.compare`. Signum needs no such split because .NET's DateTime supports both.
//  - `Random.Shared.NextString(32)` moves to the logic layer (`node:crypto`, server-only).
//  - `Validate()` (Signum's entity-level hook) stays a plain method: it is a MESSAGE for the caller, not a
//    field validation, and altea has no entity-level PropertyValidation hook anyway.

/** How long a mailed reset code stays usable (Signum hard-codes 2 hours in the IsExpired expression). */
export const RESET_PASSWORD_VALID_HOURS = 2;

@reflect
@entity("System", "Transactional")
export class ResetPasswordRequestEntity extends Entity {
    // Signum's `[UniqueIndex(AvoidAttachToUniqueIndexes = true)]`; altea has no AvoidAttachToUniqueIndexes
    // (it is a Signum query-optimisation hint), so a plain unique index.
    @uniqueIndex
    @stringLengthValidator({ max: 100 })
    code: string;

    user: UserEntity;

    requestDate: Temporal.PlainDateTime = Clock.now;

    used: boolean = false;

    /** Signum's IsValidExpression. QUERY-ONLY — see the header note; use `validate()` in memory. */
    @quoted
    isValid(): boolean {
        return !this.used && !this.isExpired();
    }

    /** Signum's IsExpiredExpression. QUERY-ONLY — see the header note. */
    @quoted
    isExpired(): boolean {
        return this.requestDate.add({ hours: RESET_PASSWORD_VALID_HOURS }) <= Clock.now;
    }

    /**
     * Signum's `Validate()` — null when the code may still be used, else WHY it may not. The in-memory
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

    override toString(): string {
        return `${this.user?.toString() ?? ""} ${this.requestDate?.toString() ?? ""}`;
    }
}

// ---- E-mail models ---------------------------------------------------------------------------------------
//
// Signum's `ResetPasswordRequestEmail : EmailModel<ResetPasswordRequestEntity>` and
// `UserLockedMail : EmailModel<UserEntity>` are plain C# classes whose public `Url` field the template
// reads as `@[m:Url]`. altea's templating resolves a `@[m:…]` member off the REGISTERED model TYPE's
// reflection metadata, so the shape has to be a declared model entity — these two — while the object the
// renderer actually walks is assembled on the server (see ResetPasswordRequestLogic).

/** Signum's ResetPasswordRequestEmail — "here is your reset link". */
@reflect
export class ResetPasswordRequestMail extends ModelEntity {
    /** The absolute link the recipient clicks (`@[m:url]` in the template). */
    url: string;
}

/** Signum's UserLockedMail — "your account was locked; here is a reset link". */
@reflect
export class UserLockedMail extends ModelEntity {
    url: string;
}

/** Signum's `[AutoInit] static class ResetPasswordRequestOperation`. */
export namespace ResetPasswordRequestOperation {
    export const Execute: ExecuteSymbol<ResetPasswordRequestEntity> = init();
}

// Signum's `enum ResetPasswordMessage` — the e-mail bodies and the page text.
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

// Signum's `[AllowUnauthenticated] enum ResetPasswordAuthMessage` — text an ANONYMOUS visitor sees.
export const ResetPasswordAuthMessage = {
    PleaseConsiderRequestingANewLink: msg(),
    RequestNewLink: msg(),
    NewLinkToResetPasswordHasBeenSentSuccessfully: msg(),
};
