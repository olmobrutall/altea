import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ExchangeWebServiceEmailServiceEntity } from "../data/MailingExchangeWS";

// One entity editor, nothing else.
export namespace MailingExchangeWSClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(ExchangeWebServiceEmailServiceEntity)
            .withView(() => import("./Templates/ExchangeWebServiceEmailService"));
    }
}
