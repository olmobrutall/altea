import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { MultipleSMSModel } from "../../data/SMS";

// Port of Signum.SMS's Templates/MultipleSMS.tsx — what the "send to all of these" operation asks for.
export default function MultipleSMS(p: { ctx: TypeContext<MultipleSMSModel> }): React.JSX.Element {
    return (
        <div>
            <AutoLine ctx={p.ctx.subCtx(a => a.message)} formGroupHtmlAttributes={{ className: "sf-sms-msg-text" }} />
            <AutoLine ctx={p.ctx.subCtx(a => a.from)} />
            <AutoLine ctx={p.ctx.subCtx(a => a.certified)} />
        </div>
    );
}
