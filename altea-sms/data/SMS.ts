import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity, ModelEntity, EmbeddedEntity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import {
    entity, part, implementedByAll, implementedBy, uniqueIndex, backReference, rowOrder, quoted,
} from "@altea/altea/data/decorators";
import { stringLengthValidator, validate } from "@altea/altea/data/validators";
import { msg } from "@altea/altea/data/utils/localization";
import { Temporal, type int } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { ExceptionEntity } from "@altea/altea/data/exception";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import type { ExecuteSymbol, ConstructSymbol, From, FromMany } from "@altea/altea/data/operations";
import { ProcessAlgorithmSymbol, type ProcessEntity } from "@altea/altea-processes/data/Processes";
import { SimpleTaskSymbol } from "@altea/altea-scheduler/data/Scheduler";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import type { IQuery } from "@altea/altea/data/iquery";
import { SMS_MAX_TEXT_LENGTH, SMSCharactersMessage } from "./SMSCharacters";

// The module's whole data model: a MESSAGE (one row per SMS sent), a TEMPLATE (per-culture text authored
// against a query and/or a code-declared model), and the two PACKAGES a batch send / status-update process
// walks. Structurally a small sibling of @altea/altea-email, and most of its shape is inherited from there.
//
// **`SMSOwnerData` is an INTERFACE, not an entity**: a `@quoted` member returning a hand-built object IS a
// real query token, so it needs no reflected type — which is what a template's `to` points at.
//
// `SMSConfigurationEmbedded` is read through the app's `() => GlobalsLogic.configuration().sms` lambda,
// as every other module's configuration is.
//
// Port of Signum.SMS's SMSMessage.cs + SMSTemplate.cs + SMSPackages.cs — see docs/port/Sms.md.

// ---- the configuration -------------------------------------------------------------------------------

/**
 * Embedded on the app's ApplicationConfiguration row, and read by
 * every `SMSLogic` call through the `() => GlobalsLogic.configuration().sms` lambda the app passes to
 * `start` (see CLAUDE.md).
 *
 * `defaultCulture` references a `CultureInfoEntity` row — the same call
 * @altea/altea-email's `EmailConfigurationEmbedded` makes, so the two modules' configurations read alike.
 */
@reflect
export class SMSConfigurationEmbedded extends EmbeddedEntity {

    /** The culture a template must have a message for, and the one a message falls back to. */
    defaultCulture: CultureInfoEntity;

    toString(): string {
        return this.defaultCulture?.toString() ?? "";
    }
}

// ---- the message -------------------------------------------------------------------------------------

export enum SMSMessageState {
    Created,
    Sent,
    SendFailed,
    Delivered,
    DeliveryFailed,
}

@reflect
@entity("Main", "Transactional")
export class SMSMessageEntity extends Entity {

    template: Lite<SMSTemplateEntity> | null = null;

    @stringLengthValidator({ multiLine: true })
    message: string;

    editableMessage: boolean = true;

    @stringLengthValidator({ max: 200 })
    from: string | null = null;

    /** Truncated to seconds where it is ASSIGNED, since there is no precision validator here. */
    sendDate: Temporal.PlainDateTime | null = null;

    state: SMSMessageState = SMSMessageState.Created;

    /**
     * One number, or several comma-separated (`SMSLogic.sendSMS` fans those out into one message each).
     * A comma-separated list of numbers: core's `telephoneValidator` is single-number only, so the rule is
     * spelled out here.
     */
    @validate<SMSMessageEntity>(m => isMultipleTelephone(m.destinationNumber)
        ? null
        : SMSMessage.NotAValidTelephoneNumberList.niceToString())
    @stringLengthValidator({ min: 9 })
    destinationNumber: string;

    /** The provider's own id for this message — what a status update is looked up by. */
    @stringLengthValidator({ max: 100 })
    messageID: string | null = null;

    certified: boolean = false;

    sendPackage: Lite<SMSSendPackageEntity> | null = null;

    /**
     * Setting this must also clear `updatePackageProcessed`. Entities are plain fields here, so that reset
     * lives with the only writer — `SMSProcessLogic.updateMessages` / `updateAllSentSMS`.
     */
    updatePackage: Lite<SMSUpdatePackageEntity> | null = null;

    updatePackageProcessed: boolean = false;

    /** Whom this SMS is ABOUT. */
    @implementedByAll
    referred: Lite<Entity> | null = null;

    exception: Lite<ExceptionEntity> | null = null;

    toString(): string {
        return "SMS " + (this.messageID ?? "");
    }
}

/** A number, or a comma-separated list of them. */
export function isMultipleTelephone(value: string | null | undefined): boolean {
    if (value == null || value === "")
        return true; // "is it set" is the NotNull validator's business, not this one's.
    return value.split(",").every(n => /^[\d+\-/() ]+$/.test(n.trim()) && n.trim() !== "");
}

export namespace SMSMessageOperation {
    export const Send: ExecuteSymbol<SMSMessageEntity> = init();
    export const UpdateStatus: ExecuteSymbol<SMSMessageEntity> = init();
    export const CreateUpdateStatusPackage: ConstructSymbol<ProcessEntity, FromMany<SMSMessageEntity>> = init();
    export const CreateSMSFromTemplate: ConstructSymbol<SMSMessageEntity, From<SMSTemplateEntity>> = init();
    export const SendMultipleSMSMessages: ConstructSymbol<ProcessEntity, FromMany<Entity>> = init();
}

export namespace SMSMessageProcess {
    export const Send: ProcessAlgorithmSymbol = init();
    export const UpdateStatus: ProcessAlgorithmSymbol = init();
}

export namespace SMSMessageTask {
    export const UpdateSMSStatus: SimpleTaskSymbol = init();
}

/** The text a "send to all of these" contextual operation asks for. */
@reflect
export class MultipleSMSModel extends ModelEntity {

    @stringLengthValidator({ max: SMS_MAX_TEXT_LENGTH, multiLine: true })
    message: string;

    @stringLengthValidator({ max: 200 })
    from: string | null = null;

    certified: boolean = false;

    toString(): string {
        return this.message ?? "";
    }
}

export const SMSMessage = {
    NotAValidTelephoneNumberList: msg("Not a valid telephone number (or comma-separated list of them)"),
    SMSMessagesMustBeSentPriorToUpdateTheStatus: msg("SMS messages must be sent prior to update the status"),
    TheTextForTheSMSMessageHasNotBeenSet: msg("The text for the SMS message has not been set"),
};

// ---- the packages ------------------------------------------------------------------------------------

/**
 * The `name` default is `<nice type name>: <now>`, filled by each concrete subclass's `create` — a field
 * initializer cannot see the runtime type.
 */
@reflect
export abstract class SMSPackageEntity extends Entity {

    @stringLengthValidator({ max: 200 })
    name: string | null = null;

    @quoted toString(): string { return this.name ?? ""; }
}

@reflect
@entity("System", "Transactional")
export class SMSSendPackageEntity extends SMSPackageEntity {
}

@reflect
@entity("System", "Transactional")
export class SMSUpdatePackageEntity extends SMSPackageEntity {
}

// ---- the template ------------------------------------------------------------------------------------

export enum MessageLengthExceeded {
    NotAllowed,
    Allowed,
    TextPruning,
}

@reflect
@entity("Main", "Master")
export class SMSTemplateEntity extends Entity {

    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    certified: boolean = false;

    editableMessage: boolean = true;

    /** Parse and run this template's query in global mode. */
    disableAuthorization: boolean = false;

    query: QueryEntity | null = null;

    model: SMSModelEntity | null = null;

    /**
     * One per culture: at least one message, at most one per culture, and one for the configured default
     * culture — that last one a STATIC validator in SMSLogic.start, since it depends on the configuration.
     */
    @validate<SMSTemplateEntity>(t => t.messages == null || t.messages.length === 0
        ? SMSTemplateMessage.ThereAreNoMessagesForTheTemplate.niceToString()
        : hasDuplicateCulture(t.messages)
            ? SMSTemplateMessage.TheresMoreThanOneMessageForTheSameLanguage.niceToString()
            : null)
    messages: SMSTemplateEntity_Message[];

    @stringLengthValidator({ max: 200 })
    from: string | null = null;

    /**
     * The query token that projects an {@link SMSOwnerData} — who to send to, and in which culture. Required
     * once the template has a query or a model.
     */
    @validate<SMSTemplateEntity>(t => t.to == null && (t.query != null || t.model != null)
        ? SMSTemplateMessage.ToMustBeSetInTheTemplate.niceToString()
        : null)
    to: QueryTokenEmbedded | null = null;

    messageLengthExceeded: MessageLengthExceeded = MessageLengthExceeded.NotAllowed;

    removeNoSMSCharacters: boolean = false;

    isActive: boolean = false;

    @quoted toString(): string { return this.name; }
}

function hasDuplicateCulture(messages: readonly SMSTemplateEntity_Message[]): boolean {
    const seen = new Set<string>();
    for (const m of messages) {
        const key = String(m.cultureInfo?.id ?? "");
        if (seen.has(key))
            return true;
        seen.add(key);
    }
    return false;
}

/** The text for ONE culture. A collection row, hence an entity. */
@reflect
@part
export class SMSTemplateEntity_Message extends Entity {

    @backReference template: Lite<SMSTemplateEntity>;

    // No `@rowOrder`: this table has no Order column — a message is found by its CULTURE, not by position.

    /** A real FK, as in @altea/altea-email's template messages. The member IS the column
     *  (`CultureInfo_ID`), which is why it is not shortened to `culture`. */
    cultureInfo: Lite<CultureInfoEntity>;

    @stringLengthValidator({ multiLine: true })
    message: string;

    toString(): string {
        return this.cultureInfo?.toString() ?? SMSTemplateMessage.NewCulture.niceToString();
    }
}

export namespace SMSTemplateOperation {
    export const CreateSMSTemplateFromModel: ConstructSymbol<SMSTemplateEntity, From<SMSModelEntity>> = init();
    export const Create: ConstructSymbol<SMSTemplateEntity> = init();
    export const Save: ExecuteSymbol<SMSTemplateEntity> = init();
}

export const SMSTemplateMessage = {
    ThereAreNoMessagesForTheTemplate: msg("There are no messages for the template"),
    ThereMustBeAMessageFor0: msg("There must be a message for {0}"),
    TheresMoreThanOneMessageForTheSameLanguage: msg("There's more than one message for the same language"),
    NewCulture: msg("New culture"),
    _0CharactersRemainingBeforeReplacements: msg("{0} characters remaining (before replacements)"),
    ToMustBeSetInTheTemplate: msg("To must be set in the template"),
};

// ---- the model registry ------------------------------------------------------------------------------

/**
 * One row per code-declared SMS model, so a template can point at one by FK. `fullClassName` holds the
 * CLEAN TYPE NAME (the stable wire identity), the same call @altea/altea-email's EmailModelEntity makes.
 *
 * **DO NOT rename this member to `className`**, even though its two siblings now use that: the column is
 * `sms.sms_model.full_class_name` in a Signum database, and renaming it would break exactly the parity the
 * other two just gained. See docs/port/Sms.md for when that changes.
 */
@reflect
@entity("SystemString", "Master")
export class SMSModelEntity extends Entity {

    @uniqueIndex
    @stringLengthValidator({ max: 200 })
    fullClassName: string;

    @quoted toString(): string { return this.fullClassName; }
}

// ---- the owner ---------------------------------------------------------------------------------------

/**
 * The marker an entity implements to say "an SMS can be about me", which is
 * what earns it the `SMSMessages` sub-token and the "SMS messages" quick link.
 *
 * A bare marker interface, and the SET of implementors is a REGISTRY (`SMSLogic.registerSMSOwner`) rather
 * than a reflection scan: TypeScript interfaces are erased, so there is nothing to scan — and the registry
 * is what the expression registration needs anyway (per concrete type, as altea-alert's is).
 */
export interface ISMSOwnerEntity extends Entity {
    /** Every SMS whose `referred` is this entity — stamped by `SMSLogic.registerSMSOwner`. */
    smsMessages?(): IQuery<SMSMessageEntity>;
}

/**
 * What a template's `to` token must project: whom to send to, at which number,
 * in which culture. A plain shape here (see the header): a `@quoted` expression can build it, and nothing
 * persists it.
 */
export interface SMSOwnerData {
    owner: Lite<Entity> | null;
    telephoneNumber: string;
    culture: Lite<CultureInfoEntity> | null;
}

setDefaultDatabaseSchema("sms");
