import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { ScheduleRuleWeekDaysEntity } from "../../data/Scheduler";

// Port of Signum.Scheduler Templates/ScheduleRuleWeekDays.tsx: the seven day checkboxes in a row, then the
// holiday calendar and whether its dates are the ONLY ones or the excluded ones.
export default function ScheduleRuleWeekDays(p: { ctx: TypeContext<ScheduleRuleWeekDaysEntity> }): React.JSX.Element {
    const ctx = p.ctx.subCtx({ formGroupStyle: "Basic" });
    return (
        <div>
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(r => r.startingOn)} /></div>
            </div>
            <div className="row">
                <div className="col-sm-1"><AutoLine ctx={ctx.subCtx(r => r.monday)} /></div>
                <div className="col-sm-1"><AutoLine ctx={ctx.subCtx(r => r.tuesday)} /></div>
                <div className="col-sm-1"><AutoLine ctx={ctx.subCtx(r => r.wednesday)} /></div>
                <div className="col-sm-1"><AutoLine ctx={ctx.subCtx(r => r.thursday)} /></div>
                <div className="col-sm-1"><AutoLine ctx={ctx.subCtx(r => r.friday)} /></div>
                <div className="col-sm-1"><AutoLine ctx={ctx.subCtx(r => r.saturday)} /></div>
                <div className="col-sm-1"><AutoLine ctx={ctx.subCtx(r => r.sunday)} /></div>
            </div>
            <div className="row">
                <div className="col-sm-6"><EntityLine ctx={ctx.subCtx(r => r.calendar)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(r => r.holiday)} /></div>
            </div>
        </div>
    );
}
