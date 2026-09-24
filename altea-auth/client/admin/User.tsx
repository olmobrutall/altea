import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { Finder } from "@altea/altea/client/Finder";
import { UserEntity, UserState } from "../../data/User";
import { RoleEntity } from "../../data/Role";
import ProfilePhoto from "../public/ProfilePhoto";
import { AuthAdminClient } from "./AuthAdminClient";

// Port of Signum.Authorization's Templates/User.tsx, with its layout — the photo column and the lines column —
// so an app's `overrideView` can anchor on the same elements Signum's did (the `row` whose first child is the
// `col-sm-3 d-flex` photo column, the `cultureInfo` line). Divergences: the DoublePassword editor is deferred
// (password changes go through the ChangePassword page, and initial passwords are seeded server-side), so
// `mustChangePassword` is a plain checkbox; the culture combo lists the CultureInfo query rather than the
// client's culture catalogue.
export default function User(p: { ctx: TypeContext<UserEntity> }): React.JSX.Element {

    const ctx = p.ctx.subCtx({
        labelColumns: { sm: 3 },
        readOnly: p.ctx.value.state == UserState.Deactivated ? true : undefined,
    });

    return (
        <div>
            <div className="row">
                <div className="col-sm-3 d-flex">
                    <div className="mx-auto mt-3">
                        <ProfilePhoto user={ctx.value} size={150} />
                    </div>
                </div>
                <div className="col-sm-8">
                    <AutoLine ctx={ctx.subCtx(e => e.state, { readOnly: true })} />
                    <AutoLine ctx={ctx.subCtx(e => e.userName)} readOnly={userNameReadonly(ctx.value) ? true : undefined} />
                    <div className="row">
                        <div className="offset-sm-3 col-sm-9">
                            <CheckboxLine ctx={ctx.subCtx(e => e.mustChangePassword)} inlineCheckbox />
                        </div>
                    </div>
                    <EntityLine ctx={ctx.subCtx(e => e.role)} onFind={() =>
                        Finder.findMany<RoleEntity>(RoleEntity).then(rs => {
                            if (rs == null)
                                return undefined;

                            if (rs.length == 1)
                                return rs[0];

                            return AuthAdminClient.API.trivialMergeRole(rs);
                        })} />

                    <AutoLine ctx={ctx.subCtx(e => e.email)} readOnly={emailReadonly(ctx.value) ? true : undefined} />
                    <EntityCombo ctx={ctx.subCtx(e => e.cultureInfo)} />
                </div>
            </div>
        </div>
    );
}

export let userNameReadonly: (user: UserEntity) => boolean = (user: UserEntity) => user.externalId != null;
export function setUserNameReadonlyFunction(newFunction: (user: UserEntity) => boolean): void {
    userNameReadonly = newFunction;
}

export let emailReadonly: (user: UserEntity) => boolean = (user: UserEntity) => user.externalId != null;
export function setEmailReadonlyFunction(newFunction: (user: UserEntity) => boolean): void {
    emailReadonly = newFunction;
}
