import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityRepeater } from "@altea/altea/client/Lines/EntityRepeater";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { SmtpNetworkDeliveryEmbedded } from "../../data/EmailSenderConfiguration";

// The network half of Signum's SmtpEmailService.tsx (altea splits it out because
// SmtpNetworkDeliveryEmbedded is a Part ENTITY here — it owns the client-certificate rows, and an altea
// `@part` collection needs an entity owner).
//
// The stored `password` is READ-ONLY: the user types into `newPassword`, which the Save operation encrypts
// into `password` and clears (Signum's EmailSenderConfigurationLogic.Save does the same).
export default function SmtpNetworkDelivery(p: { ctx: TypeContext<SmtpNetworkDeliveryEmbedded> }): React.JSX.Element {
    const net = p.ctx;

    return (
        <div>
            <AutoLine ctx={net.subCtx(s => s.host)} />
            <AutoLine ctx={net.subCtx(s => s.port)} />
            <AutoLine ctx={net.subCtx(s => s.useDefaultCredentials)} />
            <AutoLine ctx={net.subCtx(s => s.username)} />
            <AutoLine ctx={net.subCtx(s => s.password, { readOnly: true })} />
            <AutoLine ctx={net.subCtx(s => s.newPassword)} />
            <AutoLine ctx={net.subCtx(s => s.enableSSL)} />
            <EntityRepeater ctx={net.subCtx(s => s.clientCertificationFiles)} />
        </div>
    );
}
