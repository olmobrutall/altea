import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { ScheduleRuleMinutelyEntity } from "../../data/Scheduler";

// Port of Signum.Scheduler Templates/ScheduleRuleMinutely.tsx.
export default function ScheduleRuleMinutely(p: { ctx: TypeContext<ScheduleRuleMinutelyEntity> }): React.JSX.Element {
    const ctx = p.ctx.subCtx({ formGroupStyle: "Basic" });
    return (
        <div className="row">
            <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(r => r.startingOn)} /></div>
            <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(r => r.eachMinutes)} /></div>
        </div>
    );
}
