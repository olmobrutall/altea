import "@altea/altea/server"; // installs Entity.save()/delete()
import { type FluentOperations } from "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { toInt } from "@altea/altea/data/basics";
import { randomBytes } from "node:crypto";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Operations } from "@altea/altea/server/operationLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserWithClaims } from "@altea/altea/data/security";
import { PasswordEncoding } from "@altea/altea/server/passwordEncoding";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import type { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import type { Lite } from "@altea/altea/data/lite";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { Clock } from "@altea/altea/data/utils/clock";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { AuthServer } from "@altea/altea-auth/server/AuthServer";
import { UserEntity, UserOperation, UserState } from "@altea/altea-auth/data/User";
import { LoginAuthMessage } from "@altea/altea-auth/data/AuthMessages";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic";
import { EmailModelLogic, emailModel, type IEmailModel } from "@altea/altea-email/server/EmailModelLogic";
import { EmailRecipientKind } from "@altea/altea-email/data/Email";
import { EmailTemplateEntity, EmailTemplateEntity_Message, EmailMessageFormat } from "@altea/altea-email/data/EmailTemplate";
import {
    ResetPasswordRequestEntity, ResetPasswordRequestOperation, ResetPasswordRequestEmail, UserLockedMail,
    ResetPasswordMessage,
} from "../data/ResetPassword";
import { ResetPasswordServer } from "./ResetPasswordServer";

// Issue a single-use code, mail it, and consume it to set a new password. Every path runs with
// authorization DISABLED, because the caller is by definition not logged in.
//
// The code is generated with `node:crypto` randomBytes → base64url. It is a BEARER CREDENTIAL, so
// `Math.random()` would be a real weakness rather than a style choice.
//
// Each message's text is resolved in ITS culture, by mapping `(await CultureInfoLogic.applicationCultures())`
// inside `CultureInfo.withCultures`.
//
// Port of Signum.Authorization.ResetPassword's ResetPasswordRequestLogic.cs — see
// port/ResetPassword.md.

// `modelType` is what altea's renderer looks the REGISTRATION up by (see EmailLogic's `modelTypeOf`): a
// model whose shape differs from the entity it is about MUST carry it, or the lookup falls back to
// `untypedEntity.constructor` — here ResetPasswordRequestEntity / UserEntity, which are not registered
// models — needed because a plain object carries no type of its own.

/** The "here is your reset link" model. */
export function resetPasswordRequestMail(request: ResetPasswordRequestEntity, url: string): IEmailModel & { url: string } {
    return {
        ...emailModel({
            untypedEntity: request,
            getRecipients: () => [{ ownerData: EmailLogic.ownerDataOfEntity(request.user), kind: EmailRecipientKind.To }],
        }),
        modelType: ResetPasswordRequestEmail,
        url,
    };
}

/** The "your account is locked" model. */
export function userLockedMail(user: UserEntity, url: string): IEmailModel & { url: string } {
    return {
        ...emailModel({
            untypedEntity: user,
            getRecipients: () => [{ ownerData: EmailLogic.ownerDataOfEntity(user), kind: EmailRecipientKind.To }],
        }),
        modelType: UserLockedMail,
        url,
    };
}

export namespace ResetPasswordRequestLogic {

    /** How many unused codes a user may hold at once. */
    export let maxValidCodes = 5;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(ResetPasswordRequestEntity)
            .withOperations(registerResetPasswordRequestOperations)
            .withQuery();

        // When the failed-login lockout trips, mail the user a reset
        // link so they can recover without an administrator.
        AuthLogic.onDeactivateUser = async user => {
            const request = await resetPasswordRequest(user);
            await EmailLogic.sendMailFromModel(userLockedMail(user, resetUrl(request.code)));
        };

        EmailModelLogic.registerEmailModel({
            modelType: ResetPasswordRequestEmail,
            queryName: ResetPasswordRequestEntity,
            defaultTemplateConstructor: async () => EmailTemplateEntity.create({
                // altea requires these three explicitly: every non-nullable field is implicitly mandatory
                // (see CLAUDE.md), whereas Signum inherits the C# defaults. `disableAuthorization` /
                // `groupResults` ARE those defaults; `messageFormat` is a DELIBERATE divergence —
                // (Signum leaves it at PlainText while the body it writes is HTML, which would go out
                // as literal markup.
                disableAuthorization: false,
                groupResults: false,
                messageFormat: EmailMessageFormat.HtmlComplex,
                messages: await forEachCulture(cultureInfo => EmailTemplateEntity_Message.create({
                    cultureInfo,
                    subject: ResetPasswordMessage.ResetPasswordRequestSubject.niceToString(),
                    text: `<p>${ResetPasswordMessage.YouRecentlyRequestedANewPassword.niceToString()}</p>`
                        + `<p>${ResetPasswordMessage.YourUsernameIs.niceToString()} @[user.userName]</p>`
                        + `<p>${ResetPasswordMessage.YouCanResetYourPasswordByFollowingTheLinkBelow.niceToString()}</p>`
                        + `<p><a href="@[m:url]">@[m:url]</a></p>`,
                })),
            }),
        });

        EmailModelLogic.registerEmailModel({
            modelType: UserLockedMail,
            queryName: UserEntity,
            defaultTemplateConstructor: async () => EmailTemplateEntity.create({
                // altea requires these three explicitly: every non-nullable field is implicitly mandatory
                // (see CLAUDE.md), whereas Signum inherits the C# defaults. `disableAuthorization` /
                // `groupResults` ARE those defaults; `messageFormat` is a DELIBERATE divergence —
                // (Signum leaves it at PlainText while the body it writes is HTML, which would go out
                // as literal markup.
                disableAuthorization: false,
                groupResults: false,
                messageFormat: EmailMessageFormat.HtmlComplex,
                messages: await forEachCulture(cultureInfo => EmailTemplateEntity_Message.create({
                    cultureInfo,
                    subject: ResetPasswordMessage.YourAccountHasBeenLocked.niceToString(),
                    text: `<p>${ResetPasswordMessage.YourAccountHasBeenLockedDueToSeveralFailedLogins.niceToString()}</p>`
                        + `<p>${ResetPasswordMessage.YouCanResetYourPasswordByFollowingTheLinkBelow.niceToString()}</p>`
                        + `<p><a href="@[m:url]">@[m:url]</a></p>`,
                })),
            }),
        });

        // The routes are mounted here, guarded by the
        // SchemaBuilder's web builder, so a terminal / test host wires no HTTP (the pattern AuthLogic uses).
        if (sb.webBuilder)
            ResetPasswordServer.start(sb.webBuilder);
    }

    /** The link a mailed code lands on. */
    export function resetUrl(code: string): string {
        return `${EmailLogic.configurationLoaded().urlLeft}/auth/resetPassword?code=${encodeURIComponent(code)}`;
    }

    /**
     * Consume a code. Returns
     * the consumed request, or a `passwordError` when the new password fails the policy (the caller turns
     * that into a field error rather than an exception).
     */
    export async function resetPasswordRequestExecute(code: string, password: string):
        Promise<{ request: ResetPasswordRequestEntity | null; passwordError: string | null }> {

        return await AuthLogic.withDisabled(async () => {
            const rpr = await table(ResetPasswordRequestEntity).filter(r => r.code == code).singleOrNull() as ResetPasswordRequestEntity | null;
            if (rpr == null)
                throw new ResetPasswordException(ResetPasswordMessage.TheCodeOfYourLinkIsIncorrect.niceToString());

            const error = rpr.validate();
            if (error != null)
                throw new ResetPasswordException(error);

            const passwordError = validatePassword(password);
            if (passwordError != null)
                return { request: null, passwordError };

            await removeOtherRequests(rpr);

            // The write is attributed to the user
            // whose password is being reset, not to nobody.
            await UserHolder.withUser(new UserWithClaims(rpr.user), () =>
                Operations.execute(rpr, ResetPasswordRequestOperation.Execute, password));

            return { request: rpr, passwordError: null };
        });
    }

    /** An expired link's owner asks for a fresh one. */
    export async function requestNewLink(code: string): Promise<void> {
        await AuthLogic.withDisabled(async () => {
            const rpr = await table(ResetPasswordRequestEntity).filter(r => r.code == code).singleOrNull() as ResetPasswordRequestEntity | null;
            if (rpr == null)
                throw new ResetPasswordException(ResetPasswordMessage.TheCodeOfYourLinkIsIncorrect.niceToString());

            await sendResetPasswordRequestEmail(rpr.user.email!);
        });
    }

    /**
     * Mail a fresh link to EVERY active user with that
     * address. Swallows the error when `AuthServer.avoidExplicitErrorMessages` is on, so the endpoint
     * cannot be used to probe which addresses exist.
     */
    export async function sendResetPasswordRequestEmail(email: string): Promise<void> {
        try {
            let users: UserEntity[];
            try {
                users = await AuthLogic.withDisabled(() => table(UserEntity)
                    .filter(u => u.email == email && u.state != UserState.Deactivated)
                    .toArray()) as UserEntity[];

                if (users.length === 0)
                    throw new Error(ResetPasswordMessage.EmailNotFound.niceToString());
            } catch (e) {
                await logException(e);
                throw e;
            }

            try {
                for (const user of users) {
                    const request = await resetPasswordRequest(user);
                    await AuthLogic.withDisabled(() =>
                        EmailLogic.sendMailFromModel(resetPasswordRequestMail(request, resetUrl(request.code))));
                }
            } catch (e) {
                await logException(e);
                throw new Error(LoginAuthMessage.AnErrorOccurredRequestNotProcessed.niceToString());
            }
        } catch (e) {
            if (!AuthServer.avoidExplicitErrorMessages)
                throw e;
        }
    }

    /** Issue a code, capping how many stay valid. */
    export async function resetPasswordRequest(user: UserEntity, maxValid = maxValidCodes): Promise<ResetPasswordRequestEntity> {
        return await AuthLogic.withDisabled(() => ExecutionMode.global(async () => {
            await cancelExcess(user, maxValid - 1);

            const rpr = ResetPasswordRequestEntity.create({
                code: newCode(),
                user,
                requestDate: Clock.now,
            });
            await rpr.save();
            return rpr;
        }));
    }

    /** A 32-character URL-safe code. See the header on why this is `node:crypto`, not `Math.random`. */
    function newCode(): string {
        return randomBytes(24).toString("base64url").substring(0, 32);
    }

    /** Consuming one code invalidates the user's other codes. */
    async function removeOtherRequests(rpr: ResetPasswordRequestEntity): Promise<void> {
        const userId = rpr.user.id;
        const rprId = rpr.id;
        await table(ResetPasswordRequestEntity)
            .filter(r => r.user.id == userId && r.isValid() && r.id != rprId)
            .executeUpdate(() => ({ used: true }));
    }

    /**
     * Keep only the newest `maxValid` valid codes and mark
     * the rest used, so a user cannot accumulate live credentials by hammering the endpoint.
     *
     * The excess codes are selected first and cancelled by id, rather than as one set-based update over of
     * lites; altea reads the ids to KEEP and excludes them with `includes` (which the LINQ provider lowers
     * to `NOT IN`) — the same two statements, one less shape.
     */
    async function cancelExcess(user: UserEntity, maxValid: number): Promise<void> {
        const userId = user.id;

        const keep = maxValid <= 0 ? [] : await table(ResetPasswordRequestEntity)
            .filter(r => r.user.id == userId && r.isValid())
            .orderByDescending(r => r.requestDate)
            .top(maxValid)
            .map(r => r.id)
            .toArray();

        // An EMPTY keep-list (the common case: the user holds no live code yet) must not become
        // `NOT IN ()` — that is a SQL syntax error, not a tautology — so the clause is dropped instead.
        if (keep.length === 0) {
            await table(ResetPasswordRequestEntity)
                .filter(r => r.user.id == userId && r.isValid())
                .executeUpdate(() => ({ used: true }));
            return;
        }

        await table(ResetPasswordRequestEntity)
            .filter(r => r.user.id == userId && r.isValid() && !keep.includes(r.id))
            .executeUpdate(() => ({ used: true }));
    }

    /** The same 5-character floor AuthServer enforces. */
    export let validatePassword: (password: string) => string | null =
        password => password.length >= 5 ? null : LoginAuthMessage.ThePasswordMustHaveAtLeast0Characters.niceToString(5);
}

/** A reset code that cannot be used, with the reason. */
export class ResetPasswordException extends Error {
    constructor(message?: string) { super(message); this.name = "ResetPasswordException"; }
}

// Consume
// the code and set the new password (reactivating the user if the lockout had disabled them).
function registerResetPasswordRequestOperations(op: FluentOperations<ResetPasswordRequestEntity>): void {
    op.withExecute(ResetPasswordRequestOperation.Execute, {
        canBeNew: false,
        canBeModified: false,
        canExecute: e => e.validate(),
        execute: async (e, args) => {
            const password = args[0] as string;
            e.used = true;
            const user = e.user;

            const error = ResetPasswordRequestLogic.validatePassword(password);
            if (error != null)
                throw new ResetPasswordException(error);

            if (user.state === UserState.Deactivated)
                await Operations.execute(user, UserOperation.Reactivate);

            user.passwordHash = PasswordEncoding.hashPassword(user.userName, password);
            user.loginFailedCounter = toInt(0);
            await AuthLogic.withDisabled(() => Operations.execute(user, UserOperation.Save));
        },
    });
}

/** One EmailTemplate message per application culture, each rendered in ITS culture. */
async function forEachCulture(build: (culture: Lite<CultureInfoEntity>) => EmailTemplateEntity_Message): Promise<EmailTemplateEntity_Message[]> {
    return (await CultureInfoLogic.lookup()).lites()
        .map(c => CultureInfo.withCultures(c.name, () => build(c.lite)));
}

/** `ex.LogException()` — in its own transaction so the log survives the rollback of what failed. */
async function logException(e: unknown): Promise<void> {
    try {
        await ExecutionMode.global(() => Transaction.forceNew(() => ExceptionLogic.logException(e)));
    } catch {
        // Never let logging mask the original error.
    }
}
