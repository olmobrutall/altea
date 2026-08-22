import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { TimeSpanEmbedded } from "../../data/WorkflowNodes";

// Port of Signum.Workflow's Workflow/TimeSpan.tsx — the four-part duration editor. Verbatim.

export default function TimeSpan(p: { ctx: TypeContext<TimeSpanEmbedded> }): React.JSX.Element {
    const sc = p.ctx.subCtx({ formGroupStyle: "BasicDown" });

    return (
        <div className="row">
            <div className="col-sm-3">
                <AutoLine ctx={sc.subCtx(n => n.days)} />
            </div>
            <div className="col-sm-3">
                <AutoLine ctx={sc.subCtx(n => n.hours)} />
            </div>
            <div className="col-sm-3">
                <AutoLine ctx={sc.subCtx(n => n.minutes)} />
            </div>
            <div className="col-sm-3">
                <AutoLine ctx={sc.subCtx(n => n.seconds)} />
            </div>
        </div>
    );
}
