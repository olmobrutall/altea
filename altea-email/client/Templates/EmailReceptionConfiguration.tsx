import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { EmailReceptionConfigurationEntity } from "../../data/EmailReception";

// Port of Signum.Mailing/Reception's Templates/EmailReceptionConfiguration.tsx.
//
// altea divergence: Signum renders `service` with a bare <AutoLine/>; the service is a polymorphic reference
// to a Part entity, which is edited INLINE — so this uses <EntityDetail/>, the line that embeds the chosen
// implementation's own view (the same treatment altea's EmailSenderConfiguration gives its `service`).
export default function EmailReceptionConfiguration(p: { ctx: TypeContext<EmailReceptionConfigurationEntity> }): React.JSX.Element {
    const sc = p.ctx.subCtx({ formGroupStyle: "Basic" });

    return (
        <div>
            <AutoLine ctx={sc.subCtx(s => s.active)} />
            <AutoLine ctx={sc.subCtx(s => s.emailAddress)} />
            <AutoLine ctx={sc.subCtx(s => s.deleteMessagesAfter)} />
            <AutoLine ctx={sc.subCtx(s => s.compareInbox)} />
            <EntityDetail ctx={sc.subCtx(s => s.service)} />
        </div>
    );
}
