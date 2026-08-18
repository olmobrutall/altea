import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { EmailFromEmbedded } from "../../data/Email";

// Port of Signum.Mailing's Templates/EmailFrom.tsx — the sender of a produced message.
export default function EmailFrom(p: { ctx: TypeContext<EmailFromEmbedded> }): React.JSX.Element {
    const sc = p.ctx.subCtx({ placeholderLabels: true, formGroupStyle: "SrOnly" });

    return (
        <div className="row">
            <div className="col-sm-11 offset-sm-1">
                <EntityLine ctx={sc.subCtx(ea => ea.emailOwner)} />
            </div>
            <div className="col-sm-5 offset-sm-1">
                <AutoLine ctx={sc.subCtx(c => c.emailAddress)} />
                <AutoLine ctx={sc.subCtx(c => c.azureUserId)} />
            </div>
            <div className="col-sm-6">
                <AutoLine ctx={sc.subCtx(c => c.displayName)} />
            </div>
        </div>
    );
}
