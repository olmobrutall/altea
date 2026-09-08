import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, implementedBy, uniqueIndex, unit, quoted, backReference } from "@altea/altea/data/decorators";
import {
    stringLengthValidator, validate, emailValidator, urlValidator, ValidationMessage,
} from "@altea/altea/data/validators";
import { type int, toInt, type uuid } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { UserEntity } from "@altea/altea-auth/data/User";
import { FileTypeSymbol } from "@altea/altea-files/data/Files";
import { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";

// Port of Signum.Mailing's shared surface: EmailMessage.cs's address / recipient value types and enums,
// EmailModel.cs, EmailConfiguration.cs, and the module's permissions / messages / file type. The
// EmailMessageEntity itself lives in EmailMessage.ts (it references a template and a sender config, so it
// sits at the bottom of this module's import DAG: Email.ts ← EmailTemplate.ts / EmailSenderConfiguration.ts
// ← EmailMessage.ts).
//
// altea divergences, documented inline:
//  - a persisted culture is a `CultureInfoEntity` row, as in Signum — the configuration's default culture
//    and a template's per-culture message rows both reference one. `EmailOwnerData` is the exception, and
//    only because it is not persisted at all: it stays a plain runtime SHAPE (see the next bullet), so its
//    `culture` is the locale STRING the renderer wants rather than a row nobody stores.
//  - `EmailOwnerData` stays a plain runtime SHAPE (not an entity): Signum made it an
//    `[AutoExpressionField]` queryable object so ONE token (`@[Customer]`) yielded email + display name +
//    culture at once. altea has no object-returning @quoted member, so a From / Recipient token yields
//    either a `Lite<IEmailOwnerEntity>` (resolved through the per-type registry — see
//    EmailLogic.registerEmailOwner) or a plain email STRING. Same templates, one extra registration.
//  - `IEmailOwnerEntity` is a TS interface over the `Entity` CLASS (altea has no IEntity), and the
//    `emailOwner` FK is `@implementedBy([UserEntity])` — the app widens it with
//    `overrideImplementedBy` for its own owner types (the channel ScheduledTaskEntity.task uses).
//  - MLists of embeddeds become per-owner `@part` ROWS. Recipients appear on two owners (a message and a
//    sender configuration), so their members live on the shared abstract `EmailRecipientBaseEntity` and
//    each owner subclasses it adding only its `@backReference` (the shape @altea/altea-user-assets'
//    QueryFilterBaseEntity established).

/** Signum's IEmailOwnerEntity (Signum/Basics/EmailOwnerData.cs) — an entity that can be mailed. */
export interface IEmailOwnerEntity extends Entity { }

/** Signum's EmailOwnerData — everything a From / Recipient needs about one addressee. A plain shape (see
 *  the header): the server fills it from a Lite through EmailLogic's registry, or from a raw address. */
export interface EmailOwnerData {
    owner: Lite<IEmailOwnerEntity> | null;
    email: string | null;
    displayName: string | null;
    /** A locale name ("en-US"); this shape is not persisted, so it holds no row (see the header). */
    culture: string | null;
    externalId: string | null;
}

// ---- Addresses -----------------------------------------------------------------------------------------

// Signum's EmailAddressEmbedded — the members every address (From / Recipient) carries.
@reflect
export abstract class EmailAddressEmbedded extends EmbeddedEntity {
    @implementedBy(() => [UserEntity])
    emailOwner: Lite<IEmailOwnerEntity> | null;

    // Signum's [StringLengthValidator(3, 100)] + an EMailValidator applied in PropertyValidation only when
    // `invalidEmail` is false (a received message may legitimately carry a malformed address).
    @validate<EmailAddressEmbedded>(a => a.invalidEmail || a.emailAddress == null || emailRegex.test(a.emailAddress) ? null
        : ValidationMessage._0DoesNotHaveAValid1Format.niceToString("{0}", "e-Mail"))
    @stringLengthValidator({ min: 3, max: 100 })
    emailAddress: string;

    /** Signum's InvalidEmail — set on a received message whose address does not parse, so validation
     *  does not block storing it. */
    invalidEmail: boolean;

    displayName: string | null;

    toString(): string {
        return `${this.displayName ?? ""} <${this.emailAddress}>`;
    }
}

// Signum's EmailFromEmbedded — the sender of one message.
@reflect
export class EmailFromEmbedded extends EmailAddressEmbedded {
    /** Signum's `Guid? AzureUserId` — the DIRECTORY OBJECT ID of the sending mailbox, which is what
     *  @altea/altea-mailing-microsoft-graph addresses `POST /users/{id}/sendMail` with. Filled from the
     *  email owner's `externalId` (see fromOwnerData / EmailLogic.registerEmailOwner). A `uuid`, so the
     *  column is one too rather than free text. */
    azureUserId: uuid | null;

    clone(): EmailFromEmbedded {
        return EmailFromEmbedded.create({
            displayName: this.displayName,
            emailAddress: this.emailAddress,
            emailOwner: this.emailOwner,
            azureUserId: this.azureUserId,
        });
    }

    static fromOwnerData(data: EmailOwnerData): EmailFromEmbedded {
        return EmailFromEmbedded.create({
            emailOwner: data.owner,
            emailAddress: data.email ?? "",
            displayName: data.displayName,
            // Signum's `data.ExternalId?.ToGuid()` — EmailOwnerData carries the directory id as text.
            azureUserId: data.externalId as uuid | null,
        });
    }
}

// Signum's EmailRecipientKind.
export enum EmailRecipientKind {
    To,
    Cc,
    Bcc,
}
export type EmailRecipientKindKeys = keyof typeof EmailRecipientKind;

/** Signum's EmailRecipientEmbedded. ABSTRACT here (`@reflect`, no `@entity`) so it has no table of its
 *  own: each owner subclasses it and adds only its `@backReference` — a `@part` row belongs to exactly
 *  ONE owner in altea. */
@reflect
export abstract class EmailRecipientBaseEntity extends Entity {
    // No `@rowOrder`: Signum marks NEITHER of this embedded's two MLists [PreserveOrder]
    // (`EmailMessageEntity.Recipients`, `EmailSenderConfigurationEntity.AdditionalRecipients`), so
    // neither table has an Order column. Recipients are grouped by their `kind` (To / Cc / Bcc), not
    // by list position.

    @implementedBy(() => [UserEntity])
    emailOwner: Lite<IEmailOwnerEntity> | null;

    @validate<EmailRecipientBaseEntity>(a => a.invalidEmail || a.emailAddress == null || emailRegex.test(a.emailAddress) ? null
        : ValidationMessage._0DoesNotHaveAValid1Format.niceToString("{0}", "e-Mail"))
    @stringLengthValidator({ min: 3, max: 100 })
    emailAddress: string;

    invalidEmail: boolean;

    displayName: string | null;

    kind: EmailRecipientKind;

    /** Signum's `EmailRecipientEmbedded.BaseToString()` — the address without the Kind prefix. */
    baseToString(): string {
        return `${this.displayName ?? ""} <${this.emailAddress}>`;
    }

    toString(): string {
        return `${EmailRecipientKind[this.kind]}: ${this.baseToString()}`;
    }
}

// ---- EmailModel ----------------------------------------------------------------------------------------

// Signum's EmailModelEntity — the registry row for one code-declared email MODEL (an "EmailModel<T>": the
// in-memory object a template renders against, instead of / alongside a query row).
@reflect
@entity("SystemString", "Master")
export class EmailModelEntity extends Entity {
    // Signum declares no `[StringLengthValidator]` here and gets `varchar(200)` from its own default —
    // which is what a Southwind database has, so the length is written out rather than inherited from
    // altea's (a 400 altea had invented scripted an ALTER of a column nothing asked to widen). Its two
    // siblings, OfficeModelEntity and SMSModelEntity, say `Max = 200` explicitly in Signum.
    @uniqueIndex
    @stringLengthValidator({ max: 200 })
    className: string;

    @quoted
    toString(): string {
        return this.className;
    }
}

// ---- Configuration -------------------------------------------------------------------------------------

// Signum's EmailConfigurationEmbedded — the app's mail settings (Southwind embeds it in its
// ApplicationConfiguration; eastwind supplies it through EmailLogic.start's getConfiguration).
@reflect
export class EmailConfigurationEmbedded extends EmbeddedEntity {
    /** The culture a message falls back to when neither the recipient nor the template names one.
     *  Signum's `CultureInfoEntity DefaultCulture`. */
    defaultCulture: CultureInfoEntity;

    /** Signum's UrlLeft — the absolute app root a template's links are built on (`@[g:UrlLeft]`). */
    @validate<EmailConfigurationEmbedded>(c => c.urlLeft?.endsWith("/") ? "{0} should not have a final /" : null)
    @urlValidator()
    urlLeft: string;

    /** The master switch: false ⇒ a "sent" message is recorded but nothing leaves the process. */
    sendEmails: boolean;

    reciveEmails: boolean;

    /** Signum's OverrideEmailAddress — a test-environment catch-all that replaces every recipient. */
    @emailValidator()
    @stringLengthValidator({ min: 3, max: 100 })
    overrideEmailAddress: string | null;

    @unit("hrs")
    avoidSendingEmailsOlderThan: number | null;

    chunkSizeSendingEmails: int = toInt(100);

    maxEmailSendRetries: int = toInt(3);

    @unit("sec")
    asyncSenderPeriod: int = toInt(5 * 60);
}

// ---- File type / permissions / messages ----------------------------------------------------------------

// Signum's `[AutoInit] static class EmailFileType`.
export namespace EmailFileType {
    /** The store an email ATTACHMENT is written to. The app registers its folder algorithm and passes it
     *  to EmailLogic.start. */
    export const Attachment: FileTypeSymbol = init();
}

// Signum's `[AutoInit] static class AsyncEmailSenderPermission`.
export namespace AsyncEmailSenderPermission {
    export const ViewAsyncEmailSenderPanel: PermissionSymbol = init();
}

export const EmailMessageMessage = {
    TheEmailMessageCannotBeSentFromState0: msg("The email message cannot be sent from state {0}"),
    Message: msg(),
    Messages: msg(),
    RemainingMessages: msg("Remaining messages"),
    ExceptionMessages: msg("Exception messages"),
    _01requiresExtraParameters: msg("{0} {1} requires extra parameters"),
    DefaultFromNotFound: msg("No Default From found"),
    NoSuitableRecipientsWereFound: msg("No suitable recipients were found"),
};

/** Signum's EMailValidatorAttribute.EmailRegex. */
export const emailRegex = /^[\w-+]+(\.[\w-+]+)*@[A-Za-z0-9]([\w-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([\w-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/** A recipient paired with the Kind it should be added as (Signum's EmailOwnerRecipientData). */
export interface EmailOwnerRecipientData {
    ownerData: EmailOwnerData;
    kind: EmailRecipientKind;
}

// Re-exported so consumers of this module do not have to reach into altea-files.
export { FileTypeSymbol };
