import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { UserEntity } from "./User.data";

// Port of Signum's Templates/User.tsx (Templates/User.tsx), trimmed for altea. Divergences: the
// DoublePassword control + ProfilePhoto + CultureInfo picker are deferred (DoublePassword mutates
// TypeContext/frame internals that differ in altea; password changes go through the ChangePassword
// page, and initial passwords are seeded server-side for now). This is the admin edit view for a user's
// core fields.
export default function User(p: { ctx: TypeContext<UserEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    return (
        <div>
            <AutoLine ctx={ctx.subCtx(u => u.userName)} />
            <EntityLine ctx={ctx.subCtx(u => u.role)} />
            <AutoLine ctx={ctx.subCtx(u => u.email)} />
            <AutoLine ctx={ctx.subCtx(u => u.state)} />
            <AutoLine ctx={ctx.subCtx(u => u.mustChangePassword)} />
        </div>
    );
}
