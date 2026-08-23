import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { SMSMessageEntity, type SMSSendPackageEntity } from "../../data/SMS";

// Port of Signum.SMS's Templates/SMSSendPackage.tsx — the package plus the messages it holds.
export default function SMSSendPackage(p: { ctx: TypeContext<SMSSendPackageEntity> }): React.JSX.Element {
    return (
        <div>
            <AutoLine ctx={p.ctx.subCtx(a => a.name)} />
            <SearchControl findOptions={SMSMessageEntity.findOptions(token => ({
                filterOptions: [{ token: token(a => a.sendPackage), value: p.ctx.value }],
            }))} />
        </div>
    );
}
