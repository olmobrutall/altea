import * as React from "react";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { FileLine } from "@altea/altea-files/client/Components/FileLine";
import { ExcelReportEntity } from "../../data/excel/ExcelReport";

// Port of Signum.Excel's Templates/ExcelReport.tsx — three lines, and that is the whole editor: an
// ExcelReport IS its template file, and everything about how the report looks was authored in Excel.

export default function ExcelReport(p: { ctx: TypeContext<ExcelReportEntity> }): React.JSX.Element {
    const ctx = p.ctx;

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(f => f.query)} />
            <AutoLine ctx={ctx.subCtx(f => f.displayName)} />
            <FileLine ctx={ctx.subCtx(f => f.file)} containerEntity={ctx.value} accept=".xlsx" />
        </div>
    );
}
