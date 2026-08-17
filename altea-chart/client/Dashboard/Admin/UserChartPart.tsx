import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { getEntityTypeHelpText, type PartEditorProps } from "@altea/altea-dashboard/client/Admin/PartEditor";
import { UserChartEntity } from "../../../data/UserChart";
import { UserChartPartEntity } from "../../../data/DashboardParts";

// Port of Signum's Signum.Chart/Dashboard/Admin/UserChartPart.tsx. altea divergences: the owning dashboard
// arrives as a PROP (no findParentCtx — see PartEditor.tsx), and there is no IsQueryCached line (CachedQuery is
// not ported — see data/DashboardParts.ts).

export default function UserChartPart(p: PartEditorProps<UserChartPartEntity>): React.JSX.Element {
    const ctx = p.smallMode ? p.ctx.subCtx({ formGroupStyle: "Basic" }) : p.ctx;
    const forceUpdate = useForceUpdate();
    const dashboardEntityType = p.dashboard?.entityType;

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(cp => cp.userChart)} create={false}
                findOptions={dashboardEntityType ? UserChartEntity.findOptions(token => ({
                    filterOptions: [token(a => a.entityType).filter("EqualTo", dashboardEntityType, { pinned: { active: "Checkbox_Checked" } })],
                })) : undefined}
                helpText={getEntityTypeHelpText(dashboardEntityType?.toString(), ctx.value.userChart?.entityType?.toString())}
                onChange={forceUpdate} />

            <div className="row">
                <div className={p.smallMode ? "col-12" : "col-sm-6"}>
                    <CheckboxLine ctx={ctx.subCtx(cp => cp.showData)} inlineCheckbox="block" />
                    <CheckboxLine ctx={ctx.subCtx(cp => cp.allowChangeShowData)} inlineCheckbox="block" />
                    <CheckboxLine ctx={ctx.subCtx(cp => cp.createNew)} inlineCheckbox="block" />
                    <CheckboxLine ctx={ctx.subCtx(cp => cp.autoRefresh)} inlineCheckbox="block" />
                </div>
                <div className={p.smallMode ? "col-12" : "col-sm-6"}>
                    <AutoLine ctx={ctx.subCtx(cp => cp.minHeight)} formGroupStyle="Basic" />
                </div>
            </div>
        </div>
    );
}
