import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityStrip } from "@altea/altea/client/Lines/EntityStrip";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import { TypeContext } from "@altea/altea/client/TypeContext";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import { RoleEntity } from "./Role.data";
import { UserEntity } from "./User.data";

// Port of Signum's Templates/Role.tsx, trimmed for altea. The rule-pack entry points (Type / Permission
// rules) are QuickLinks on the frame (registered in AuthAdminClient), like Signum — NOT a button here.
// The "Referenced by" section shows SearchValueLines: the users in this role, and the roles that inherit
// from it (Signum's `inheritsFrom.any()` filter — altea's inheritsFrom is the RoleEntity_InheritsFrom
// junction array, so the token navigates `.any().append(x => x.inheritsFrom)` to the inherited role).
export default function Role(p: { ctx: TypeContext<RoleEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    return (
        <div>
            <AutoLine ctx={ctx.subCtx(r => r.name)} />
            <AutoLine ctx={ctx.subCtx(r => r.mergeStrategy)} />
            <AutoLine ctx={ctx.subCtx(r => r.isTrivialMerge)} />
            <EntityStrip ctx={ctx.subCtx(r => r.inheritsFrom)} />
            <TextAreaLine ctx={ctx.subCtx(r => r.description)} />

            {!ctx.value.isNew && <>
                <h4 className="lead mt-4">Referenced by</h4>
                <SearchValueLine ctx={ctx} findOptions={UserEntity.findOptions(token => ({
                    filterOptions: [token(u => u.role).filter("EqualTo", ctx.value)],
                }))} />
                <SearchValueLine ctx={ctx} findOptions={RoleEntity.findOptions(token => ({
                    filterOptions: [token(a => a.inheritsFrom).any().append(x => x.inheritsFrom).filter("EqualTo", ctx.value)],
                }))} />
            </>}
        </div>
    );
}
