import { reflect, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { part, format, column } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { EmailServiceEntity } from "@altea/altea-email/data/EmailSenderConfiguration";

// One more implementation of "how do we send", alongside altea-email's own SMTP one.
//
// The enum's wire value IS the member name, which is exactly the string the EWS
// `<t:RequestServerVersion Version="…"/>` header wants — so the enum is the protocol value, not a
// translation of it.
//
// Port of Signum.Mailing.ExchangeWS's ExchangeWebServiceEmailServiceEntity.cs — see
// docs/port/MailingExchange.md.

/** The schema version, sent in the EWS request header. */
export enum ExchangeVersion {
    Exchange2007_SP1,
    Exchange2010,
    Exchange2010_SP1,
    Exchange2010_SP2,
    Exchange2013,
    Exchange2013_SP1,
    Exchange2015,
    Exchange2016,
    V2015_10_05,
}

@reflect
@part
export class ExchangeWebServiceEmailServiceEntity extends EmailServiceEntity {

    exchangeVersion: ExchangeVersion;

    /** The EWS endpoint (e.g. `https://mail.contoso.com/EWS/Exchange.asmx`). Empty means AUTODISCOVER it
     *  from the From address. */
    @stringLengthValidator({ max: 300 })
    url: string | null;

    @stringLengthValidator({ max: 100 })
    username: string | null;

    /** The ENCRYPTED password at rest. Never shown in the editor as itself — the user types into
     *  `newPassword`, which the Save operation encrypts into here. */
    @format("Password")
    @stringLengthValidator({ max: 100 })
    password: string | null;

    /** Carried on the wire, never a column: the Save operation encrypts it into `password`.
     *  `@format("Password")` is what makes AutoLine render it as a password box. */
    @format("Password")
    @column(false)
    newPassword: string | null;

    /** Windows integrated authentication. NOT portable to Node — it needs an injected
     *  `ExchangeWebServices.negotiateProvider`, and fails loudly without one rather than silently sending
     *  unauthenticated. */
    useDefaultCredentials: boolean = true;

    override clone(): ExchangeWebServiceEmailServiceEntity {
        return ExchangeWebServiceEmailServiceEntity.create({
            exchangeVersion: this.exchangeVersion,
            url: this.url,
            username: this.username,
            password: this.password,
            useDefaultCredentials: this.useDefaultCredentials,
        });
    }
}

setDefaultDatabaseSchema("mailing");
