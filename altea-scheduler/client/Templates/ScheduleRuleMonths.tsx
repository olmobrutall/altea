import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { ScheduleRuleMonthsEntity } from "../../data/Scheduler";

// Port of Signum.Scheduler Templates/ScheduleRuleMonths.tsx: the day + time come from StartingOn, the
// twelve checkboxes say in which months it applies.
export default function ScheduleRuleMonths(p: { ctx: TypeContext<ScheduleRuleMonthsEntity> }): React.JSX.Element {
    const ctx = p.ctx.subCtx({ formGroupStyle: "Basic" });
    const months = ["january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december"] as const;
    return (
        <div>
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(r => r.startingOn)} /></div>
            </div>
            <div className="row">
                {months.map(m => <div className="col-sm-2" key={m}><AutoLine ctx={ctx.subCtx(m)} /></div>)}
            </div>
        </div>
    );
}
