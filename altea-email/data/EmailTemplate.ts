import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, primaryKey, implementedBy, uniqueIndex, backReference, rowOrder, valueField,
    stringLengthValidator, fieldValidation, quoted,
} from "@altea/altea/data/decorators";
import { noRepeatValidator, countIsValidator, ComparisonType, ValidationMessage } from "@altea/altea/data/validators";
import { type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { CultureInfoEntity, cultureNameOf } from "@altea/altea/data/cultureInfoEntity";
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
//
// altea divergence: a "SharedPart", not a plain "Part": BOTH an EmailTemplate and an EmailMasterTemplate can
// hold image attachments, and an altea Part may have exactly ONE owner (its auth rules are inherited from that
// owner — see altea-auth's PartOwnership). A SharedPart appears in the Type-Auth grid in its own right and
// gets its rules defined explicitly, which is the correct reading for a type two owners share.
@reflect
@entity("SharedPart", "Master")
export class ImageAttachmentEntity extends Entity implements IAttachmentGeneratorEntity {
    /** The name the attachment carries. It is itself a TEMPLATE (`Invoice @[Id].pdf`), parsed at send time. */
    @stringLengthValidator({ min: 3, max: 100 })
    fileName: string | null;

    @stringLengthValidator({ min: 1, max: 300 })
    contentId: string;

    type: EmailAttachmentTypeEnum;

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
    fileName: string | null;

    @stringLengthValidator({ min: 1, max: 300 })
    contentId: string | null;

    type: EmailAttachmentTypeEnum;

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
    @rowOrder order: int;

    /** Signum's `CultureInfoEntity CultureInfo` — the culture this message is written in. */
    culture: Lite<CultureInfoEntity>;

    @fieldValidation<EmailMasterTemplateEntity_Message>(m => masterTemplateContentRegex.test(m.text ?? "") ? null
        : EmailTemplateMessage.TheTextMustContain0IndicatingReplacementPoint.niceToString("@[content]"))
    text: string;

    toString(): string {
        return this.culture?.toString() ?? "";
    }

    clone(): EmailMasterTemplateEntity_Message {
        return EmailMasterTemplateEntity_Message.create({ culture: this.culture, text: this.text });
    }
}

// Signum's `MList<IAttachmentGeneratorEntity> Attachments`, as this owner's @part row. altea has no MList,
// and a collection of a POLYMORPHIC (interface-typed) reference cannot be a bare array: it becomes a @part
// ROW whose `@valueField` holds the reference — the shape @altea/altea-user-queries'
// UserQueryEntity_CustomDrilldown established. `@noRepeatValidator` on the owner's field compares through
// that valueField, so two rows pointing at the same attachment ARE caught.
@entity("Part", "Master")
export class EmailMasterTemplateEntity_Attachment extends Entity {
    @backReference masterTemplate: Lite<EmailMasterTemplateEntity>;
    @rowOrder order: int;

    @valueField @implementedBy(() => [ImageAttachmentEntity])
    attachment: IAttachmentGeneratorEntity;

    toString(): string {
        return this.attachment?.toString() ?? "";
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

    isDefault: boolean;

    @countIsValidator(ComparisonType.GreaterThan, 0)
    @fieldValidation<EmailMasterTemplateEntity>(t => hasDuplicateCulture(t.messages)
        ? EmailTemplateMessage.TheresMoreThanOneMessageForTheSameLanguage.niceToString() : null)
    messages: EmailMasterTemplateEntity_Message[];

    @noRepeatValidator()
    attachments: EmailMasterTemplateEntity_Attachment[];

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
    @rowOrder order: int;

    addressSource: EmailAddressSourceEnum;

    @fieldValidation<EmailTemplateAddressBaseEntity>(a =>
        (a.addressSource === EmailAddressSourceEnum.HardcodedAddress) === (a.emailAddress != null) ? null
            : ValidationMessage._0IsNotSet.niceToString("{0}"))
    emailAddress: string | null;

    displayName: string | null;

    @fieldValidation<EmailTemplateAddressBaseEntity>(a =>
        (a.addressSource === EmailAddressSourceEnum.QueryToken) === (a.token != null) ? null
            : ValidationMessage._0IsNotSet.niceToString("{0}"))
    token: QueryTokenEmbedded | null;

    toString(): string {
        return `${this.displayName ?? ""} <${this.emailAddress ?? this.token?.tokenString ?? ""}>`;
    }
}

// Signum's EmailTemplateFromEmbedded, as this owner's @part row.
@entity("Part", "Master")
export class EmailTemplateEntity_From extends EmailTemplateAddressBaseEntity {
    @backReference emailTemplate: Lite<EmailTemplateEntity>;

    whenNone: WhenNoneFromBehaviourEnum;
    whenMany: WhenManyFromBehaviourEnum;

    azureUserId: string | null;

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

    kind: EmailRecipientKindEnum;

    whenNone: WhenNoneRecipientsBehaviourEnum;
    whenMany: WhenManyRecipientsBehaviourEnum;

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

// Signum's `MList<IAttachmentGeneratorEntity> Attachments`, as this owner's @part row (see
// EmailMasterTemplateEntity_Attachment for why a polymorphic collection needs a row).
@entity("Part", "Master")
export class EmailTemplateEntity_Attachment extends Entity {
    @backReference emailTemplate: Lite<EmailTemplateEntity>;
    @rowOrder order: int;

    @valueField @implementedBy(() => [ImageAttachmentEntity, FileTokenAttachmentEntity])
    attachment: IAttachmentGeneratorEntity;

    toString(): string {
        return this.attachment?.toString() ?? "";
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
    @rowOrder order: int;

    token: QueryTokenEmbedded;
    orderType: OrderTypeEnum;
}

// Signum's EmailTemplateMessageEmbedded — the subject + body for ONE culture.
@entity("Part", "Master")
export class EmailTemplateEntity_Message extends Entity {
    @backReference emailTemplate: Lite<EmailTemplateEntity>;
    @rowOrder order: int;

    /** Signum's `CultureInfoEntity CultureInfo` — the culture this message is written in. */
    culture: Lite<CultureInfoEntity>;

    /** The body, as template text. Unbounded (Signum's `[DbType(Size = int.MaxValue)]`). */
    @stringLengthValidator({ multiLine: true })
    text: string;

    @stringLengthValidator({ multiLine: true })
    subject: string;

    toString(): string {
        return this.culture?.toString() ?? EmailTemplateMessage.NewCulture.niceToString();
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
    disableAuthorization: boolean;

    query: QueryEntity | null;

    model: EmailModelEntity | null;

    from: EmailTemplateEntity_From | null;

    @noRepeatValidator()
    recipients: EmailTemplateEntity_Recipient[];

    groupResults: boolean;

    filters: EmailTemplateEntity_Filter[];

    @fieldValidation<EmailTemplateEntity>(t => t.orders.length > 0 && t.query == null
        ? ValidationMessage._0IsNotSet.niceToString("{0}") : null)
    orders: EmailTemplateEntity_Order[];

    @noRepeatValidator()
    attachments: EmailTemplateEntity_Attachment[];

    masterTemplate: Lite<EmailMasterTemplateEntity> | null;

    messageFormat: EmailMessageFormatEnum;

    // Signum's PropertyValidation(Messages): at least one, and no two for the same culture. The "at least
    // one" half is a count rule, so the messages line also renders as MANDATORY.
    @countIsValidator(ComparisonType.GreaterThan, 0)
    @fieldValidation<EmailTemplateEntity>(t => hasDuplicateCulture(t.messages)
        ? EmailTemplateMessage.TheresMoreThanOneMessageForTheSameLanguage.niceToString() : null)
    messages: EmailTemplateEntity_Message[];

    /** altea's stand-in for Signum's compiled `TemplateApplicableEval` (see the header): a code-registered
     *  predicate, resolved through @altea/altea-templating's TemplatingLogic. */
    applicable: TemplateApplicableSymbol | null;

    @quoted
    toString(): string {
        return this.name;
    }

    /** The message for a culture, falling back to the language part ("de-CH" → "de") — Signum's
     *  GetCultureMessage + its `ci.Parent` chain. */
    getCultureMessage(culture: string): EmailTemplateEntity_Message | undefined {
        return this.messages.find(m => cultureNameOf(m.culture) === culture)
            ?? this.messages.find(m => cultureNameOf(m.culture) === languageOf(culture));
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

function hasDuplicateCulture(messages: { culture: Lite<CultureInfoEntity> }[]): boolean {
    const seen = new Set<string>();
    for (const m of messages) {
        if (m.culture != null && seen.has(m.culture.key()))
            return true;
        if (m.culture != null)
            seen.add(m.culture.key());
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
