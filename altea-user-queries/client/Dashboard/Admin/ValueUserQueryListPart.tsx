import * as React from "react";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import type { PartEditorProps } from "@altea/altea-dashboard/client/Admin/PartEditor";
import { ValueUserQueryListPartEntity } from "../../../data/DashboardParts";

// Port of Signum's Signum.UserQueries/Dashboard/Admin/ValueUserQueryListPart.tsx (minus the IsQueryCached
// column — CachedQuery is deferred in altea).

export default function ValueUserQueryListPart(p: PartEditorProps<ValueUserQueryListPartEntity>): React.JSX.Element {
    const ctx = p.ctx;

    return (
        <div>
            <EntityTable ctx={ctx.subCtx(vp => vp.userQueries)} columns={[
                {
                    property: e => e.userQuery,
                    headerHtmlAttributes: { style: { width: "35%" } },
                },
                {
                    property: e => e.label,
                },
                {
                    property: e => e.href,
                },
            ]} />
        </div>
    );
}
