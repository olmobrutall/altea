import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { EmailMessageEntity_Recipient } from "../../data/EmailMessage";

// Port of Signum.Mailing's Templates/EmailRecipient.tsx — one recipient of a produced message.
export default function EmailRecipient(p: { ctx: TypeContext<EmailMessageEntity_Recipient> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const sc = p.ctx.subCtx({ placeholderLabels: true, formGroupStyle: "SrOnly" });

    return (
        <div className="row">
            <div className="col-sm-1">
                <AutoLine ctx={sc.subCtx(c => c.kind)} onChange={forceUpdate} />
            </div>
            <div className="col-sm-11">
                <EntityLine ctx={sc.subCtx(ea => ea.emailOwner)} />
            </div>
            <div className="col-sm-5 offset-sm-1">
                <TextBoxLine ctx={sc.subCtx(c => c.emailAddress)} valueHtmlAttributes={{ onBlur: forceUpdate }} />
            </div>
            <div className="col-sm-6">
                <TextBoxLine ctx={sc.subCtx(c => c.displayName)} valueHtmlAttributes={{ onBlur: forceUpdate }} />
            </div>
        </div>
    );
}
