import type { SchemaBuilder } from "@altea/altea/server/schema";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { EmailSenderConfigurationEntity } from "@altea/altea-email/data/EmailSenderConfiguration";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic";
import { EmailSenderConfigurationLogic } from "@altea/altea-email/server/EmailSenderConfigurationLogic";
import { MicrosoftGraphEmailServiceEntity } from "../data/MailingMicrosoftGraph";
import { MicrosoftGraphSender } from "./MicrosoftGraphSender";

// The module's start: include the service, fold the typed-in client secret into the stored (encrypted) one,
// and CHECK that the app widened `EmailSenderConfigurationEntity.service` to reach this implementation —
// widening `@implementedBy` must happen on BOTH TIERS before anything is (de)serialized, so the APP does it
// and this fails loudly if that was forgotten.
//
// The REMOTE MAILBOX half is a separate `start`: an app that only SENDS through Graph has no reason to
// expose someone's inbox.
//
// See port/MailingMicrosoftGraph.md.

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

    /** A CHECK, not a mutation — the app must have widened `EmailSenderConfigurationEntity))`. */
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
