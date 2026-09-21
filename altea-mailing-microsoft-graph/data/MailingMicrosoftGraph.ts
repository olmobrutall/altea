import { setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { part, format, niceName, column } from "@altea/altea/data/decorators";
import { stringLengthValidator, validate, ValidationMessage } from "@altea/altea/data/validators";
import { type uuid } from "@altea/altea/data/basics";
import { EmailServiceEntity } from "@altea/altea-email/data/EmailSenderConfiguration";

// Sending through the Graph `sendMail` endpoint instead of SMTP. One more implementation of altea-email's
// abstract EmailServiceEntity.
//
// The interesting field is `useActiveDirectoryConfiguration`: with it set, the service borrows the
// application's EXISTING Entra ID registration (@altea/altea-auth-azuread's AzureADConfiguration) instead
// of carrying its own client secret — which is what an app that already signs users in through Entra
// wants. The three Azure fields are mandatory only when it is NOT set, hence three `@validate`s.
//
// **`azure_ClientSecret` is stored ENCRYPTED** and edited through `newAzure_ClientSecret`, as altea's own
// SMTP service does: it is a tenant-wide application credential, and storing it in the clear would
// round-trip it to the browser on every read.
//
// Port of Signum.Mailing.MicrosoftGraph's MicrosoftGraphEmailServiceEntity.cs — see
// port/MailingMicrosoftGraph.md.

@part
export class MicrosoftGraphEmailServiceEntity extends EmailServiceEntity {

    /** Borrow the app's Entra ID registration (see the header) instead of the three fields below. */
    useActiveDirectoryConfiguration: boolean;

    @niceName("Azure Application (client) ID")
    @validate<MicrosoftGraphEmailServiceEntity>(s => !s.useActiveDirectoryConfiguration && s.azure_ApplicationID == null
        ? ValidationMessage._0IsNotSet.niceToString(MicrosoftGraphEmailServiceEntity.nicePropertyName(a => a.azure_ApplicationID)) : null)
    azure_ApplicationID: uuid | null;

    @niceName("Azure Directory (tenant) ID")
    @validate<MicrosoftGraphEmailServiceEntity>(s => !s.useActiveDirectoryConfiguration && s.azure_DirectoryID == null
        ? ValidationMessage._0IsNotSet.niceToString(MicrosoftGraphEmailServiceEntity.nicePropertyName(a => a.azure_DirectoryID)) : null)
    azure_DirectoryID: uuid | null;

    /** The ENCRYPTED secret at rest (see the header). The user types into `newAzure_ClientSecret`. */
    @niceName("Azure Client Secret Value")
    @format("Password")
    @stringLengthValidator({ max: 200 })
    @validate<MicrosoftGraphEmailServiceEntity>(s => !s.useActiveDirectoryConfiguration
        && !s.azure_ClientSecret && !s.newAzure_ClientSecret
        ? ValidationMessage._0IsNotSet.niceToString(MicrosoftGraphEmailServiceEntity.nicePropertyName(a => a.azure_ClientSecret)) : null)
    @stringLengthValidator({ max: 100 })
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

setDefaultDatabaseSchema("mailing");
