import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { TypeContext } from "@altea/altea/client/TypeContext";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import { ADGroupEntity } from "../data/ADGroup";
import { ActiveDirectoryUserModel } from "../data/ActiveDirectoryQueries";

// Port of Signum.Authorization.AzureAD's ADGroup/ADGroup.tsx — the group's name plus a count of the
// directory users in it (a live Microsoft Graph query, filtered by the `inGroup` column).

export default function ADGroup(p: { ctx: TypeContext<ADGroupEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    return (
        <div>
            <AutoLine ctx={ctx.subCtx(n => n.displayName)} />
            <SearchValueLine ctx={ctx} findOptions={{
                queryName: ActiveDirectoryUserModel,
                filterOptions: [{ token: "inGroup", value: ctx.value }],
            }} />
        </div>
    );
}
