import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { MicrosoftGraphEmailServiceEntity } from "../data/MailingMicrosoftGraph";

// Port of Signum.Mailing.MicrosoftGraph's MailingMicrosoftGraphClient.tsx — one entity editor.
//
// altea divergences: `Navigator.addSettings(new EntitySettings(T, view))` becomes
// `cb.configure(T).withView(…)`, and `ChangeLogClient.registerChangeLogModule` has no altea counterpart (its
// Changelog.ts was an empty stub anyway). The REMOTE MAILBOX half registers separately —
// `RemoteEmailsClient.start(cb)` — matching the server split.
export namespace MailingMicrosoftGraphClient {

    export function start(cb: ClientBuilder): void {
        cb.configure(MicrosoftGraphEmailServiceEntity)
            .withView(() => import("./Templates/MicrosoftGraphEmailService"));
    }
}
