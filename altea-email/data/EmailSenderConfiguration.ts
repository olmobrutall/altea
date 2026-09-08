import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, part, implementedBy, uniqueIndex, backReference, format, quoted, column,
} from "@altea/altea/data/decorators";
import { stringLengthValidator, validate } from "@altea/altea/data/validators";
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

export enum SmtpDeliveryFormat {
    SevenBit,
    International,
}

export enum SmtpDeliveryMethod {
    Network,
    SpecifiedPickupDirectory,
    PickupDirectoryFromIis,
}

// Signum's EmailServiceEntity — the abstract "sending mechanism" a configuration points at.
@reflect
@part("Master")
export abstract class EmailServiceEntity extends Entity {
    abstract clone(): EmailServiceEntity;

    /** Signum's ValidateFrom — a service may require (or forbid) a particular From identity. */
    validateFrom(_from: EmailFromEmbedded): string | null { return null; }
}

// Signum's ClientCertificationFileEmbedded — an MList inside SmtpNetworkDeliveryEmbedded, so in altea a
// @part ROW (a collection has no embedded element type). An embedded is flattened onto its owner's row and
// has no id, so the back reference names the ENTITY that holds the embedded: the SMTP service.
@part("Master")
export class ClientCertificationFileEntity extends Entity {
    @backReference service: Lite<SmtpEmailServiceEntity>;
    // No `@rowOrder`: Signum does not mark this MList [PreserveOrder], so its table has no
    // Order column and neither does this one.

    @stringLengthValidator({ min: 2, max: 300 })
    fullFilePath: string;

    @quoted
    toString(): string {
        return this.fullFilePath;
    }
}

// Signum's SmtpNetworkDeliveryEmbedded — host/port/credentials for a real SMTP connection. An EMBEDDED, as
// in Signum: its columns are `network_*` on `smtp_email_service`. (It was a `@part` entity while altea
// could not declare a collection inside an embedded, which `clientCertificationFiles` is.)
@reflect
export class SmtpNetworkDeliveryEmbedded extends EmbeddedEntity {
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

    // `= false` is not restating a zero value: Signum's `public bool EnableSSL { get; set; }` IS initialized —
    // by C#, to false — and altea's implicit NotNull validator rejects an unset non-nullable field, so an SMTP
    // row built in code (an app seeding a sender) could not be saved without it.
    enableSSL: boolean = false;

    clientCertificationFiles: ClientCertificationFileEntity[];

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
@part("Master")
export class SmtpEmailServiceEntity extends EmailServiceEntity {
    deliveryFormat: SmtpDeliveryFormat;

    deliveryMethod: SmtpDeliveryMethod;

    /** Signum's StateValidator over DeliveryMethod: Network needs `network`, SpecifiedPickupDirectory needs
     *  `pickupDirectoryLocation`, PickupDirectoryFromIis needs neither. */
    @validate<SmtpEmailServiceEntity>(s =>
        s.deliveryMethod === SmtpDeliveryMethod.Network && s.network == null ? "{0} is not set" : null)
    network: SmtpNetworkDeliveryEmbedded | null;

    @validate<SmtpEmailServiceEntity>(s =>
        s.deliveryMethod === SmtpDeliveryMethod.SpecifiedPickupDirectory && s.pickupDirectoryLocation == null ? "{0} is not set" : null)
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
@part("Master")
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
