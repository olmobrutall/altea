import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave/.withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import { randomBytes } from "node:crypto";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { graph } from "@altea/altea/server/graphBuilder";
import { table } from "@altea/altea/server/table";
import { Operations } from "@altea/altea/server/operationLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { UserHolder } from "@altea/altea/server/userHolder";
import { UserWithClaims } from "@altea/altea/data/security";
import { PasswordEncoding } from "@altea/altea/server/passwordEncoding";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import { ExceptionLogic } from "@altea/altea/server/exceptionLogic";
import { Clock } from "@altea/altea/data/utils/clock";
import { AuthLogic } from "@altea/altea-auth/server/AuthLogic";
import { AuthServer } from "@altea/altea-auth/server/AuthServer";
import { UserEntity, UserOperation, UserState } from "@altea/altea-auth/data/User";
import { LoginAuthMessage } from "@altea/altea-auth/data/AuthMessages";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic.server";
import { EmailModelLogic, emailModel, type IEmailModel } from "@altea/altea-email/server/EmailModelLogic.server";
import { EmailRecipientKindEnum } from "@altea/altea-email/data/Email";
import { EmailTemplateEntity, EmailTemplateEntity_Message, EmailMessageFormatEnum } from "@altea/altea-email/data/EmailTemplate";
import {
    ResetPasswordRequestEntity, ResetPasswordRequestOperation, ResetPasswordRequestMail, UserLockedMail,
    ResetPasswordMessage,
} from "../data/ResetPassword";
import { ResetPasswordServer } from "./ResetPasswordServer";

// Port of Signum.Authorization.ResetPassword's ResetPasswordRequestLogic.cs — issue a single-use code, mail
// it, and consume it to set a new password. Every path runs with authorization DISABLED, because the caller
// is by definition not logged in.
//
// altea divergences, documented inline:
//  - `Random.Shared.NextString(32)` → `node:crypto` randomBytes → base64url (cryptographically strong; the
//    code is a bearer credential, so `Math.random()` would be a real weakness, not a style choice).
//  - `EmailModel<T>` classes → the declared model types in data/ + the two factories below (see
//    @altea/altea-email's EmailModelLogic header for the shape).
//  - `CultureInfoLogic.ForEachCulture(culture => …)` → `CultureInfoLogic.applicationCultures()` mapped
//    inside `CultureInfo.withCultures`, so each message's text is resolved in ITS culture.
//  - `out string? passwordError` becomes a returned object (TS has no out parameters).
//  - `OperationLogic.AllowSave<UserEntity>()` has no counterpart in altea (no RequiresSaveOperation guard).
//  - `ex.LogException()` → `ExceptionLogic.logException(e)` inside `Transaction.forceNew` (a log write must
//    not ride the failed transaction — see the scheduler/processes ports).

// `modelType` is what altea's renderer looks the REGISTRATION up by (see EmailLogic's `modelTypeOf`): a
// model whose shape differs from the entity it is about MUST carry it, or the lookup falls back to
// `untypedEntity.constructor` — here ResetPasswordRequestEntity / UserEntity, which are not registered
// models. Signum has no such field because its model IS a class instance.

/** Signum's `ResetPasswordRequestEmail(request, url)`. */
export function resetPasswordRequestMail(request: ResetPasswordRequestEntity, url: string): IEmailModel & { url: string } {
    return {
        ...emailModel({
            untypedEntity: request,
            getRecipients: () => [{ ownerData: EmailLogic.ownerDataOfEntity(request.user), kind: EmailRecipientKindEnum.To }],
        }),
        modelType: ResetPasswordRequestMail,
        url,
    };
}

/** Signum's `UserLockedMail(user, url)`. */
export function userLockedMail(user: UserEntity, url: string): IEmailModel & { url: string } {
    return {
        ...emailModel({
            untypedEntity: user,
            getRecipients: () => [{ ownerData: EmailLogic.ownerDataOfEntity(user), kind: EmailRecipientKindEnum.To }],
        }),
        modelType: UserLockedMail,
        url,
    };
}

export namespace ResetPasswordRequestLogic {

    /** Signum's `maxValidCodes` default — how many unused codes a user may hold at once. */
    export let maxValidCodes = 5;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(ResetPasswordRequestEntity).withQuery();

        // Signum's `AuthLogic.OnDeactivateUser`: when the failed-login lockout trips, mail the user a reset
        // link so they can recover without an administrator.
        AuthLogic.onDeactivateUser = async user => {
            const request = await resetPasswordRequest(user);
            await EmailLogic.sendMailFromModel(userLockedMail(user, resetUrl(request.code)));
        };

        EmailModelLogic.registerEmailModel({
            modelType: ResetPasswordRequestMail,
            queryName: ResetPasswordRequestEntity,
            defaultTemplateConstructor: () => EmailTemplateEntity.create({
                // altea requires these three explicitly: every non-nullable field is implicitly mandatory
                // (see CLAUDE.md), whereas Signum inherits the C# defaults. `disableAuthorization` /
                // `groupResults` ARE those defaults; `messageFormat` is a DELIBERATE divergence —
                // Signum leaves it at PlainText while the body it writes below is HTML, which would go out
                // as literal markup.
                disableAuthorization: false,
                groupResults: false,
                messageFormat: EmailMessageFormatEnum.HtmlComplex,
                messages: forEachCulture(culture => EmailTemplateEntity_Message.create({
                    culture,
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
            defaultTemplateConstructor: () => EmailTemplateEntity.create({
                // altea requires these three explicitly: every non-nullable field is implicitly mandatory
                // (see CLAUDE.md), whereas Signum inherits the C# defaults. `disableAuthorization` /
                // `groupResults` ARE those defaults; `messageFormat` is a DELIBERATE divergence —
                // Signum leaves it at PlainText while the body it writes below is HTML, which would go out
                // as literal markup.
                disableAuthorization: false,
                groupResults: false,
                messageFormat: EmailMessageFormatEnum.HtmlComplex,
                messages: forEachCulture(culture => EmailTemplateEntity_Message.create({
                    culture,
                    subject: ResetPasswordMessage.YourAccountHasBeenLocked.niceToString(),
                    text: `<p>${ResetPasswordMessage.YourAccountHasBeenLockedDueToSeveralFailedLogins.niceToString()}</p>`
                        + `<p>${ResetPasswordMessage.YouCanResetYourPasswordByFollowingTheLinkBelow.niceToString()}</p>`
                        + `<p><a href="@[m:url]">@[m:url]</a></p>`,
                })),
            }),
        });

        ResetPasswordRequestGraph.register();

        // Signum's controller is discovered by ASP.NET; altea mounts the routes here, guarded by the
        // SchemaBuilder's web builder, so a terminal / test host wires no HTTP (the pattern AuthLogic uses).
        if (sb.webBuilder)
            ResetPasswordServer.start(sb.webBuilder);
    }

    /** Signum's `EmailLogic.Configuration.UrlLeft + "/auth/resetPassword?code={0}"`. */
    export function resetUrl(code: string): string {
        return `${EmailLogic.configuration().urlLeft}/auth/resetPassword?code=${encodeURIComponent(code)}`;
    }

    /**
     * Signum's `ResetPasswordRequestExecute(code, password, out passwordError)` — consume a code. Returns
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

            // Signum's `using (UserHolder.UserSession(rpr.User))`: the write is attributed to the user
            // whose password is being reset, not to nobody.
            await UserHolder.withUser(new UserWithClaims(rpr.user), () =>
                Operations.execute(rpr, ResetPasswordRequestOperation.Execute, password));

            return { request: rpr, passwordError: null };
        });
    }

    /** Signum's `RequestNewLink(code)` — an expired link's owner asks for a fresh one. */
    export async function requestNewLink(code: string): Promise<void> {
        await AuthLogic.withDisabled(async () => {
            const rpr = await table(ResetPasswordRequestEntity).filter(r => r.code == code).singleOrNull() as ResetPasswordRequestEntity | null;
            if (rpr == null)
                throw new ResetPasswordException(ResetPasswordMessage.TheCodeOfYourLinkIsIncorrect.niceToString());

            await sendResetPasswordRequestEmail(rpr.user.email!);
        });
    }

    /**
     * Signum's `SendResetPasswordRequestEmail(email)` — mail a fresh link to EVERY active user with that
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

    /** Signum's `ResetPasswordRequest(user, maxValidCodes)` — issue a code, capping how many stay valid. */
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

    /** Signum's `RemoveOtherRequests(rpr)` — consuming one code invalidates the user's other codes. */
    async function removeOtherRequests(rpr: ResetPasswordRequestEntity): Promise<void> {
        const userId = rpr.user.id;
        const rprId = rpr.id;
        await table(ResetPasswordRequestEntity)
            .filter(r => r.user.id == userId && r.isValid() && r.id != rprId)
            .executeUpdate(() => ({ used: true }));
    }

    /**
     * Signum's `CancelExcess(user, maxValidCodes)` — keep only the newest `maxValid` valid codes and mark
     * the rest used, so a user cannot accumulate live credentials by hammering the endpoint.
     *
     * altea divergence: Signum builds a `valid.Any(c => c.Is(r))` sub-predicate over a materialised list of
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

    /** Signum's `UserEntity.OnValidatePassword` — the same 5-character floor AuthServer enforces. */
    export let validatePassword: (password: string) => string | null =
        password => password.length >= 5 ? null : LoginAuthMessage.ThePasswordMustHaveAtLeast0Characters.niceToString(5);
}

/** Signum's ResetPasswordException. */
export class ResetPasswordException extends Error {
    constructor(message?: string) { super(message); this.name = "ResetPasswordException"; }
}

// Signum's `new Graph<ResetPasswordRequestEntity>.Execute(ResetPasswordRequestOperation.Execute)`: consume
// the code and set the new password (reactivating the user if the lockout had disabled them).
const ResetPasswordRequestGraph = graph(ResetPasswordRequestEntity, g => {
    g.Execute(ResetPasswordRequestOperation.Execute, {
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
            user.loginFailedCounter = 0;
            await AuthLogic.withDisabled(() => Operations.execute(user, UserOperation.Save));
        },
    });
});

/** One EmailTemplate message per application culture, each rendered in ITS culture. */
function forEachCulture(build: (culture: ReturnType<typeof cultureLite>) => EmailTemplateEntity_Message): EmailTemplateEntity_Message[] {
    return CultureInfoLogic.applicationCultures()
        .map(name => CultureInfo.withCultures(name, () => build(cultureLite(name))));
}

function cultureLite(name: string) {
    return CultureInfoLogic.getCulture(name).toLite();
}

/** `ex.LogException()` — in its own transaction so the log survives the rollback of what failed. */
async function logException(e: unknown): Promise<void> {
    try {
        await ExecutionMode.global(() => Transaction.forceNew(() => ExceptionLogic.logException(e)));
    } catch {
        // Never let logging mask the original error.
    }
}
