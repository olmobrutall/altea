import { reflect } from "@altea/altea/data/reflection";
import { entity, format, niceName, column, stringLengthValidator, fieldValidation } from "@altea/altea/data/decorators";
import { ValidationMessage } from "@altea/altea/data/validators";
import { type uuid } from "@altea/altea/data/basics";
import { EmailServiceEntity } from "@altea/altea-email/data/EmailSenderConfiguration";

// Port of Signum.Mailing.MicrosoftGraph's MicrosoftGraphEmailServiceEntity.cs — sending through the Graph
// `sendMail` endpoint instead of SMTP. One more implementation of altea-email's abstract EmailServiceEntity.
//
// The interesting field is `useActiveDirectoryConfiguration`: with it set, the service borrows the
// application's EXISTING Entra ID registration (@altea/altea-auth-azuread's AzureADConfiguration) instead of
// carrying its own client secret — which is what an app that already signs users in through Entra wants.
// Signum's PropertyValidation makes the three Azure fields mandatory only when it is NOT set; altea says the
// same thing with three `@fieldValidation`s, since altea has no PropertyValidation switchboard.
//
// altea divergences, documented inline:
//  - `[Description("Azure Application (client) ID")]` becomes `@niceName(...)`.
//  - `Guid?` becomes `uuid | null`.
//  - `Azure_ClientSecret` is stored ENCRYPTED (`EmailSenderConfigurationLogic.encryptPassword`) and edited
//    through a `newAzure_ClientSecret` field, which is what altea's own SMTP service does. Signum stores the
//    secret in the clear here — it declares no `[Format(Password)]` and no JSON converter for this type, so
//    the value round-trips to the browser on every read. That is worth diverging from: it is a tenant-wide
//    application credential.

// Signum's MicrosoftGraphEmailServiceEntity.
@reflect
@entity("Part", "Master")
export class MicrosoftGraphEmailServiceEntity extends EmailServiceEntity {

    /** Borrow the app's Entra ID registration (see the header) instead of the three fields below. */
    useActiveDirectoryConfiguration: boolean;

    @niceName("Azure Application (client) ID")
    @fieldValidation<MicrosoftGraphEmailServiceEntity>(s => !s.useActiveDirectoryConfiguration && s.azure_ApplicationID == null
        ? ValidationMessage._0IsNotSet.niceToString(MicrosoftGraphEmailServiceEntity.nicePropertyName(a => a.azure_ApplicationID)) : null)
    azure_ApplicationID: uuid | null;

    @niceName("Azure Directory (tenant) ID")
    @fieldValidation<MicrosoftGraphEmailServiceEntity>(s => !s.useActiveDirectoryConfiguration && s.azure_DirectoryID == null
        ? ValidationMessage._0IsNotSet.niceToString(MicrosoftGraphEmailServiceEntity.nicePropertyName(a => a.azure_DirectoryID)) : null)
    azure_DirectoryID: uuid | null;

    /** The ENCRYPTED secret at rest (see the header). The user types into `newAzure_ClientSecret`. */
    @niceName("Azure Client Secret Value")
    @format("Password")
    @stringLengthValidator({ max: 200 })
    @fieldValidation<MicrosoftGraphEmailServiceEntity>(s => !s.useActiveDirectoryConfiguration
        && !s.azure_ClientSecret && !s.newAzure_ClientSecret
        ? ValidationMessage._0IsNotSet.niceToString(MicrosoftGraphEmailServiceEntity.nicePropertyName(a => a.azure_ClientSecret)) : null)
    azure_ClientSecret: string | null;

    /** Carried on the wire, never a column — the Save operation encrypts it into `azure_ClientSecret`. */
    @niceName("New Azure Client Secret Value")
    @format("Password")
    @column(false)
    newAzure_ClientSecret: string | null;

    override clone(): MicrosoftGraphEmailServiceEntity {
        return MicrosoftGraphEmailServiceEntity.create({
            useActiveDirectoryConfiguration: this.useActiveDirectoryConfiguration,
            azure_ApplicationID: this.azure_ApplicationID,
            azure_DirectoryID: this.azure_DirectoryID,
            azure_ClientSecret: this.azure_ClientSecret,
        });
    }
}
