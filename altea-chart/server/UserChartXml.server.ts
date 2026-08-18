import { table } from "@altea/altea/server/table";
import type { int } from "@altea/altea/data/basics";
import type { OrderType } from "@altea/altea/data/dynamicQueries";
import { Enum } from "@altea/altea/data/enum";
import {
    FilterGroupOperationEnum, FilterOperationEnum, DashboardBehaviourEnum, PinnedFilterActiveEnum,
} from "@altea/altea/data/dynamicQueries";
import { UserAssetsImporter } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import type { IToXmlContext, IFromXmlContext } from "@altea/altea-user-assets/server/UserAssetsImportExport.server";
import { QueryTokenEmbedded, PinnedQueryFilterEmbedded } from "@altea/altea-user-assets/data/Queries";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import {
    UserChartEntity, UserChartEntity_Filters, UserChartEntity_Columns, UserChartEntity_Parameters,
    UserChartEntity_CustomDrilldowns,
} from "../data/UserChart";
import { ChartColumnEmbedded } from "../data/ChartColumn";
import { ChartParameterEmbedded } from "../data/ChartParameter";
import { ChartScriptSymbol, D3ChartScript, HtmlChartScript, SvgMapsChartScript, GoogleMapsChartScript } from "../data/ChartScript";

// Port of Signum's UserChartEntity.ToXml / FromXml (Signum.Chart/UserChart/UserChart.cs). altea keeps this
// OFF the isomorphic entity (System.Xml is server-only) — it registers a (de)serializer with
// UserAssetsImporter. The XML shape (element/attribute names) is preserved for round-trip compatibility.
// Mirrors UserQueriesXml.server.ts. (Signum's UserChart XML does NOT include ChartTimeSeries — omitted here
// too.)

const A = "@_"; // fast-xml-parser attribute prefix

export function registerUserChartXml(): void {
    UserAssetsImporter.register<UserChartEntity>({
        elementName: "UserChart",
        create: () => new UserChartEntity(),
        load: async guid => (await table(UserChartEntity).filter(u => u.id == guid).toArray() as UserChartEntity[])[0],
        save: async uc => { await (uc as unknown as { save(): Promise<void> }).save(); },
        toXml,
        fromXml,
    });
}

async function toXml(uc: UserChartEntity, ctx: IToXmlContext): Promise<Record<string, unknown>> {
    const o: Record<string, unknown> = {};
    o[A + "DisplayName"] = uc.displayName;
    o[A + "Query"] = uc.query.key;
    if (uc.entityType != null) o[A + "EntityType"] = (await ctx.retrieveLite(uc.entityType)).cleanName;
    o[A + "HideQuickLink"] = uc.hideQuickLink;
    if (uc.owner != null) o[A + "Owner"] = uc.owner.key();
    if (uc.includeDefaultFilters != null) o[A + "IncludeDefaultFilters"] = uc.includeDefaultFilters;
    o[A + "ChartScript"] = uc.chartScript.key;
    if (uc.maxRows != null) o[A + "MaxRows"] = uc.maxRows;

    if (uc.filters?.length) o["Filters"] = { Filter: uc.filters.map(filterXml) };
    o["Columns"] = { Column: (uc.columns ?? []).map(c => columnXml(c.element)) };
    if (uc.parameters?.length) o["Parameters"] = { Parameter: uc.parameters.map(p => parameterXml(p.element)) };

    if (uc.customDrilldowns?.length) {
        const list: Record<string, unknown>[] = [];
        for (const d of uc.customDrilldowns) {
            const target = await ctx.retrieveLite(d.drilldown);
            list.push({ "#text": ctx.include(target) });
        }
        o["CustomDrilldowns"] = { CustomDrilldown: list };
    }
    return o;
}

function filterXml(f: UserChartEntity_Filters): Record<string, unknown> {
    const x: Record<string, unknown> = {};
    x[A + "Indentation"] = f.indentation;
    if (f.isGroup) {
        if (f.groupOperation != null) x[A + "GroupOperation"] = Enum.toName(FilterGroupOperationEnum, f.groupOperation);
        if (f.token != null) x[A + "Token"] = f.token.tokenString;
    } else {
        if (f.token != null) x[A + "Token"] = f.token.tokenString;
        if (f.operation != null) x[A + "Operation"] = Enum.toName(FilterOperationEnum, f.operation);
        if (f.valueString != null) x[A + "Value"] = f.valueString;
    }
    if (f.dashboardBehaviour != null) x[A + "DashboardBehaviour"] = Enum.toName(DashboardBehaviourEnum, f.dashboardBehaviour);
    if (f.pinned != null) x["Pinned"] = pinnedXml(f.pinned);
    return x;
}

function pinnedXml(p: PinnedQueryFilterEmbedded): Record<string, unknown> {
    const x: Record<string, unknown> = {};
    if (p.label != null) x[A + "Label"] = p.label;
    if (p.column != null) x[A + "Column"] = p.column;
    if (p.colSpan != null) x[A + "ColSpan"] = p.colSpan;
    if (p.row != null) x[A + "Row"] = p.row;
    const active = Enum.toName(PinnedFilterActiveEnum, p.active);
    if (active !== "Always") x[A + "Active"] = active;
    if (p.splitValue) x[A + "SplitValue"] = true;
    return x;
}

function columnXml(c: ChartColumnEmbedded): Record<string, unknown> {
    const x: Record<string, unknown> = {};
    if (c.token != null) x[A + "Token"] = c.token.tokenString;
    if (c.displayName != null) x[A + "DisplayName"] = c.displayName;
    if (c.format != null) x[A + "Format"] = c.format;
    if (c.orderByIndex != null) x[A + "OrderByIndex"] = c.orderByIndex;
    if (c.orderByType != null) x[A + "OrderByType"] = c.orderByType;
    return x;
}

function parameterXml(p: ChartParameterEmbedded): Record<string, unknown> {
    const x: Record<string, unknown> = { [A + "Name"]: p.name };
    if (p.value != null) x[A + "Value"] = p.value;
    return x;
}

// ---- FromXml -------------------------------------------------------------------------------------------

function fromXml(uc: UserChartEntity, xml: Record<string, unknown>, ctx: IFromXmlContext): void {
    uc.displayName = str(xml[A + "DisplayName"]) ?? "";
    uc.query = ctx.getQuery(str(xml[A + "Query"])!);
    uc.entityType = xml[A + "EntityType"] != null ? ctx.getType(str(xml[A + "EntityType"])!) : null;
    uc.hideQuickLink = bool(xml[A + "HideQuickLink"]);
    uc.owner = xml[A + "Owner"] != null ? (ctx.parseLite(str(xml[A + "Owner"])!) ?? null) : null;
    uc.includeDefaultFilters = xml[A + "IncludeDefaultFilters"] != null ? bool(xml[A + "IncludeDefaultFilters"]) : null;
    uc.chartScript = resolveChartScript(str(xml[A + "ChartScript"])!);
    uc.maxRows = xml[A + "MaxRows"] != null ? (Number(xml[A + "MaxRows"]) as int) : null;

    uc.filters = arr(xml["Filters"], "Filter").map(filterFromXml);
    uc.columns = arr(xml["Columns"], "Column").map(x => {
        const row = new UserChartEntity_Columns();
        row.element = columnFromXml(x);
        return row;
    });
    uc.parameters = arr(xml["Parameters"], "Parameter").map(x => {
        const row = new UserChartEntity_Parameters();
        row.element = parameterFromXml(x);
        return row;
    });
    uc.customDrilldowns = arr(xml["CustomDrilldowns"], "CustomDrilldown").map(d => {
        const row = new UserChartEntity_CustomDrilldowns();
        const guid = str((d as Record<string, unknown>)["#text"] ?? d);
        row.drilldown = (ctx.getEntity(guid!) as UserQueryEntity).toLite();
        return row;
    });
}

function filterFromXml(x: Record<string, unknown>): UserChartEntity_Filters {
    const f = new UserChartEntity_Filters();
    f.indentation = (Number(x[A + "Indentation"] ?? 0) as int);
    f.isGroup = x[A + "GroupOperation"] != null;
    if (f.isGroup) {
        const groupOperation = str(x[A + "GroupOperation"]);
        f.groupOperation = groupOperation == null ? null : toEnum(FilterGroupOperationEnum, groupOperation);
        f.token = x[A + "Token"] != null ? token(str(x[A + "Token"])!) : null;
    } else {
        f.token = x[A + "Token"] != null ? token(str(x[A + "Token"])!) : null;
        const operation = str(x[A + "Operation"]);
        f.operation = operation == null ? null : toEnum(FilterOperationEnum, operation);
        f.valueString = str(x[A + "Value"]) ?? null;
    }
    const dashboardBehaviour = str(x[A + "DashboardBehaviour"]);
    f.dashboardBehaviour = dashboardBehaviour == null ? null : toEnum(DashboardBehaviourEnum, dashboardBehaviour);
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
    p.active = toEnum(PinnedFilterActiveEnum, str(x[A + "Active"]) ?? "Always");
    p.splitValue = bool(x[A + "SplitValue"]);
    return p;
}

function columnFromXml(x: Record<string, unknown>): ChartColumnEmbedded {
    const c = new ChartColumnEmbedded();
    c.token = x[A + "Token"] != null ? token(str(x[A + "Token"])!) : null;
    c.displayName = str(x[A + "DisplayName"]) ?? null;
    c.format = str(x[A + "Format"]) ?? null;
    c.orderByIndex = x[A + "OrderByIndex"] != null ? (Number(x[A + "OrderByIndex"]) as int) : null;
    c.orderByType = str(x[A + "OrderByType"]) as OrderType ?? null;
    return c;
}

function parameterFromXml(x: Record<string, unknown>): ChartParameterEmbedded {
    const p = new ChartParameterEmbedded();
    p.name = str(x[A + "Name"]) ?? "";
    p.value = str(x[A + "Value"]) ?? null;
    return p;
}

// ---- small helpers -------------------------------------------------------------------------------------

function token(tokenString: string): QueryTokenEmbedded {
    const t = new QueryTokenEmbedded();
    t.tokenString = tokenString;
    return t;
}

// Signum's SymbolLogic<ChartScriptSymbol>.ToSymbol(key). altea resolves the declared symbol instance (which
// SymbolLogic stamped with its id at startup) by scanning the AutoInit containers.
const chartScriptsByKey: Record<string, ChartScriptSymbol> = [D3ChartScript, HtmlChartScript, SvgMapsChartScript, GoogleMapsChartScript]
    .flatMap(container => Object.values(container) as ChartScriptSymbol[])
    .reduce((acc, s) => { acc[s.key] = s; return acc; }, {} as Record<string, ChartScriptSymbol>);

function resolveChartScript(key: string): ChartScriptSymbol {
    const s = chartScriptsByKey[key];
    if (s == null)
        throw new Error(`UserChart import: chart script '${key}' is not registered`);
    return s;
}

// Enum.toValue wants the narrow member-name union; XML gives us a plain string, so widen the arg here.
function toEnum<E extends Record<string, string | number>>(e: E, name: string): number {
    return Enum.toValue(e, name as Extract<keyof E, string>);
}

function str(v: unknown): string | undefined {
    return v == null ? undefined : String(v);
}
function bool(v: unknown): boolean {
    return v === true || v === "true" || v === "True";
}
function firstElem(v: unknown): Record<string, unknown> {
    return (Array.isArray(v) ? v[0] : v) as Record<string, unknown>;
}
function arr(wrapper: unknown, childName: string): Record<string, unknown>[] {
    if (wrapper == null) return [];
    const w = firstElem(wrapper);
    const list = w?.[childName];
    return (Array.isArray(list) ? list : list != null ? [list] : []) as Record<string, unknown>[];
}
