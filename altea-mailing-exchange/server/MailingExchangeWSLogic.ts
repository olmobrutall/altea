import type { SchemaBuilder } from "@altea/altea/server/schema";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic";
import { EmailSenderConfigurationLogic } from "@altea/altea-email/server/EmailSenderConfigurationLogic";
import { EmailSenderConfigurationEntity } from "@altea/altea-email/data/EmailSenderConfiguration";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { ExchangeWebServiceEmailServiceEntity } from "../data/MailingExchangeWS";
import { ExchangeWebServiceSender } from "./ExchangeWebServiceSender";

// The module's start: include the service, fold the typed-in password into the stored one, and check that
// the app widened `EmailSenderConfigurationEntity.service` to reach this implementation.
//
// Port of Signum.Mailing.ExchangeWS's MailingExchangeWSLogic.cs — see docs/port/MailingExchange.md.

export namespace MailingExchangeWSLogic {

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        assertImplementedBy();

        EmailLogic.registerEmailSender(ExchangeWebServiceEmailServiceEntity,
            (service, config) => new ExchangeWebServiceSender(config, service as ExchangeWebServiceEmailServiceEntity));

        // The typed-in password becomes the stored (encrypted) one when the configuration is saved.
        EmailSenderConfigurationLogic.registerEmailServiceSave(ExchangeWebServiceEmailServiceEntity, exchange => {
            if (exchange.newPassword != null) {
                exchange.password = EmailSenderConfigurationLogic.encryptPassword(exchange.newPassword);
                exchange.newPassword = null;
            }
        });
    }

    /** A CHECK, not a mutation: widening `@implementedBy` must happen on BOTH TIERS before anything is
     *  (de)serialized, so the APP does it and this fails loudly if that was forgotten. */
    function assertImplementedBy(): void {
        const impl = getTypeInfo(EmailSenderConfigurationEntity)?.fields["service"]?.implementations;
        const types = impl?.kind === "implementedBy" ? impl.types() : [];

        if (!types.includes(ExchangeWebServiceEmailServiceEntity as never))
            throw new Error("ExchangeWebServiceEmailServiceEntity is not among the implementations of"
                + " EmailSenderConfigurationEntity.service. Add it with `overrideImplementedBy("
                + "EmailSenderConfigurationEntity, \"service\", () => [SmtpEmailServiceEntity,"
                + " ExchangeWebServiceEmailServiceEntity, …])` in the app's shared entity-overrides module"
                + " (it must run on BOTH tiers).");
    }
}
