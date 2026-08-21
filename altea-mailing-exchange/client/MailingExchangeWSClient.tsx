import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ExchangeWebServiceEmailServiceEntity } from "../data/MailingExchangeWS";

// Port of Signum.Mailing.ExchangeWS's MailingExchangeWSClient.tsx — one entity editor, nothing else.
//
// altea divergence: `Navigator.addSettings(new EntitySettings(T, view))` becomes `cb.configure(T).withView(…)`.
// Signum's `start` also takes `routes`, which this module never adds to.
export namespace MailingExchangeWSClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(ExchangeWebServiceEmailServiceEntity)
            .withView(() => import("./Templates/ExchangeWebServiceEmailService"));
    }
}
