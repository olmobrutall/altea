import { reflect } from "@altea/altea/data/reflection";
import { entity, format, column, stringLengthValidator } from "@altea/altea/data/decorators";
import { EmailServiceEntity } from "@altea/altea-email/data/EmailSenderConfiguration";

// Port of Signum.Mailing.ExchangeWS's ExchangeWebServiceEmailServiceEntity.cs (+ the generated
// Signum.Mailing.ExchangeWS.External.ts, which is where its ExchangeVersion comes from) — one more
// implementation of "how do we send", alongside altea-email's own SMTP one.
//
// altea divergences, documented inline:
//  - `ExchangeVersion` is a .NET enum from `Microsoft.Exchange.WebServices.Data`, registered with Signum as an
//    EXTERNAL enum (`DescriptionManager.ExternalEnums.Add`) so its members get nice names. altea has no
//    Exchange SDK to borrow it from, so it is declared here with the same members — and, per altea's enum
//    convention, its wire value IS the member name, which is exactly the string the EWS
//    `<t:RequestServerVersion Version="…"/>` header wants. That makes the enum the protocol value, not a
//    translation of it.
//  - `NewPassword` does not exist in Signum: the server ADDS it as a virtual JSON property whose read handler
//    encrypts into `Password`. altea declares it as a real `@column(false)` field (what altea-email's own SMTP
//    service already does) and the Save operation folds it in — see MailingExchangeWSLogic.

/** Signum's `Microsoft.Exchange.WebServices.Data.ExchangeVersion`, as sent in the EWS request header. */
export enum ExchangeVersionEnum {
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

// Signum's ExchangeWebServiceEmailServiceEntity.
@reflect
@entity("Part", "Master")
export class ExchangeWebServiceEmailServiceEntity extends EmailServiceEntity {

    exchangeVersion: ExchangeVersionEnum;

    /** The EWS endpoint (e.g. `https://mail.contoso.com/EWS/Exchange.asmx`). Empty means AUTODISCOVER it from
     *  the From address, as Signum's `service.AutodiscoverUrl(email.From.EmailAddress, …)` does. */
    @stringLengthValidator({ max: 300 })
    url: string | null;

    @stringLengthValidator({ max: 100 })
    username: string | null;

    /** The ENCRYPTED password at rest. Never shown in the editor as itself — the user types into
     *  `newPassword`, which the Save operation encrypts into here. */
    @format("Password")
    @stringLengthValidator({ max: 100 })
    password: string | null;

    /** Carried on the wire, never a column (see the header). `@format("Password")` is what makes AutoLine
     *  render it as a password box — the same declaration Signum's POP3 service carries on its NewPassword. */
    @format("Password")
    @column(false)
    newPassword: string | null;

    /** Signum's UseDefaultCredentials — Windows integrated authentication. NOT portable to Node (see
     *  ExchangeWebServiceSender's header): it is an injected seam that fails loudly rather than silently
     *  sending unauthenticated. */
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
