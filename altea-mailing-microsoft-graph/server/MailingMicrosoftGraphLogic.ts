import type { SchemaBuilder } from "@altea/altea/server/schema";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { EmailSenderConfigurationEntity } from "@altea/altea-email/data/EmailSenderConfiguration";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic.server";
import { EmailSenderConfigurationLogic } from "@altea/altea-email/server/EmailSenderConfigurationLogic.server";
import { MicrosoftGraphEmailServiceEntity } from "../data/MailingMicrosoftGraph";
import { MicrosoftGraphSender } from "./MicrosoftGraphSender";

// Port of Signum.Mailing.MicrosoftGraph's MailingMicrosoftGraphLogic.cs.
//
// altea divergences, documented inline:
//  - `sb.Settings.AssertImplementedBy((EmailSenderConfigurationEntity o) => o.Service, typeof(…))` is a
//    CHECK, not a mutation: `@implementedBy` lives on the field and widening it must happen on BOTH TIERS
//    before anything is (de)serialized, so the APP does it in its shared entity-overrides module and this
//    fails loudly if it was forgotten.
//  - The client secret is stored ENCRYPTED and edited through `newAzure_ClientSecret` (see the data module's
//    header); that fold-in is registered here, the way altea-email's own SMTP service does it.
//  - The REMOTE MAILBOX half is a separate `start` — Signum ships RemoteEmailsLogic.Start separately too, and
//    an app that only SENDS through Graph has no reason to expose someone's inbox.

export namespace MailingMicrosoftGraphLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        assertImplementedBy();

        EmailLogic.registerEmailSender(MicrosoftGraphEmailServiceEntity,
            (service, config) => new MicrosoftGraphSender(config, service as MicrosoftGraphEmailServiceEntity));

        EmailSenderConfigurationLogic.registerEmailServiceSave(MicrosoftGraphEmailServiceEntity, graph => {
            if (graph.newAzure_ClientSecret != null) {
                graph.azure_ClientSecret = EmailSenderConfigurationLogic.encryptPassword(graph.newAzure_ClientSecret);
                graph.newAzure_ClientSecret = null;
            }
        });
    }

    /** Signum's `sb.Settings.AssertImplementedBy(o => o.Service, typeof(MicrosoftGraphEmailServiceEntity))`. */
    function assertImplementedBy(): void {
        const impl = getTypeInfo(EmailSenderConfigurationEntity)?.fields["service"]?.implementations;
        const types = impl?.kind === "implementedBy" ? impl.types() : [];

        if (!types.includes(MicrosoftGraphEmailServiceEntity as never))
            throw new Error("MicrosoftGraphEmailServiceEntity is not among the implementations of"
                + " EmailSenderConfigurationEntity.service. Add it with `overrideImplementedBy("
                + "EmailSenderConfigurationEntity, \"service\", () => [SmtpEmailServiceEntity,"
                + " MicrosoftGraphEmailServiceEntity, …])` in the app's shared entity-overrides module"
                + " (it must run on BOTH tiers).");
    }
}
