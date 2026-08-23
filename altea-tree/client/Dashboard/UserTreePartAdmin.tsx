import * as React from "react";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { UserTreePartEntity } from "../../data/Tree";

// Port of Signum.Tree's Dashboard/Admin/UserTreePart.tsx — the part's editor.
export default function UserTreePartAdmin(p: { ctx: TypeContext<UserTreePartEntity> }): React.JSX.Element {
    return <EntityLine ctx={p.ctx.subCtx(a => a.userQuery)} />;
}
