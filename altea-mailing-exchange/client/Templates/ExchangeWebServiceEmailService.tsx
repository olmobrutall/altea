import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { ExchangeWebServiceEmailServiceEntity } from "../../data/MailingExchangeWS";

// Port of Signum.Mailing.ExchangeWS's Templates/ExchangeWebServiceEmailService.tsx.
//
// altea divergence: Signum binds `password`, even though the server never sends its value and reads the typed
// one back as a virtual `newPassword` property — so the field looks editable but is not the one being edited.
// altea has a REAL `newPassword` field (see the data module), so the stored password is shown read-only and
// what you type goes into `newPassword`, exactly as altea's own SMTP editor does. `@format("Password")` makes
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
