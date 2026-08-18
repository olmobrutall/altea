import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { HolidayCalendarEntity } from "../../data/HolidayCalendar";

// Port of Signum.Scheduler Templates/HolidayCalendar.tsx. The country / year range drive
// HolidayCalendarOperation.ImportPublicHolidays, which appends the dates from date.nager.at.
export default function HolidayCalendar(p: { ctx: TypeContext<HolidayCalendarEntity> }): React.JSX.Element {
    const ctx = p.ctx.subCtx({ labelColumns: { sm: 3 } });
    return (
        <div>
            <AutoLine ctx={ctx.subCtx(c => c.name)} />
            <AutoLine ctx={ctx.subCtx(c => c.isDefault)} />
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(c => c.fromYear)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(c => c.toYear)} /></div>
            </div>
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(c => c.countryCode)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(c => c.subDivisionCode)} /></div>
            </div>
            <EntityTable ctx={ctx.subCtx(c => c.holidays)} columns={[
                { property: h => h.date },
                { property: h => h.name },
            ]} />
        </div>
    );
}
