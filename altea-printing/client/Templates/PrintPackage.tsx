import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { PrintLineEntity, PrintPackageEntity } from "../../data/Printing";

// Port of Signum.Printing's Templates/PrintPackage.tsx — the batch's name plus its lines.
export default function PrintPackage(p: { ctx: TypeContext<PrintPackageEntity> }): React.JSX.Element {
    const e = p.ctx;

    return (
        <div>
            <AutoLine ctx={e.subCtx(f => f.name)} />
            <fieldset>
                <legend>{PrintLineEntity.nicePluralName()}</legend>
                <SearchControl findOptions={PrintLineEntity.findOptions(token => ({
                    filterOptions: [token(l => l.package).filter("EqualTo", e.value)],
                }))} />
            </fieldset>
        </div>
    );
}
