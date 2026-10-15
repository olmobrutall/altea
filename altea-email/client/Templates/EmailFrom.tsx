import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { EmailFromEmbedded } from "../../data/Email";

// Port of Signum.Mailing's Templates/EmailFrom.tsx — the sender of a produced message.
export default function EmailFrom(p: { ctx: TypeContext<EmailFromEmbedded> }): React.JSX.Element {
    const sc = p.ctx.subCtx({ placeholderLabels: true, formGroupStyle: "SrOnly" });

    return (
        <div className="sf-row">
            <div className="sm:col-span-11 sm:col-start-2">
                <EntityLine ctx={sc.subCtx(ea => ea.emailOwner)} />
            </div>
            <div className="sm:col-span-5 sm:col-start-2">
                <AutoLine ctx={sc.subCtx(c => c.emailAddress)} />
                <AutoLine ctx={sc.subCtx(c => c.azureUserId)} />
            </div>
            <div className="sm:col-span-6">
                <AutoLine ctx={sc.subCtx(c => c.displayName)} />
            </div>
        </div>
    );
}
