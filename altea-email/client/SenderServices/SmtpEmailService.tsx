import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { SmtpDeliveryMethodEnum, type SmtpEmailServiceEntity } from "../../data/EmailSenderConfiguration";

// Port of Signum.Mailing's Templates/SenderServices/SmtpEmailService.tsx — SMTP delivery settings.
// The network block only applies to `Network` delivery, the pickup directory only to
// `SpecifiedPickupDirectory` (the two the port supports — see SmtpSender.server.ts).
export default function SmtpEmailService(p: { ctx: TypeContext<SmtpEmailServiceEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const sc = p.ctx;

    return (
        <div>
            <AutoLine ctx={sc.subCtx(s => s.deliveryFormat)} />
            <AutoLine ctx={sc.subCtx(s => s.deliveryMethod)} onChange={forceUpdate} />

            {sc.value.deliveryMethod === SmtpDeliveryMethodEnum.SpecifiedPickupDirectory &&
                <AutoLine ctx={sc.subCtx(s => s.pickupDirectoryLocation)} />}

            {sc.value.deliveryMethod === SmtpDeliveryMethodEnum.Network &&
                <EntityDetail ctx={sc.subCtx(s => s.network)} />}
        </div>
    );
}
