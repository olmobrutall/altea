import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, ModelEntity, EmbeddedEntity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import {
    entity, implementedByAll, implementedBy, uniqueIndex, backReference, rowOrder, quoted,
    stringLengthValidator, fieldValidation,
} from "@altea/altea/data/decorators";
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

// Port of Signum.SMS's SMSMessage.cs + SMSTemplate.cs + SMSPackages.cs + SMSConfigurationEntity.cs — the
// module's whole data model: a MESSAGE (one row per SMS sent), a TEMPLATE (per-culture text authored against
// a query and/or a code-declared model), and the two PACKAGES a batch send / status-update process walks.
//
// altea divergences (mostly inherited from @altea/altea-email, the module this one is structurally a small
// sibling of — the same template + model-registry + message shape):
//  - **`MList<SMSTemplateMessageEmbedded>` → `@part` rows.** A collection is child rows here, so the type is
//    an Entity with a `@backReference` and a `@rowOrder`, keeping Signum's name.
//  - **a message's culture is a `Lite<CultureInfoEntity>`**, matching altea-email's template messages —
//    altea DOES have a CultureInfoEntity table (see CLAUDE.md), so the reference is a real FK rather than
//    Signum's owned CultureInfoEntity reference.
//  - **`MultipleTelephoneValidator` has no altea counterpart** (core has `telephoneValidator`, single-number
//    only), so the comma-separated form is checked by a `@fieldValidation` here — the same rule, spelled out.
//  - **`DateTimePrecisionValidator(Seconds)` has no counterpart either**; `sendDate` is truncated to seconds
//    where it is ASSIGNED (`SMSLogic.sendOneMessage`), which is what Signum's validator enforces after the
//    fact.
//  - **`SMSOwnerData` is an INTERFACE, not an entity**: Signum makes it a `DescriptionOptions` POCO that a
//    query column can project. altea projects a plain object out of a `@quoted` expression, so it needs no
//    reflected type — and no `Equals`/`GetHashCode`, since the de-duplication is `distinctBy(owner key)`.
//  - **`SMSConfigurationEmbedded` keeps Signum's shape** (just the default culture, as a LOCALE STRING —
//    see its own note) and is read through the
//    app's `() => GlobalsLogic.configuration().sms` lambda, exactly as Signum's `Configuration.Value.Sms`.

// ---- the configuration -------------------------------------------------------------------------------

/**
 * Signum's `SMSConfigurationEmbedded` — embedded on the app's ApplicationConfiguration row, and read by
 * every `SMSLogic` call through the `() => GlobalsLogic.configuration().sms` lambda the app passes to
 * `start` (see CLAUDE.md).
 *
 * ALTEA: `defaultCulture` is a plain LOCALE STRING, not Signum's `CultureInfoEntity` reference — the same
 * call @altea/altea-email's `EmailConfigurationEmbedded` makes, so the two modules' configurations read
 * alike. (A template MESSAGE still references the real CultureInfoEntity row: that is a user-picked culture,
 * where this is a deployment setting.)
 */
@reflect
export class SMSConfigurationEmbedded extends EmbeddedEntity {

    /** The culture a template must have a message for, and the one a message falls back to. */
    @stringLengthValidator({ min: 2, max: 20 })
    defaultCulture: string;

    toString(): string {
        return this.defaultCulture ?? "";
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

    /** Truncated to seconds where it is assigned — Signum's `DateTimePrecisionValidator`. */
    sendDate: Temporal.PlainDateTime | null = null;

    state: SMSMessageState = SMSMessageState.Created;

    /**
     * One number, or several comma-separated (`SMSLogic.sendSMS` fans those out into one message each).
     * Signum's `MultipleTelephoneValidator`, which altea has no decorator for.
     */
    @fieldValidation<SMSMessageEntity>(m => isMultipleTelephone(m.destinationNumber)
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
     * Signum resets `UpdatePackageProcessed` in this property's SETTER. altea entities are plain fields, so
     * the reset lives with the only writer — `SMSProcessLogic.updateMessages` / `updateAllSentSMS`.
     */
    updatePackage: Lite<SMSUpdatePackageEntity> | null = null;

    updatePackageProcessed: boolean = false;

    /** Whom this SMS is ABOUT (Signum's `Lite<ISMSOwnerEntity>` — see ISMSOwnerEntity below). */
    @implementedByAll
    referred: Lite<Entity> | null = null;

    exception: Lite<ExceptionEntity> | null = null;

    toString(): string {
        return "SMS " + (this.messageID ?? "");
    }
}

/** A number, or a comma-separated list of them (Signum's MultipleTelephoneValidator). */
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

/** Signum's `MultipleSMSModel` — the text a "send to all of these" contextual operation asks for. */
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
 * Signum's abstract `SMSPackageEntity`. Its `Name` default is `GetType().NiceName() + ": " + Clock.Now`,
 * which a constructor sets in Signum; here each concrete subclass's `create` fills it (an altea field
 * initializer cannot see the runtime type).
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

    /** Signum's `DisableAuthorization` — parse and run this template's query in global mode. */
    disableAuthorization: boolean = false;

    query: QueryEntity | null = null;

    model: SMSModelEntity | null = null;

    /**
     * One per culture. Signum validates on the collection: at least one message, at most one per culture,
     * and one for the configured default culture (that last one is a STATIC validator in SMSLogic.start,
     * because it depends on the configuration — see server/SMSLogic).
     */
    @fieldValidation<SMSTemplateEntity>(t => t.messages == null || t.messages.length === 0
        ? SMSTemplateMessage.ThereAreNoMessagesForTheTemplate.niceToString()
        : hasDuplicateCulture(t.messages)
            ? SMSTemplateMessage.TheresMoreThanOneMessageForTheSameLanguage.niceToString()
            : null)
    messages: SMSTemplateEntity_Message[];

    @stringLengthValidator({ max: 200 })
    from: string | null = null;

    /**
     * The query token that projects an {@link SMSOwnerData} — who to send to, and in which culture. Required
     * once the template has a query or a model (Signum's PropertyValidation).
     */
    @fieldValidation<SMSTemplateEntity>(t => t.to == null && (t.query != null || t.model != null)
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
        const key = String(m.culture?.id ?? "");
        if (seen.has(key))
            return true;
        seen.add(key);
    }
    return false;
}

/** Signum's `SMSTemplateMessageEmbedded` — the text for ONE culture. A collection row, hence an entity. */
@reflect
@entity("Part", "Master")
export class SMSTemplateEntity_Message extends Entity {

    @backReference template: Lite<SMSTemplateEntity>;

    @rowOrder order: int;

    /** A real FK, as in @altea/altea-email's template messages (altea HAS a CultureInfoEntity table). */
    culture: Lite<CultureInfoEntity>;

    @stringLengthValidator({ multiLine: true })
    message: string;

    toString(): string {
        return this.culture?.toString() ?? SMSTemplateMessage.NewCulture.niceToString();
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
 * Signum's `SMSModelEntity` — one row per code-declared SMS model, so a template can point at one by FK.
 * Signum marks it `[TicksColumn(false)]`; altea has no such option (and the row is never concurrently
 * edited — it is written only by the synchronizer), so the concurrency column simply stays.
 * `fullClassName` holds altea's CLEAN TYPE NAME (the stable wire identity), the same call
 * @altea/altea-email's EmailModelEntity makes; the column name is Signum's.
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
 * Signum's `ISMSOwnerEntity` — the marker an entity implements to say "an SMS can be about me", which is
 * what earns it the `SMSMessages` sub-token and the "SMS messages" quick link.
 *
 * ALTEA: a bare marker interface, and the SET of implementors is a REGISTRY
 * (`SMSLogic.registerSMSOwner`) rather than a reflection scan. Signum enumerates
 * `TypeLogic.TypeToEntity.Where(t => typeof(ISMSOwnerEntity).IsAssignableFrom(t))`; TypeScript interfaces
 * are erased, so there is nothing to scan — and the registry is what the expression registration needs
 * anyway (it is per concrete type here, as altea-alert's is).
 */
export interface ISMSOwnerEntity extends Entity {
    /** Every SMS whose `referred` is this entity — stamped by `SMSLogic.registerSMSOwner`. */
    smsMessages?(): IQuery<SMSMessageEntity>;
}

/**
 * Signum's `SMSOwnerData` — what a template's `to` token must project: whom to send to, at which number,
 * in which culture. A plain shape here (see the header): a `@quoted` expression can build it, and nothing
 * persists it.
 */
export interface SMSOwnerData {
    owner: Lite<Entity> | null;
    telephoneNumber: string;
    culture: Lite<CultureInfoEntity> | null;
}
