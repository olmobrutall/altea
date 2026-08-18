import { DashboardLogic } from "@altea/altea-dashboard/server/DashboardLogic.server";
import { type int } from "@altea/altea/data/basics";
import { CombinedUserChartPartEntity_UserChart, CombinedUserChartPartEntity, UserChartPartEntity } from "../data/DashboardParts";
import { UserChartEntity } from "../data/UserChart";

// Port of the ToXml / FromXml / Clone members Signum declares ON UserChartPartEntity (Signum.Chart/UserChart/
// UserChart.cs) plus the `PartNames` entry its UserChartLogic registered inside
// `sb.Schema.WhenIncluded<DashboardEntity>`. altea keeps XML off the isomorphic entities, so the part
// registers here with @altea/altea-dashboard's part registry (element name preserved for round-trip
// compatibility with Signum-exported dashboards).
//
// altea divergence: the `IsQueryCached` attributes are neither written nor read (CachedQuery is not ported —
// see data/DashboardParts.ts).

const A = "@_";

export function registerUserChartDashboardParts(): void {

    DashboardLogic.registerPart<UserChartPartEntity>({
        type: UserChartPartEntity,
        elementName: "UserChartPart",
        clone: p => {
            const c = new UserChartPartEntity();
            c.userChart = p.userChart;
            c.showData = p.showData;
            c.allowChangeShowData = p.allowChangeShowData;
            c.createNew = p.createNew;
            c.autoRefresh = p.autoRefresh;
            c.minHeight = p.minHeight;
            return c;
        },
        toXml: (p, ctx) => {
            const x: Record<string, unknown> = { [A + "UserChart"]: ctx.include(p.userChart) };
            if (p.showData) x[A + "ShowData"] = true;
            if (p.allowChangeShowData) x[A + "AllowChangeShowData"] = true;
            if (p.createNew) x[A + "CreateNew"] = true;
            if (p.autoRefresh) x[A + "AutoRefresh"] = true;
            if (p.minHeight != null) x[A + "MinHeight"] = p.minHeight;
            return x;
        },
        fromXml: (p, x, ctx) => {
            p.userChart = ctx.getEntity(String(x[A + "UserChart"])) as UserChartEntity;
            p.showData = bool(x[A + "ShowData"]);
            p.allowChangeShowData = bool(x[A + "AllowChangeShowData"]);
            p.createNew = bool(x[A + "CreateNew"]);
            p.autoRefresh = bool(x[A + "AutoRefresh"]);
            p.minHeight = x[A + "MinHeight"] == null ? null : (Number(x[A + "MinHeight"]) as int);
        },
    });

    // Signum's CombinedUserChartPartEntity.ToXml/FromXml: the options as attributes + one <UserChart Guid="…"/>
    // child per combined chart (Signum also wrote each element's IsQueryCached — not ported).
    DashboardLogic.registerPart<CombinedUserChartPartEntity>({
        type: CombinedUserChartPartEntity,
        elementName: "CombinedUserChartPart",
        clone: p => {
            const c = new CombinedUserChartPartEntity();
            c.userCharts = (p.userCharts ?? []).map(e => {
                const row = new CombinedUserChartPartEntity_UserChart();
                row.userChart = e.userChart;
                row.order = e.order;
                return row;
            });
            c.showData = p.showData;
            c.allowChangeShowData = p.allowChangeShowData;
            c.combinePinnedFiltersWithSameLabel = p.combinePinnedFiltersWithSameLabel;
            c.useSameScale = p.useSameScale;
            c.minHeight = p.minHeight;
            return c;
        },
        toXml: (p, ctx) => {
            const x: Record<string, unknown> = {};
            if (p.showData) x[A + "ShowData"] = true;
            if (p.allowChangeShowData) x[A + "AllowChangeShowData"] = true;
            if (p.combinePinnedFiltersWithSameLabel) x[A + "CombinePinnedFiltersWithSameLabel"] = true;
            if (p.useSameScale) x[A + "UseSameScale"] = true;
            if (p.minHeight != null) x[A + "MinHeight"] = p.minHeight;
            x["UserChart"] = (p.userCharts ?? []).map(e => ({ [A + "Guid"]: ctx.include(e.userChart) }));
            return x;
        },
        fromXml: (p, x, ctx) => {
            p.showData = bool(x[A + "ShowData"]);
            p.allowChangeShowData = bool(x[A + "AllowChangeShowData"]);
            p.combinePinnedFiltersWithSameLabel = bool(x[A + "CombinePinnedFiltersWithSameLabel"]);
            p.useSameScale = bool(x[A + "UseSameScale"]);
            p.minHeight = x[A + "MinHeight"] == null ? null : (Number(x[A + "MinHeight"]) as int);
            p.userCharts = list(x["UserChart"]).map((e, i) => {
                const row = new CombinedUserChartPartEntity_UserChart();
                row.order = i as unknown as int;
                row.userChart = ctx.getEntity(String(e[A + "Guid"])) as UserChartEntity;
                return row;
            });
        },
    });
}

function list(v: unknown): Record<string, unknown>[] {
    return (Array.isArray(v) ? v : v != null ? [v] : []) as Record<string, unknown>[];
}

function bool(v: unknown): boolean {
    return v === true || v === "true" || v === "True";
}
