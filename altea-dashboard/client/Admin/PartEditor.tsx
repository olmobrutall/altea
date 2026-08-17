import * as React from "react";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { DashboardEntity, DashboardMessage } from "../../data/Dashboard";

// altea's counterpart of Signum's Signum.Dashboard/Admin/EntityTypeRelatedHelpText.tsx, plus the shared prop
// shape of a part EDITOR component. It is a separate module (not part of Admin/Dashboard.tsx) so the part
// editors of other modules — @altea/altea-user-queries, @altea/altea-chart — import these two without
// pulling in the whole dashboard editor.
//
// altea divergence: Signum's part editors reached the owning dashboard with
// `ctx.findParentCtx(DashboardEntity)`. altea's TypeContext has no parent-context lookup, so the dashboard
// travels down as a PROP — Admin/Dashboard.tsx passes it through RenderEntity's `extraProps` (exactly the
// channel Signum already used for `smallMode`).

export interface PartEditorProps<T> {
    ctx: TypeContext<T>;
    /** The dashboard the part belongs to (passed by DashboardPart via RenderEntity extraProps). */
    dashboard?: DashboardEntity;
    /** True when the grid cell is too narrow for the wide layout (Signum's smallMode). */
    smallMode?: boolean;
}

/**
 * A part editor's helpText when the part's own entity type may not match the dashboard's
 * (Signum's getEntityTypeHelpText).
 *
 *  - undefined:     no issue (both null, or they match)
 *  - text-warning:  the dashboard is entity-scoped but the picked asset is global (not filtered by it)
 *  - text-danger:   the picked asset is scoped to a DIFFERENT entity type
 */
export function getEntityTypeHelpText(
    dashboardEntityTypeName: string | null | undefined,
    selectedEntityTypeName: string | null | undefined,
): React.ReactElement | undefined {

    if ((dashboardEntityTypeName ?? null) === (selectedEntityTypeName ?? null))
        return undefined;

    if (dashboardEntityTypeName != null && selectedEntityTypeName == null)
        return <span className="text-warning">{DashboardMessage.NotFilteringBy0.niceToString(dashboardEntityTypeName)}</span>;

    return <span className="text-danger">{DashboardMessage.IncompatibleEntityType.niceToString()}</span>;
}
