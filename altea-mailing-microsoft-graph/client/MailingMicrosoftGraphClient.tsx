import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { MicrosoftGraphEmailServiceEntity } from "../data/MailingMicrosoftGraph";

// One entity editor. The REMOTE MAILBOX half registers separately — `RemoteEmailsClient.start(cb)` —
// matching the server split.
export namespace MailingMicrosoftGraphClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(MicrosoftGraphEmailServiceEntity)
            .withView(() => import("./Templates/MicrosoftGraphEmailService"));
    }
}
