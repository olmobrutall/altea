import type { SchemaBuilder } from "@altea/altea/server/schema";
import { EmailLogic } from "@altea/altea-email/server/EmailLogic.server";
import { EmailSenderConfigurationLogic } from "@altea/altea-email/server/EmailSenderConfigurationLogic.server";
import { EmailSenderConfigurationEntity } from "@altea/altea-email/data/EmailSenderConfiguration";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { ExchangeWebServiceEmailServiceEntity } from "../data/MailingExchangeWS";
import { ExchangeWebServiceSender } from "./ExchangeWebServiceSender";

// Port of Signum.Mailing.ExchangeWS's MailingExchangeWSLogic.cs (+ the parts of MailingExchangeWSServer.cs
// that survive the port).
//
// altea divergences, documented inline:
//  - `sb.Settings.AssertImplementedBy((EmailSenderConfigurationEntity o) => o.Service, typeof(…))` becomes a
//    CHECK, not a mutation: `@implementedBy` lives on the field, and widening it must happen on BOTH TIERS
//    before anything is (de)serialized — so the APP does it in its shared entity-overrides module and this
//    fails loudly if it was forgotten. (Signum's AssertImplementedBy is likewise only an assertion; what
//    actually widens the field there is the attribute or an app-level override.)
//  - `DescriptionManager.ExternalEnums.Add(typeof(ExchangeVersion), …)` has no counterpart: altea declares
//    ExchangeVersionEnum itself (see the data module), so it is an ordinary translatable enum.
//  - MailingExchangeWSServer's JSON property converters (hide `password` on write, encrypt `newPassword` on
//    read) become one `registerEmailServiceSave` — see EmailSenderConfigurationLogic's header.
//  - `ReflectionServer.OverrideIsNamespaceAllowed` (making the external enum's namespace visible when the
//    user may see a sender configuration) has no counterpart: altea ships ONE metadata blob whose per-type
//    visibility already follows the type's own authorization.

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

    /** Signum's `sb.Settings.AssertImplementedBy(o => o.Service, typeof(ExchangeWebServiceEmailServiceEntity))`. */
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
