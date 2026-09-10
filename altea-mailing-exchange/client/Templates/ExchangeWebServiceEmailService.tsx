import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { ExchangeWebServiceEmailServiceEntity } from "../../data/MailingExchangeWS";

// The stored password is shown READ-ONLY and what you type goes into `newPassword`, which the Save
// operation encrypts into it — exactly as altea's own SMTP editor does. `@format("Password")` makes
// AutoLine render both as password boxes.
export default function ExchangeWebServiceEmailService(p: { ctx: TypeContext<ExchangeWebServiceEmailServiceEntity> }): React.JSX.Element {
    const sc = p.ctx;

    return (
        <div>
            <AutoLine ctx={sc.subCtx(s => s.exchangeVersion)} />
            <AutoLine ctx={sc.subCtx(s => s.url)} />
            <AutoLine ctx={sc.subCtx(s => s.useDefaultCredentials)} />
            <AutoLine ctx={sc.subCtx(s => s.username)} />
            <AutoLine ctx={sc.subCtx(s => s.password, { readOnly: true })} />
            <AutoLine ctx={sc.subCtx(s => s.newPassword)} />
        </div>
    );
}
