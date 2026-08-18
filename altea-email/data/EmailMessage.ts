import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, implementedByAll, backReference, rowOrder, format,
    stringLengthValidator, fieldValidation, quoted,
} from "@altea/altea/data/decorators";
import { noRepeatValidator, countIsValidator, ComparisonType } from "@altea/altea/data/validators";
import { Temporal, type int, toInt, type uuid } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { ExceptionEntity } from "@altea/altea/data/exception";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { FilePathEmbedded } from "@altea/altea-files/data/Files";
import { EmailRecipientBaseEntity, EmailFromEmbedded, EmailMessageMessage } from "./Email";
import { EmailAttachmentTypeEnum, EmailTemplateEntity } from "./EmailTemplate";
import { EmailSenderConfigurationEntity } from "./EmailSenderConfiguration";

// Port of Signum.Mailing's EmailMessage.cs — the PRODUCED message: what was rendered, to whom, in which
// state, and (once sent) by which sender configuration.
//
// altea divergences, documented inline:
//  - `MList<EmailRecipientEmbedded> Recipients` / `MList<EmailAttachmentEmbedded> Attachments` become this
//    owner's `@part` ROWS (the recipient row reuses the shared EmailRecipientBaseEntity — see Email.ts).
//  - `StateValidator` (Signum's table of which fields may be set in which state) becomes per-field
//    `@fieldValidation` checks against `state` — the same rules, expressed one field at a time.
//  - `CalculateHash` uses SHA-1 in Signum; the hash is only a de-duplication key, and the isomorphic layer
//    has no crypto, so the SERVER fills `bodyHash` on save (EmailLogic's PreSaving hook) and this entity
//    only exposes the string that gets hashed.
//  - `ProcessIdentifier` stays (the async sender claims a batch with it), `UniqueIdentifier` too.

// Signum's EmailMessageState.
export enum EmailMessageStateEnum {
    /** Freshly constructed, never saved. */
    Created,
    Draft,
    ReadyToSend,
    /** Claimed by one async-sender pass (its processIdentifier is set). */
    RecruitedForSending,
    Sent,
    SentException,
    ReceptionNotified,
    Received,
    /** Too old to be worth sending (EmailConfiguration.avoidSendingEmailsOlderThan). */
    Outdated,
}

// Signum's `MList<EmailRecipientEmbedded> Recipients`, as this owner's @part row (see Email.ts).
@entity("Part", "Transactional")
export class EmailMessageEntity_Recipient extends EmailRecipientBaseEntity {
    @backReference emailMessage: Lite<EmailMessageEntity>;
}

// Signum's EmailAttachmentEmbedded, as this owner's @part row.
@entity("Part", "Transactional")
export class EmailMessageEntity_Attachment extends Entity {
    @backReference emailMessage: Lite<EmailMessageEntity>;
    @rowOrder order: int = toInt(0);

    type: EmailAttachmentTypeEnum = EmailAttachmentTypeEnum.Attachment;

    /** The file itself, in the EmailFileType.Attachment store. */
    file: FilePathEmbedded;

    /** The `cid:` a LinkedResource is referenced by from the HTML body. */
    @stringLengthValidator({ min: 1, max: 300 })
    contentId: string;

    /** Signum's Similar — two attachments are "the same one" if the content id or the file name matches. */
    similar(other: EmailMessageEntity_Attachment): boolean {
        return this.contentId === other.contentId || this.file?.fileName === other.file?.fileName;
    }

    toString(): string {
        return this.file?.toString() ?? "";
    }
}

// Signum's EmailMessageEntity.
@reflect
@entity("Main", "Transactional")
export class EmailMessageEntity extends Entity {
    /** Signum's [CountIsValidator(ComparisonType.GreaterThan, 0)] — a message with no recipients cannot be
     *  sent. GreaterThan 0 also makes the recipients line MANDATORY in the editor. */
    @countIsValidator(ComparisonType.GreaterThan, 0)
    recipients: EmailMessageEntity_Recipient[] = [];

    /** The entity this message is ABOUT (the quick-link "emails of this order" reads it). */
    @implementedByAll
    target: Lite<Entity> | null = null;

    from: EmailFromEmbedded;

    template: Lite<EmailTemplateEntity> | null = null;

    @format("G")
    creationDate: Temporal.PlainDateTime = Clock.now;

    @format("G")
    sent: Temporal.PlainDateTime | null = null;

    sentBy: Lite<EmailSenderConfigurationEntity> | null = null;

    @format("G")
    receptionNotified: Temporal.PlainDateTime | null = null;

    /** Unbounded (Signum's `[DbType(Size = int.MaxValue)]`), and allowed to keep leading/trailing spaces. */
    @stringLengthValidator({ multiLine: true })
    subject: string | null = null;

    /** The rendered body. A BigStringEmbedded: one unbounded nullable text column behind an embedded. */
    body: BigStringEmbedded = new BigStringEmbedded();

    /** A de-duplication key over subject + body, filled server-side on save (see the header). */
    @stringLengthValidator({ min: 1, max: 150 })
    bodyHash: string | null = null;

    isBodyHtml: boolean = false;

    /** Set when a send attempt threw; goes with state SentException. */
    @fieldValidation<EmailMessageEntity>(m =>
        m.exception != null && m.state !== EmailMessageStateEnum.SentException && m.state !== EmailMessageStateEnum.ReceptionNotified
            ? "{0} should be empty" : null)
    exception: Lite<ExceptionEntity> | null = null;

    @fieldValidation<EmailMessageEntity>(m => stateAllowsSent(m.state) || m.sent == null ? null : "{0} should be empty")
    state: EmailMessageStateEnum = EmailMessageStateEnum.Created;

    /** Signum's UniqueIdentifier — a stable id the reception side matches a reply against. */
    uniqueIdentifier: uuid | null = null;

    editableMessage: boolean = true;

    /** Which async-sender pass claimed this message (see AsyncEmailSender.recruitQueuedItems). */
    processIdentifier: uuid | null = null;

    sendRetries: int = toInt(0);

    @noRepeatValidator()
    attachments: EmailMessageEntity_Attachment[] = [];

    /** What `bodyHash` is computed over (Signum's CalculateHash input). */
    hashSource(): string {
        return `${this.subject ?? ""}${this.body?.text ?? ""}`.replace(/^[\r\n ]+|[\r\n ]+$/g, "");
    }

    @quoted
    toString(): string {
        return this.subject!;
    }
}

function stateAllowsSent(state: EmailMessageStateEnum): boolean {
    return state === EmailMessageStateEnum.Sent
        || state === EmailMessageStateEnum.SentException
        || state === EmailMessageStateEnum.ReceptionNotified;
}

export namespace EmailMessageOperation {
    export const Save: ExecuteSymbol<EmailMessageEntity> = init();
    export const ReadyToSend: ExecuteSymbol<EmailMessageEntity> = init();
    export const Send: ExecuteSymbol<EmailMessageEntity> = init();
    export const ReSend: ConstructSymbol<EmailMessageEntity, From<EmailMessageEntity>> = init();
    export const CreateMail: ConstructSymbol<EmailMessageEntity> = init();
    export const CreateEmailFromTemplate: ConstructSymbol<EmailMessageEntity, From<EmailTemplateEntity>> = init();
    export const Delete: DeleteSymbol<EmailMessageEntity> = init();
}

export const EmailMessageViewMessage = {
    Body: msg(),
    Preview: msg(),
};

// Re-exported so a consumer needs only this module for the message side of the model.
export { EmailFromEmbedded, EmailMessageMessage } from "./Email";
