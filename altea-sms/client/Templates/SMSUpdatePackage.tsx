import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { SMSMessageEntity, type SMSUpdatePackageEntity } from "../../data/SMS";

// The package plus the messages whose status it re-checks.
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
