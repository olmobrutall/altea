import { reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, format, unit, column, backReference, rowOrder, quoted, stringLengthValidator, fieldValidation,
} from "@altea/altea/data/decorators";
import { ValidationMessage } from "@altea/altea/data/validators";
import { type int, toInt } from "@altea/altea/data/basics";
import { EmailReceptionServiceEntity } from "@altea/altea-email/data/EmailReception";

// Port of Signum.Mailing.Pop3's Pop3EmailReceptionServiceEntity.cs — where to poll and with what credentials.
// One implementation of altea-email's abstract EmailReceptionServiceEntity (see its header for the split).
//
// altea divergences, documented inline:
//  - `MList<ClientCertificationFileEmbedded>` becomes this owner's `@part` ROW (altea has no MList; the SMTP
//    side's SmtpNetworkDeliveryEmbedded gets the same treatment).
//  - Signum's `EnableSSL` SETTER flips `Port` between 995 and 110. altea entities are plain field bags with no
//    setters, so the port is a plain field with Signum's own default (110) and the CLIENT does the flip when
//    the checkbox changes (see client/Templates/Pop3EmailReceptionService.tsx) — the same behaviour where a
//    user can see it, without a hidden write on deserialization.
//  - `NewPassword` is declared here (Signum declares it too, `[Ignore]`), and the Save operation folds it into
//    the stored `password` through `EmailReceptionLogic.registerEmailReceptionServiceSave` — where Signum uses
//    a JSON property converter.

// Signum's ClientCertificationFileEmbedded, as this owner's @part row.
@entity("Part", "Master")
export class Pop3EmailReceptionServiceEntity_ClientCertificationFile extends Entity {
    @backReference service: Lite<Pop3EmailReceptionServiceEntity>;
    @rowOrder order: int;

    @stringLengthValidator({ min: 2, max: 300 })
    fullFilePath: string;

    @quoted
    toString(): string {
        return this.fullFilePath;
    }
}

// Signum's Pop3EmailReceptionServiceEntity.
@reflect
@entity("Part", "Master")
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

    /** Implicit TLS (port 995 by convention). POP3's STARTTLS is not offered — see Pop3Client's header. */
    enableSSL: boolean;

    /** Signum's `[NumberIsValidator(GreaterThanOrEqualTo, -1)]` — -1 means "no timeout". altea has no
     *  NumberIsValidator, so the comparison is a `@fieldValidation` (the shape altea-chart / altea-scheduler
     *  already use for the same attribute). */
    @fieldValidation<Pop3EmailReceptionServiceEntity>(s => s.readTimeout >= -1 ? null
        : ValidationMessage.NumberIsTooSmall.niceToString())
    @unit("ms")
    readTimeout: int = toInt(60000);

    clientCertificationFiles: Pop3EmailReceptionServiceEntity_ClientCertificationFile[];

    @quoted
    toString(): string {
        return `${this.username} (${this.host})`;
    }
}
