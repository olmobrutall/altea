import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { getEntityTypeHelpText, type PartEditorProps } from "@altea/altea-dashboard/client/Admin/PartEditor";
import { UserQueryEntity } from "../../../data/UserQuery";
import { UserQueryPartEntity } from "../../../data/DashboardParts";

// Port of Signum's Signum.UserQueries/Dashboard/Admin/UserQueryPart.tsx. altea divergences: the owning
// dashboard arrives as a PROP (no findParentCtx — see PartEditor.tsx) and there is no IsQueryCached line
// (CachedQuery is deferred).

export default function UserQueryPart(p: PartEditorProps<UserQueryPartEntity>): React.JSX.Element {
    const ctx = p.ctx.subCtx({ formGroupStyle: "Basic" });
    const forceUpdate = useForceUpdate();
    const dashboardEntityType = p.dashboard?.entityType;

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(up => up.userQuery)} create={false}
                findOptions={dashboardEntityType ? UserQueryEntity.findOptions(token => ({
                    filterOptions: [token(a => a.entityType).filter("EqualTo", dashboardEntityType, { pinned: { active: "Checkbox_Checked" } })],
                })) : undefined}
                helpText={getEntityTypeHelpText(dashboardEntityType?.toString(), ctx.value.userQuery?.entityType?.toString())}
                onChange={forceUpdate} />
            <div className="row">
                <div className={p.smallMode ? "col-12" : "col-sm-5"}>
                    <CheckboxLine ctx={ctx.subCtx(up => up.allowSelection)} inlineCheckbox="block" />
                    <CheckboxLine ctx={ctx.subCtx(up => up.showFooter)} inlineCheckbox="block" />
                    <CheckboxLine ctx={ctx.subCtx(up => up.createNew)} inlineCheckbox="block" />
                    <CheckboxLine ctx={ctx.subCtx(up => up.allowMaxHeight)} inlineCheckbox="block" />
                </div>
                <div className={p.smallMode ? "col-12" : "col-sm-7"}>
                    <AutoLine ctx={ctx.subCtx(up => up.autoUpdate)} />
                </div>
            </div>
        </div>
    );
}
