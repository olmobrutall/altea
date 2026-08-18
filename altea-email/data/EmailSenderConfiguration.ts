import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, implementedBy, uniqueIndex, backReference, rowOrder, format,
    stringLengthValidator, fieldValidation, quoted, column,
} from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { EmailFromEmbedded, EmailRecipientBaseEntity } from "./Email";

// Port of Signum.Mailing's EmailSenderConfiguration.cs — the named "how do we send" configuration: a
// default From, extra recipients every message gets, and the SERVICE that does the sending.
//
// altea divergences, documented inline:
//  - Signum's `SmtpDeliveryFormat` / `SmtpDeliveryMethod` are .NET framework enums registered as
//    "external enums"; altea declares its own (same members) since there is no System.Net.Mail to borrow
//    from. `SevenBit`/`International` and `Network`/`SpecifiedPickupDirectory`/`PickupDirectoryFromIis`
//    keep Signum's names so a stored value round-trips.
//  - Only the SMTP service is ported (Signum also ships Exchange WS / Microsoft Graph / POP3 senders in
//    their own packages). `EmailServiceEntity` stays abstract + `@implementedBy([SmtpEmailServiceEntity])`
//    so an app can widen it with `overrideImplementedBy`.
//  - `AdditionalRecipients` (an MList of the shared recipient embedded) becomes this owner's `@part` row.
//  - `ClientCertificationFiles` likewise.

export enum SmtpDeliveryFormatEnum {
    SevenBit,
    International,
}

export enum SmtpDeliveryMethodEnum {
    Network,
    SpecifiedPickupDirectory,
    PickupDirectoryFromIis,
}

// Signum's EmailServiceEntity — the abstract "sending mechanism" a configuration points at.
@reflect
@entity("Part", "Master")
export abstract class EmailServiceEntity extends Entity {
    abstract clone(): EmailServiceEntity;

    /** Signum's ValidateFrom — a service may require (or forbid) a particular From identity. */
    validateFrom(_from: EmailFromEmbedded): string | null { return null; }
}

// Signum's ClientCertificationFileEmbedded, as this owner's @part row.
@entity("Part", "Master")
export class SmtpNetworkDeliveryEmbedded_ClientCertificationFile extends Entity {
    @backReference network: Lite<SmtpNetworkDeliveryEmbedded>;
    @rowOrder order: int;

    @stringLengthValidator({ min: 2, max: 300 })
    fullFilePath: string;

    @quoted
    toString(): string {
        return this.fullFilePath;
    }
}

// Signum's SmtpNetworkDeliveryEmbedded — host/port/credentials for a real SMTP connection.
//
// altea divergence: Signum keeps this an EmbeddedEntity; altea needs it to OWN a collection
// (clientCertificationFiles), and an altea `@part` row's owner must be an ENTITY, so this is a Part entity
// referenced by SmtpEmailServiceEntity rather than an inlined embedded.
@entity("Part", "Master")
export class SmtpNetworkDeliveryEmbedded extends Entity {
    @stringLengthValidator({ min: 3, max: 100 })
    host: string;

    port: int = toInt(25);

    @stringLengthValidator({ max: 100 })
    username: string | null;

    /** The ENCRYPTED password at rest (EmailSenderConfigurationLogic.encryptPassword). Never shown in the
     *  editor as itself — the user types into `newPassword`, which the Save operation encrypts into here. */
    @format("Password")
    @stringLengthValidator({ max: 200 })
    password: string | null;

    /** Signum's `[Ignore, InTypeScript(true)] NewPassword` — carried on the wire, never a column. */
    @column(false)
    newPassword: string | null;

    useDefaultCredentials: boolean = true;

    enableSSL: boolean;

    clientCertificationFiles: SmtpNetworkDeliveryEmbedded_ClientCertificationFile[];

    clone(): SmtpNetworkDeliveryEmbedded {
        return SmtpNetworkDeliveryEmbedded.create({
            host: this.host,
            port: this.port,
            username: this.username,
            password: this.password,
            useDefaultCredentials: this.useDefaultCredentials,
            enableSSL: this.enableSSL,
        });
    }
}

// Signum's SmtpEmailServiceEntity — sending over SMTP (a network host, or a pickup directory).
@entity("Part", "Master")
export class SmtpEmailServiceEntity extends EmailServiceEntity {
    deliveryFormat: SmtpDeliveryFormatEnum;

    deliveryMethod: SmtpDeliveryMethodEnum;

    /** Signum's StateValidator over DeliveryMethod: Network needs `network`, SpecifiedPickupDirectory needs
     *  `pickupDirectoryLocation`, PickupDirectoryFromIis needs neither. */
    @fieldValidation<SmtpEmailServiceEntity>(s =>
        s.deliveryMethod === SmtpDeliveryMethodEnum.Network && s.network == null ? "{0} is not set" : null)
    network: SmtpNetworkDeliveryEmbedded | null;

    @fieldValidation<SmtpEmailServiceEntity>(s =>
        s.deliveryMethod === SmtpDeliveryMethodEnum.SpecifiedPickupDirectory && s.pickupDirectoryLocation == null ? "{0} is not set" : null)
    @stringLengthValidator({ min: 3, max: 300 })
    pickupDirectoryLocation: string | null;

    override clone(): EmailServiceEntity {
        return SmtpEmailServiceEntity.create({
            deliveryFormat: this.deliveryFormat,
            deliveryMethod: this.deliveryMethod,
            network: this.network?.clone() ?? null,
            pickupDirectoryLocation: this.pickupDirectoryLocation,
        });
    }
}

// Signum's `MList<EmailRecipientEmbedded> AdditionalRecipients`, as this owner's @part row (see Email.ts).
@entity("Part", "Master")
export class EmailSenderConfigurationEntity_AdditionalRecipient extends EmailRecipientBaseEntity {
    @backReference senderConfiguration: Lite<EmailSenderConfigurationEntity>;
}

// Signum's EmailSenderConfigurationEntity.
@reflect
@entity("Shared", "Master")
export class EmailSenderConfigurationEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    defaultFrom: EmailFromEmbedded | null;

    additionalRecipients: EmailSenderConfigurationEntity_AdditionalRecipient[];

    @implementedBy(() => [SmtpEmailServiceEntity])
    service: EmailServiceEntity;

    @quoted
    toString(): string {
        return this.name;
    }

    clone(): EmailSenderConfigurationEntity {
        return EmailSenderConfigurationEntity.create({
            name: `${this.name} (Cloned)`,
            defaultFrom: this.defaultFrom?.clone() ?? null,
            service: this.service.clone(),
        });
    }
}

export namespace EmailSenderConfigurationOperation {
    export const Save: ExecuteSymbol<EmailSenderConfigurationEntity> = init();
    export const Clone: ConstructSymbol<EmailSenderConfigurationEntity, From<EmailSenderConfigurationEntity>> = init();
}

export const EmailSenderConfigurationMessage = {
    SenderConfiguration: msg("Sender configuration"),
};
