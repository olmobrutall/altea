import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, primaryKey, implementedBy, uniqueIndex, backReference, rowOrder,
    stringLengthValidator, fieldValidation, quoted,
} from "@altea/altea/data/decorators";
import { noRepeatValidator, ValidationMessage } from "@altea/altea/data/validators";
import { type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { OrderTypeEnum } from "@altea/altea/data/dynamicQueries";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { FileEmbedded } from "@altea/altea-files/data/Files";
import { QueryTokenEmbedded, QueryFilterBaseEntity } from "@altea/altea-user-assets/data/Queries";
import type { IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { ModelConverterSymbol, TemplateApplicableSymbol, type IContainsQuery } from "@altea/altea-templating/data/Templating";
import { EmailModelEntity, EmailRecipientKindEnum } from "./Email";

// Port of Signum.Mailing's Templates/EmailTemplate.cs + EmailMasterTemplate.cs + ImageAttachmentEntity.cs +
// FileTokenAttachmenEntity.cs: the AUTHORED side of the module — what a message will look like, whom it
// goes to, and which query rows / model drive it.
//
// altea divergences, documented inline:
//  - Every MList of embeddeds (recipients / filters / orders / attachments / messages) becomes this owner's
//    `@part` ROW entity; the filter row reuses @altea/altea-user-assets' shared QueryFilterBaseEntity, so
//    the same FilterBuilderEmbedded editor drives it.
//  - `Guid Guid [UniqueIndex]` (the portable identity) → a uuid PRIMARY KEY, exactly as
//    @altea/altea-user-queries did: the `id` IS the portable identity, so IUserAssetEntity is a bare marker.
//  - `TemplateApplicableEval` (a compiled C# script) → `applicable: TemplateApplicableSymbol | null`, a
//    code-registered predicate (see @altea/altea-templating's data/Templating.ts for the rationale).
//  - `CultureInfoEntity CultureInfo` on a message row → a plain locale STRING (see Email.ts's header).
//  - `ToXml` / `FromXml` / `ParseData` / `IsApplicable` are SERVER-side in altea (System.Xml + the query
//    token resolver are server-only): they live in EmailTemplateXml.server.ts / EmailTemplateLogic.server.ts.
//  - Signum's `[Ignore] object TextParsedNode / SubjectParsedNode` (the memoised parse tree) are not fields
//    here: the renderer memoises per template row in a WeakMap instead, so the isomorphic entity stays free
//    of server types.

// ---- enums ---------------------------------------------------------------------------------------------

export enum EmailMessageFormatEnum {
    /** Plain text — no escaping, no master template markup. */
    PlainText,
    /** HTML authored as source (a code editor). */
    HtmlComplex,
    /** HTML authored in a simple rich-text editor. */
    HtmlSimple,
}

export enum EmailAddressSourceEnum {
    QueryToken,
    HardcodedAddress,
    CurrentUser,
}

export enum WhenNoneRecipientsBehaviourEnum {
    ThrowException,
    NoMessage,
    NoRecipients,
}

export enum WhenManyRecipientsBehaviourEnum {
    SplitMessages,
    KeepOneMessageWithManyRecipients,
}

export enum WhenNoneFromBehaviourEnum {
    ThrowException,
    NoMessage,
    DefaultFrom,
}

export enum WhenManyFromBehaviourEnum {
    SplitMessages,
    FistResult,
}

/** Signum's EmailTemplateVisibleOn — a FLAG set (where the "send this template" menu offers it). */
export enum EmailTemplateVisibleOn {
    Single = 1,
    Multiple = 2,
    Query = 4,
}

// ---- attachments ---------------------------------------------------------------------------------------

/** Signum's IAttachmentGeneratorEntity — one attachment RULE on a template. Implemented by
 *  ImageAttachmentEntity and FileTokenAttachmentEntity; an app may add its own and widen the
 *  `attachments` field with `overrideImplementedBy`. */
export interface IAttachmentGeneratorEntity extends Entity { }

// Signum's ImageAttachmentEntity — a fixed file stored on the template itself.
@reflect
@entity("Part", "Master")
export class ImageAttachmentEntity extends Entity implements IAttachmentGeneratorEntity {
    /** The name the attachment carries. It is itself a TEMPLATE (`Invoice @[Id].pdf`), parsed at send time. */
    @stringLengthValidator({ min: 3, max: 100 })
    fileName: string | null = null;

    @stringLengthValidator({ min: 1, max: 300 })
    contentId: string;

    type: EmailAttachmentTypeEnum = EmailAttachmentTypeEnum.Attachment;

    file: FileEmbedded;

    @quoted
    toString(): string {
        return this.fileName ?? this.file?.fileName ?? "";
    }
}

// Signum's FileTokenAttachmentEntity — attach whatever FILE the rows' token points at.
@reflect
@entity("Part", "Master")
export class FileTokenAttachmentEntity extends Entity implements IAttachmentGeneratorEntity {
    @stringLengthValidator({ min: 3, max: 100 })
    fileName: string | null = null;

    @stringLengthValidator({ min: 1, max: 300 })
    contentId: string | null = null;

    type: EmailAttachmentTypeEnum = EmailAttachmentTypeEnum.Attachment;

    fileToken: QueryTokenEmbedded;

    @quoted
    toString(): string {
        return this.fileName ?? this.fileToken?.tokenString ?? "";
    }
}

// Signum's EmailAttachmentType. Declared here (not in Email.ts) so both the template's attachment RULES
// and a message's produced attachments share it; re-exported from Email.ts's consumers via this module.
export enum EmailAttachmentTypeEnum {
    /** A real attachment the reader downloads. */
    Attachment,
    /** An inline resource an HTML body references by `cid:` (an embedded image). */
    LinkedResource,
}

// ---- EmailMasterTemplate -------------------------------------------------------------------------------

/** Signum's `MasterTemplateContentRegex` — where a master template splices the body in. Two forms: a
 *  NON-global one to test with (a global RegExp's `test` advances lastIndex, so it alternates) and a
 *  global one to replace with. */
export const masterTemplateContentRegex = /@\[content\]/;
export const masterTemplateContentRegexGlobal = /@\[content\]/g;

// Signum's EmailMasterTemplateMessageEmbedded, as this owner's @part row.
@entity("Part", "Master")
export class EmailMasterTemplateEntity_Message extends Entity {
    @backReference masterTemplate: Lite<EmailMasterTemplateEntity>;
    @rowOrder order: int = toInt(0);

    /** A locale name ("en-US"); altea has no CultureInfoEntity (see Email.ts's header). */
    @stringLengthValidator({ min: 2, max: 20 })
    culture: string;

    @fieldValidation<EmailMasterTemplateEntity_Message>(m => masterTemplateContentRegex.test(m.text ?? "") ? null
        : EmailTemplateMessage.TheTextMustContain0IndicatingReplacementPoint.niceToString("@[content]"))
    text: string;

    toString(): string {
        return this.culture ?? "";
    }

    clone(): EmailMasterTemplateEntity_Message {
        return EmailMasterTemplateEntity_Message.create({ culture: this.culture, text: this.text });
    }
}

// Signum's EmailMasterTemplateEntity — the shared chrome (header / footer / styles) a template's body is
// spliced into at `@[content]`.
@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class EmailMasterTemplateEntity extends Entity implements IUserAssetEntity {
    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    isDefault: boolean = false;

    @fieldValidation<EmailMasterTemplateEntity>(t =>
        t.messages == null || t.messages.length === 0 ? EmailTemplateMessage.ThereAreNoMessagesForTheTemplate.niceToString()
            : hasDuplicateCulture(t.messages) ? EmailTemplateMessage.TheresMoreThanOneMessageForTheSameLanguage.niceToString()
                : null)
    messages: EmailMasterTemplateEntity_Message[] = [];

    @noRepeatValidator()
    @implementedBy(() => [ImageAttachmentEntity])
    attachments: IAttachmentGeneratorEntity[] = [];

    @quoted
    toString(): string {
        return this.name;
    }
}

export namespace EmailMasterTemplateOperation {
    export const Create: ConstructSymbol<EmailMasterTemplateEntity> = init();
    export const Clone: ConstructSymbol<EmailMasterTemplateEntity, From<EmailMasterTemplateEntity>> = init();
    export const Save: ExecuteSymbol<EmailMasterTemplateEntity> = init();
    export const Delete: DeleteSymbol<EmailMasterTemplateEntity> = init();
}

// ---- EmailTemplate rows --------------------------------------------------------------------------------

/** Signum's EmailTemplateAddressEmbedded — the members a template's From / Recipient share: WHERE the
 *  address comes from (a query token, a hardcoded address, or the current user). */
@reflect
export abstract class EmailTemplateAddressBaseEntity extends Entity {
    @rowOrder order: int = toInt(0);

    addressSource: EmailAddressSourceEnum = EmailAddressSourceEnum.QueryToken;

    @fieldValidation<EmailTemplateAddressBaseEntity>(a =>
        (a.addressSource === EmailAddressSourceEnum.HardcodedAddress) === (a.emailAddress != null) ? null
            : ValidationMessage._0IsNotSet.niceToString("{0}"))
    emailAddress: string | null = null;

    displayName: string | null = null;

    @fieldValidation<EmailTemplateAddressBaseEntity>(a =>
        (a.addressSource === EmailAddressSourceEnum.QueryToken) === (a.token != null) ? null
            : ValidationMessage._0IsNotSet.niceToString("{0}"))
    token: QueryTokenEmbedded | null = null;

    toString(): string {
        return `${this.displayName ?? ""} <${this.emailAddress ?? this.token?.tokenString ?? ""}>`;
    }
}

// Signum's EmailTemplateFromEmbedded, as this owner's @part row.
@entity("Part", "Master")
export class EmailTemplateEntity_From extends EmailTemplateAddressBaseEntity {
    @backReference emailTemplate: Lite<EmailTemplateEntity>;

    whenNone: WhenNoneFromBehaviourEnum = WhenNoneFromBehaviourEnum.ThrowException;
    whenMany: WhenManyFromBehaviourEnum = WhenManyFromBehaviourEnum.SplitMessages;

    azureUserId: string | null = null;

    clone(): EmailTemplateEntity_From {
        return EmailTemplateEntity_From.create({
            addressSource: this.addressSource,
            azureUserId: this.azureUserId,
            displayName: this.displayName,
            emailAddress: this.emailAddress,
            token: this.token,
            whenMany: this.whenMany,
            whenNone: this.whenNone,
        });
    }
}

// Signum's EmailTemplateRecipientEmbedded, as this owner's @part row.
@entity("Part", "Master")
export class EmailTemplateEntity_Recipient extends EmailTemplateAddressBaseEntity {
    @backReference emailTemplate: Lite<EmailTemplateEntity>;

    kind: EmailRecipientKindEnum = EmailRecipientKindEnum.To;

    whenNone: WhenNoneRecipientsBehaviourEnum = WhenNoneRecipientsBehaviourEnum.ThrowException;
    whenMany: WhenManyRecipientsBehaviourEnum = WhenManyRecipientsBehaviourEnum.SplitMessages;

    override toString(): string {
        return `${EmailRecipientKindEnum[this.kind]} ${this.displayName ?? ""} <${this.emailAddress ?? this.token?.tokenString ?? ""}>`;
    }

    clone(): EmailTemplateEntity_Recipient {
        return EmailTemplateEntity_Recipient.create({
            addressSource: this.addressSource,
            displayName: this.displayName,
            emailAddress: this.emailAddress,
            kind: this.kind,
            token: this.token,
            whenMany: this.whenMany,
            whenNone: this.whenNone,
        });
    }
}

// Signum's `MList<QueryFilterEmbedded> Filters` — the shared filter row with this owner's back reference.
@entity("Part", "Master")
export class EmailTemplateEntity_Filter extends QueryFilterBaseEntity {
    @backReference emailTemplate: Lite<EmailTemplateEntity>;
}

// Signum's `MList<QueryOrderEmbedded> Orders`.
@entity("Part", "Master")
export class EmailTemplateEntity_Order extends Entity {
    @backReference emailTemplate: Lite<EmailTemplateEntity>;
    @rowOrder order: int = toInt(0);

    token: QueryTokenEmbedded;
    orderType: OrderTypeEnum = OrderTypeEnum.Ascending;
}

// Signum's EmailTemplateMessageEmbedded — the subject + body for ONE culture.
@entity("Part", "Master")
export class EmailTemplateEntity_Message extends Entity {
    @backReference emailTemplate: Lite<EmailTemplateEntity>;
    @rowOrder order: int = toInt(0);

    /** A locale name ("en-US"); altea has no CultureInfoEntity (see Email.ts's header). */
    @stringLengthValidator({ min: 2, max: 20 })
    culture: string;

    /** The body, as template text. Unbounded (Signum's `[DbType(Size = int.MaxValue)]`). */
    @stringLengthValidator({ multiLine: true })
    text: string = "";

    @stringLengthValidator({ multiLine: true })
    subject: string = "";

    toString(): string {
        return this.culture ?? EmailTemplateMessage.NewCulture.niceToString();
    }

    clone(): EmailTemplateEntity_Message {
        return EmailTemplateEntity_Message.create({ culture: this.culture, subject: this.subject, text: this.text });
    }
}

// ---- EmailTemplate -------------------------------------------------------------------------------------

// Signum's EmailTemplateEntity.
@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class EmailTemplateEntity extends Entity implements IUserAssetEntity, IContainsQuery {
    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    /** Whether the produced message may still be edited before it is sent. */
    editableMessage: boolean = true;

    /** Signum's DisableAuthorization — render this template with row-level/type auth OFF (a system mail
     *  must be able to read rows the triggering user cannot). */
    disableAuthorization: boolean = false;

    query: QueryEntity | null = null;

    model: EmailModelEntity | null = null;

    from: EmailTemplateEntity_From | null = null;

    @noRepeatValidator()
    recipients: EmailTemplateEntity_Recipient[] = [];

    groupResults: boolean = false;

    filters: EmailTemplateEntity_Filter[] = [];

    @fieldValidation<EmailTemplateEntity>(t => t.orders.length > 0 && t.query == null
        ? ValidationMessage._0IsNotSet.niceToString("{0}") : null)
    orders: EmailTemplateEntity_Order[] = [];

    @noRepeatValidator()
    @implementedBy(() => [ImageAttachmentEntity, FileTokenAttachmentEntity])
    attachments: IAttachmentGeneratorEntity[] = [];

    masterTemplate: Lite<EmailMasterTemplateEntity> | null = null;

    messageFormat: EmailMessageFormatEnum = EmailMessageFormatEnum.HtmlSimple;

    @fieldValidation<EmailTemplateEntity>(t =>
        t.messages == null || t.messages.length === 0 ? EmailTemplateMessage.ThereAreNoMessagesForTheTemplate.niceToString()
            : hasDuplicateCulture(t.messages) ? EmailTemplateMessage.TheresMoreThanOneMessageForTheSameLanguage.niceToString()
                : null)
    messages: EmailTemplateEntity_Message[] = [];

    /** altea's stand-in for Signum's compiled `TemplateApplicableEval` (see the header): a code-registered
     *  predicate, resolved through @altea/altea-templating's TemplatingLogic. */
    applicable: TemplateApplicableSymbol | null = null;

    @quoted
    toString(): string {
        return this.name;
    }

    /** The message for a culture, falling back to the language part ("de-CH" → "de") — Signum's
     *  GetCultureMessage + its `ci.Parent` chain. */
    getCultureMessage(culture: string): EmailTemplateEntity_Message | undefined {
        return this.messages.find(m => m.culture === culture)
            ?? this.messages.find(m => m.culture === languageOf(culture));
    }
}

export namespace EmailTemplateOperation {
    export const Create: ConstructSymbol<EmailTemplateEntity> = init();
    export const CreateEmailTemplateFromModel: ConstructSymbol<EmailTemplateEntity, From<EmailModelEntity>> = init();
    export const Clone: ConstructSymbol<EmailTemplateEntity, From<EmailTemplateEntity>> = init();
    export const Save: ExecuteSymbol<EmailTemplateEntity> = init();
    export const Delete: DeleteSymbol<EmailTemplateEntity> = init();
}

export const EmailTemplateMessage = {
    EndDateMustBeHigherThanStartDate: msg("End date must be higher than start date"),
    ThereAreNoMessagesForTheTemplate: msg("There are no messages for the template"),
    ThereMustBeAMessageFor0: msg("There must be a message for {0}"),
    TheresMoreThanOneMessageForTheSameLanguage: msg("There's more than one message for the same language"),
    TheTextMustContain0IndicatingReplacementPoint: msg("The text must contain {0} indicating replacement point"),
    NewCulture: msg("New culture"),
    TokenOrEmailAddressMustBeSet: msg("Token or email address must be set"),
    TokenAndEmailAddressCanNotBeSetAtTheSameTime: msg("Token and email address can not be set at the same time"),
    TokenMustBeA0: msg("Token must be a {0}"),
    ShowPreview: msg("Show preview"),
    HidePreview: msg("Hide preview"),
};

export const EmailTemplateViewMessage = {
    InsertMessageContent: msg("Insert message content"),
    Insert: msg("Insert"),
    Language: msg("Language"),
};

// ---- helpers -------------------------------------------------------------------------------------------

function hasDuplicateCulture(messages: { culture: string }[]): boolean {
    const seen = new Set<string>();
    for (const m of messages) {
        if (m.culture != null && seen.has(m.culture))
            return true;
        if (m.culture != null)
            seen.add(m.culture);
    }
    return false;
}

/** "de-CH" → "de" (Signum's `CultureInfo.Parent`), or undefined for an already-neutral locale. */
export function languageOf(culture: string | null | undefined): string | undefined {
    const dash = culture?.indexOf("-") ?? -1;
    return dash > 0 ? culture!.slice(0, dash) : undefined;
}

// Re-exported so the message / editor modules need only this file for the template-side model.
export { ModelConverterSymbol, TemplateApplicableSymbol, QueryTokenEmbedded };
