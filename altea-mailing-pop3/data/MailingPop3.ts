import { reflect, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { part, format, unit, column, backReference, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator, validate, ValidationMessage } from "@altea/altea/data/validators";
import { type int, toInt } from "@altea/altea/data/basics";
import { EmailReceptionServiceEntity } from "@altea/altea-email/data/EmailReception";

// Where to poll and with what credentials. One implementation of altea-email's abstract
// EmailReceptionServiceEntity (see its header for the split).
//
// The `enableSSL` / `port` flip lives in the CLIENT editor rather than in a property setter — see
// client/Templates/Pop3EmailReceptionService.tsx.
//
// Port of Signum.Mailing.Pop3's Pop3EmailReceptionServiceEntity.cs — see port/MailingPop3.md.

// A client certificate to present, as this owner's @part row.
@part
export class Pop3EmailReceptionServiceEntity_ClientCertificationFile extends Entity {
    @backReference service: Lite<Pop3EmailReceptionServiceEntity>;
    // No `@rowOrder`: this table has no Order column (the SMTP sender's twin says the same).

    @stringLengthValidator({ min: 2, max: 300 })
    fullFilePath: string;

    @quoted
    toString(): string {
        return this.fullFilePath;
    }
}

@reflect
@part
export class Pop3EmailReceptionServiceEntity extends EmailReceptionServiceEntity {

    port: int = toInt(110);

    @stringLengthValidator({ min: 3, max: 100 })
    host: string;

    @stringLengthValidator({ max: 100 })
    username: string | null;

    /** The ENCRYPTED password at rest. The user types into `newPassword` (see the header). */
    @format("Password")
    @stringLengthValidator({ max: 100 })
    password: string | null;

    /** Carried on the wire, never a column. */
    @format("Password")
    @column(false)
    @stringLengthValidator({ max: 100 })
    newPassword: string | null;

    /** Implicit TLS (port 995 by convention). POP3's STARTTLS is not offered — see Pop3Client. */
    enableSSL: boolean;

    /** `-1` means "no timeout". A `@validate`, the shape altea-chart / altea-scheduler already use for the
     *  same comparison. */
    @validate<Pop3EmailReceptionServiceEntity>(s => s.readTimeout >= -1 ? null
        : ValidationMessage.NumberIsTooSmall.niceToString())
    @unit("ms")
    readTimeout: int = toInt(60000);

    clientCertificationFiles: Pop3EmailReceptionServiceEntity_ClientCertificationFile[];

    @quoted
    toString(): string {
        return `${this.username} (${this.host})`;
    }
}

setDefaultDatabaseSchema("mailing");
