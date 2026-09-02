import * as React from "react";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { ToolbarMenuPartEntity } from "../../data/Parts";

// Port of Signum's Signum.Dashboard/Admin/ToolbarMenuPart.tsx — the part's editor, which is just the
// menu picker. `SrOnly` + placeholder labels because the grid cell it renders in is small and the label
// would cost more room than it earns.

export default function ToolbarMenuPart(p: { ctx: TypeContext<ToolbarMenuPartEntity> }): React.JSX.Element {
    const ctx = p.ctx.subCtx({ formGroupStyle: "SrOnly", placeholderLabels: true });

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(a => a.toolbarMenu)} />
        </div>
    );
}
