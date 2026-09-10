import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Pop3EmailReceptionServiceEntity } from "../data/MailingPop3";

// One entity editor. The RECEPTION side's own editors (EmailReceptionConfiguration / EmailReception) live
// in @altea/altea-email's MailingReceptionClient.
export namespace MailingPop3Client {

    export function start(cb: ClientBuilder): void {
        cb.configure(Pop3EmailReceptionServiceEntity)
            .withView(() => import("./Templates/Pop3EmailReceptionService"));
    }
}
