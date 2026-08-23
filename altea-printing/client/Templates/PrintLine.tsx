import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { FileLine } from "@altea/altea-files/client/Components/FileLine";
import { ProcessExceptionLineEntity } from "@altea/altea-processes/data/Processes";
import { PrintLineEntity, PrintLineState } from "../../data/Printing";

// Port of Signum.Printing's Templates/PrintLine.tsx — read-only except while the line is a NewTest, which is
// the one state in which a human uploads the file.
export default function PrintLine(p: { ctx: TypeContext<PrintLineEntity> }): React.JSX.Element {
    const e = p.ctx.subCtx({ readOnly: true });

    return (
        <div>
            <AutoLine ctx={e.subCtx(f => f.creationDate)} />
            <EntityLine ctx={e.subCtx(f => f.referred)} />
            <FileLine ctx={e.subCtx(f => f.file)} fileType={e.value.testFileType ?? undefined}
                readOnly={p.ctx.value.state !== PrintLineState.NewTest} />
            <AutoLine ctx={e.subCtx(f => f.state)} />
            <AutoLine ctx={e.subCtx(f => f.printedOn)} />
            {!e.value.isNew &&
                <fieldset>
                    <legend>{ProcessExceptionLineEntity.nicePluralName()}</legend>
                    <SearchControl findOptions={ProcessExceptionLineEntity.findOptions(token => ({
                        filterOptions: [token(l => l.line).filter("EqualTo", e.value)],
                    }))} />
                </fieldset>}
        </div>
    );
}
