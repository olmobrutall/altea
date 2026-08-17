import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { getEntityTypeHelpText, type PartEditorProps } from "@altea/altea-dashboard/client/Admin/PartEditor";
import { D3ChartScript } from "../../../data/ChartScript";
import { UserChartEntity } from "../../../data/UserChart";
import { CombinedUserChartPartEntity } from "../../../data/DashboardParts";

// Port of Signum's Signum.Chart/Dashboard/Admin/CombinedUserChartPart.tsx — pick the saved charts to combine
// (only Line / Columns can share an axis, so the picker filters by chart script) + the combined options.
// altea divergences: the owning dashboard arrives as a PROP (no findParentCtx — see PartEditor.tsx) and there
// is no IsQueryCached column (CachedQuery is deferred).

export default function CombinedUserChartPart(p: PartEditorProps<CombinedUserChartPartEntity>): React.JSX.Element {
    const ctx = p.smallMode ? p.ctx.subCtx({ formGroupStyle: "Basic" }) : p.ctx;
    const dashboardEntityType = p.dashboard?.entityType;

    return (
        <div>
            <EntityTable ctx={ctx.subCtx(cp => cp.userCharts)} columns={[
                {
                    property: e => e.userChart,
                    template: ectx =>
                        <EntityLine ctx={ectx.subCtx(e => e.userChart)} create={false}
                            findOptions={UserChartEntity.findOptions(token => ({
                                filterOptions: [
                                    token(a => a.chartScript.key).filter("IsIn", [D3ChartScript.Columns.key, D3ChartScript.Line.key]),
                                    ...(dashboardEntityType
                                        ? [token(a => a.entityType).filter("EqualTo", dashboardEntityType, { pinned: { active: "Checkbox_Checked" as const } })]
                                        : []),
                                ],
                            }))}
                            helpText={getEntityTypeHelpText(dashboardEntityType?.toString(), ectx.value.userChart?.entityType?.toString())}
                        />,
                    headerHtmlAttributes: { style: { width: "100%" } },
                },
            ]} />

            <div className="row">
                <div className={p.smallMode ? "col-12" : "col-sm-6"}>
                    <CheckboxLine ctx={ctx.subCtx(cp => cp.showData)} inlineCheckbox="block" />
                    <CheckboxLine ctx={ctx.subCtx(cp => cp.allowChangeShowData)} inlineCheckbox="block" />
                    <CheckboxLine ctx={ctx.subCtx(cp => cp.combinePinnedFiltersWithSameLabel)} inlineCheckbox="block" />
                    <CheckboxLine ctx={ctx.subCtx(cp => cp.useSameScale)} inlineCheckbox="block" />
                </div>
                <div className={p.smallMode ? "col-12" : "col-sm-6"}>
                    <AutoLine ctx={ctx.subCtx(cp => cp.minHeight)} formGroupStyle="Basic" />
                </div>
            </div>
        </div>
    );
}
