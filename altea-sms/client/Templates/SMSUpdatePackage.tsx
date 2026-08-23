import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { SMSMessageEntity, type SMSUpdatePackageEntity } from "../../data/SMS";

// Port of Signum.SMS's Templates/SMSUpdatePackage.tsx.
export default function SMSUpdatePackage(p: { ctx: TypeContext<SMSUpdatePackageEntity> }): React.JSX.Element {
    return (
        <div>
            <AutoLine ctx={p.ctx.subCtx(a => a.name)} />
            <SearchControl findOptions={SMSMessageEntity.findOptions(token => ({
                filterOptions: [{ token: token(a => a.updatePackage), value: p.ctx.value }],
            }))} />
        </div>
    );
}
