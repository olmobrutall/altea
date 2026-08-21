import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Pop3EmailReceptionServiceEntity } from "../data/MailingPop3";

// Port of Signum.Mailing.Pop3's MailingPop3Client.tsx — one entity editor.
//
// altea divergence: `Navigator.addSettings(new EntitySettings(T, view))` becomes
// `cb.configure(T).withView(…)`. The RECEPTION side's own editors (EmailReceptionConfiguration /
// EmailReception) live in @altea/altea-email's MailingReceptionClient, as they do in Signum.Mailing.
export namespace MailingPop3Client {

    export function start(cb: ClientBuilder): void {
        cb.configure(Pop3EmailReceptionServiceEntity)
            .withView(() => import("./Templates/Pop3EmailReceptionService"));
    }
}
