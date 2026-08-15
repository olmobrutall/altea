import { table } from "@altea/altea/server/table";
import type { int, uuid } from "@altea/altea/data/basics";
import type { ColumnOptionsMode, PaginationMode, RefreshMode, SystemTimeMode } from "@altea/altea/data/dynamicQueries";
import { UserAssetsImporter } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import type { IToXmlContext, IFromXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import { QueryTokenEmbedded, PinnedQueryFilterEmbedded } from "@altea/altea-user-assets/data/Queries";
import {
    UserQueryEntity, QueryFilterEmbedded, QueryColumnEmbedded, QueryOrderEmbedded,
    UserQueryEntity_CustomDrilldowns, SystemTimeEmbedded,
} from "../data/UserQuery";

// Port of Signum's UserQueryEntity.ToXml / FromXml (UserQueryEntity.cs). altea keeps this OFF the isomorphic
// entity (System.Xml is server-only) — it registers a (de)serializer with UserAssetsImporter. The XML shape
// (element/attribute names, the Spanish "Orden" order element) is preserved for round-trip compatibility.

const A = "@_"; // fast-xml-parser attribute prefix

export function registerUserQueryXml(): void {
    UserAssetsImporter.register<UserQueryEntity>({
        elementName: "UserQuery",
        create: () => new UserQueryEntity(),
        load: async guid => (await table(UserQueryEntity).filter(u => u.id == guid).toArray() as UserQueryEntity[])[0],
        save: async uq => { await (uq as unknown as { save(): Promise<void> }).save(); },
        toXml,
        fromXml,
    });
}

async function toXml(uq: UserQueryEntity, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const o: Record<string, unknown> = {};
    o[A + "DisplayName"] = uq.displayName;
    o[A + "Query"] = uq.query.key;
    if (uq.entityType != null) o[A + "EntityType"] = (await ctx.retrieveLite(uq.entityType)).cleanName;
    if (uq.owner != null) o[A + "Owner"] = uq.owner.key();
    if (uq.hideQuickLink) o[A + "HideQuickLink"] = true;
    if (uq.showTitleAsBreadcrumb) o[A + "ShowTitleAsBreadcrumb"] = true;
    if (uq.includeDefaultFilters != null) o[A + "IncludeDefaultFilters"] = uq.includeDefaultFilters;
    if (uq.appendFilters) o[A + "AppendFilters"] = true;
    if (uq.refreshMode !== "Auto") o[A + "RefreshMode"] = uq.refreshMode;
    if (uq.groupResults) o[A + "GroupResults"] = true;
    if (uq.elementsPerPage != null) o[A + "ElementsPerPage"] = uq.elementsPerPage;
    if (uq.paginationMode != null) o[A + "PaginationMode"] = uq.paginationMode;
    o[A + "ColumnsMode"] = uq.columnsMode;

    if (uq.filters?.length) o["Filters"] = { Filter: uq.filters.map(filterXml) };
    if (uq.columns?.length) o["Columns"] = { Column: uq.columns.map(columnXml) };
    if (uq.orders?.length) o["Orders"] = { Orden: uq.orders.map(orderXml) };
    if (uq.systemTime != null) o["SystemTime"] = systemTimeXml(uq.systemTime);

    if (uq.customDrilldowns?.length) {
        const list: Record<string, unknown>[] = [];
        for (const d of uq.customDrilldowns) {
            const target = await ctx.retrieveLite(d.drilldown);
            list.push({ "#text": ctx.include(target) });
        }
        o["CustomDrilldowns"] = { CustomDrilldown: list };
    }
    return o;
}

function filterXml(f: QueryFilterEmbedded): Record<string, unknown> {
    const x: Record<string, unknown> = {};
    x[A + "Indentation"] = f.indentation;
    if (f.isGroup) {
        x[A + "GroupOperation"] = f.groupOperation;
        if (f.token != null) x[A + "Token"] = f.token.tokenString;
    } else {
        if (f.token != null) x[A + "Token"] = f.token.tokenString;
        x[A + "Operation"] = f.operation;
        if (f.valueString != null) x[A + "Value"] = f.valueString;
    }
    if (f.dashboardBehaviour != null) x[A + "DashboardBehaviour"] = f.dashboardBehaviour;
    if (f.pinned != null) x["Pinned"] = pinnedXml(f.pinned);
    return x;
}

function pinnedXml(p: PinnedQueryFilterEmbedded): Record<string, unknown> {
    const x: Record<string, unknown> = {};
    if (p.label != null) x[A + "Label"] = p.label;
    if (p.column != null) x[A + "Column"] = p.column;
    if (p.colSpan != null) x[A + "ColSpan"] = p.colSpan;
    if (p.row != null) x[A + "Row"] = p.row;
    if (p.active !== "Always") x[A + "Active"] = p.active;
    if (p.splitValue) x[A + "SplitValue"] = true;
    return x;
}

function columnXml(c: QueryColumnEmbedded): Record<string, unknown> {
    const x: Record<string, unknown> = {};
    x[A + "Token"] = c.token.tokenString;
    if (c.summaryToken != null) x[A + "SummaryToken"] = c.summaryToken.tokenString;
    if (c.displayName != null) x[A + "DisplayName"] = c.displayName;
    if (c.hiddenColumn) x[A + "HiddenColumn"] = true;
    if (c.combineRows != null) x[A + "CombineRows"] = c.combineRows;
    return x;
}

function orderXml(o: QueryOrderEmbedded): Record<string, unknown> {
    return { [A + "Token"]: o.token.tokenString, [A + "OrderType"]: o.orderType };
}

function systemTimeXml(st: SystemTimeEmbedded): Record<string, unknown> {
    const x: Record<string, unknown> = { [A + "Mode"]: st.mode };
    if (st.startDate != null) x[A + "StartDate"] = st.startDate;
    if (st.endDate != null) x[A + "EndDate"] = st.endDate;
    if (st.joinMode != null) x[A + "JoinMode"] = st.joinMode;
    if (st.timeSeriesUnit != null) x[A + "TimeSeriesUnit"] = st.timeSeriesUnit;
    if (st.timeSeriesStep != null) x[A + "TimeSeriesStep"] = st.timeSeriesStep;
    if (st.timeSeriesMaxRowsPerStep != null) x[A + "TimeSeriesMaxRowsPerStep"] = st.timeSeriesMaxRowsPerStep;
    if (st.splitQueries) x[A + "SplitQueries"] = true;
    return x;
}

// ---- FromXml -------------------------------------------------------------------------------------------

function fromXml(uq: UserQueryEntity, xml: Record<string, unknown>, ctx: IFromXmlContext): void {
    uq.query = ctx.getQuery(str(xml[A + "Query"])!);
    uq.displayName = str(xml[A + "DisplayName"]) ?? "";
    uq.entityType = xml[A + "EntityType"] != null ? ctx.getType(str(xml[A + "EntityType"])!) : null;
    uq.owner = xml[A + "Owner"] != null ? (ctx.parseLite(str(xml[A + "Owner"])!) ?? null) : null;
    uq.hideQuickLink = bool(xml[A + "HideQuickLink"]);
    uq.showTitleAsBreadcrumb = bool(xml[A + "ShowTitleAsBreadcrumb"]);
    uq.includeDefaultFilters = xml[A + "IncludeDefaultFilters"] != null ? bool(xml[A + "IncludeDefaultFilters"]) : null;
    uq.appendFilters = bool(xml[A + "AppendFilters"]);
    uq.refreshMode = (str(xml[A + "RefreshMode"]) as RefreshMode) ?? "Auto";
    uq.groupResults = bool(xml[A + "GroupResults"]);
    uq.elementsPerPage = xml[A + "ElementsPerPage"] != null ? (Number(xml[A + "ElementsPerPage"]) as int) : null;
    uq.paginationMode = (str(xml[A + "PaginationMode"]) as PaginationMode) ?? null;
    uq.columnsMode = normalizeColumnsMode(str(xml[A + "ColumnsMode"]));

    uq.filters = arr(xml["Filters"], "Filter").map(filterFromXml);
    uq.columns = arr(xml["Columns"], "Column").map(columnFromXml);
    uq.orders = arr(xml["Orders"], "Orden").map(orderFromXml);
    uq.customDrilldowns = arr(xml["CustomDrilldowns"], "CustomDrilldown").map(d => {
        const row = new UserQueryEntity_CustomDrilldowns();
        const guid = str((d as Record<string, unknown>)["#text"] ?? d);
        row.drilldown = (ctx.getEntity(guid!) as UserQueryEntity).toLite();
        return row;
    });

    const st = xml["SystemTime"];
    uq.systemTime = st != null ? systemTimeFromXml(firstElem(st)) : null;
}

function filterFromXml(x: Record<string, unknown>): QueryFilterEmbedded {
    const f = new QueryFilterEmbedded();
    f.indentation = (Number(x[A + "Indentation"] ?? 0) as int);
    f.isGroup = x[A + "GroupOperation"] != null;
    if (f.isGroup) {
        f.groupOperation = str(x[A + "GroupOperation"]) as QueryFilterEmbedded["groupOperation"];
        f.token = x[A + "Token"] != null ? token(str(x[A + "Token"])!) : null;
    } else {
        f.token = x[A + "Token"] != null ? token(str(x[A + "Token"])!) : null;
        f.operation = str(x[A + "Operation"]) as QueryFilterEmbedded["operation"];
        f.valueString = str(x[A + "Value"]) ?? null;
    }
    f.dashboardBehaviour = str(x[A + "DashboardBehaviour"]) as QueryFilterEmbedded["dashboardBehaviour"] ?? null;
    const p = x["Pinned"];
    f.pinned = p != null ? pinnedFromXml(firstElem(p)) : null;
    return f;
}

function pinnedFromXml(x: Record<string, unknown>): PinnedQueryFilterEmbedded {
    const p = new PinnedQueryFilterEmbedded();
    p.label = str(x[A + "Label"]) ?? null;
    p.column = x[A + "Column"] != null ? (Number(x[A + "Column"]) as int) : null;
    p.colSpan = x[A + "ColSpan"] != null ? (Number(x[A + "ColSpan"]) as int) : null;
    p.row = x[A + "Row"] != null ? (Number(x[A + "Row"]) as int) : null;
    p.active = (str(x[A + "Active"]) as PinnedQueryFilterEmbedded["active"]) ?? "Always";
    p.splitValue = bool(x[A + "SplitValue"]);
    return p;
}

function columnFromXml(x: Record<string, unknown>): QueryColumnEmbedded {
    const c = new QueryColumnEmbedded();
    c.token = token(str(x[A + "Token"])!);
    c.summaryToken = x[A + "SummaryToken"] != null ? token(str(x[A + "SummaryToken"])!) : null;
    c.displayName = str(x[A + "DisplayName"]) ?? null;
    c.hiddenColumn = bool(x[A + "HiddenColumn"]);
    c.combineRows = str(x[A + "CombineRows"]) as QueryColumnEmbedded["combineRows"] ?? null;
    return c;
}

function orderFromXml(x: Record<string, unknown>): QueryOrderEmbedded {
    const o = new QueryOrderEmbedded();
    o.token = token(str(x[A + "Token"])!);
    o.orderType = (str(x[A + "OrderType"]) as QueryOrderEmbedded["orderType"]) ?? "Ascending";
    return o;
}

function systemTimeFromXml(x: Record<string, unknown>): SystemTimeEmbedded {
    const st = new SystemTimeEmbedded();
    st.mode = (str(x[A + "Mode"]) as SystemTimeMode) ?? "AsOf";
    st.startDate = str(x[A + "StartDate"]) ?? null;
    st.endDate = str(x[A + "EndDate"]) ?? null;
    st.joinMode = str(x[A + "JoinMode"]) as SystemTimeEmbedded["joinMode"] ?? null;
    st.timeSeriesUnit = str(x[A + "TimeSeriesUnit"]) as SystemTimeEmbedded["timeSeriesUnit"] ?? null;
    st.timeSeriesStep = x[A + "TimeSeriesStep"] != null ? (Number(x[A + "TimeSeriesStep"]) as int) : null;
    st.timeSeriesMaxRowsPerStep = x[A + "TimeSeriesMaxRowsPerStep"] != null ? (Number(x[A + "TimeSeriesMaxRowsPerStep"]) as int) : null;
    st.splitQueries = bool(x[A + "SplitQueries"]);
    return st;
}

// ---- small helpers -------------------------------------------------------------------------------------

function token(tokenString: string): QueryTokenEmbedded {
    const t = new QueryTokenEmbedded();
    t.tokenString = tokenString;
    return t;
}

// Signum's legacy "Replace" → "ReplaceAll" remap.
function normalizeColumnsMode(v: string | undefined): ColumnOptionsMode {
    return ((v === "Replace" ? "ReplaceAll" : v) as ColumnOptionsMode) ?? "Add";
}

function str(v: unknown): string | undefined {
    return v == null ? undefined : String(v);
}
function bool(v: unknown): boolean {
    return v === true || v === "true" || v === "True";
}
// A parsed element with isArray:()=>true is always an array; take the first.
function firstElem(v: unknown): Record<string, unknown> {
    return (Array.isArray(v) ? v[0] : v) as Record<string, unknown>;
}
// Read the child list `childName` out of a wrapper element `wrapper` (both parsed as arrays).
function arr(wrapper: unknown, childName: string): Record<string, unknown>[] {
    if (wrapper == null) return [];
    const w = firstElem(wrapper);
    const list = w?.[childName];
    return (Array.isArray(list) ? list : list != null ? [list] : []) as Record<string, unknown>[];
}
