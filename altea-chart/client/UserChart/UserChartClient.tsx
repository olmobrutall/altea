import * as React from "react";
import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import * as AppContext from "@altea/altea/client/AppContext";
import { ajaxGet } from "@altea/altea/client/Services";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { Finder } from "@altea/altea/client/Finder";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import type { QueryToken } from "@altea/altea/client/QueryToken";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import type {
    FilterOptionParsed, FilterConditionOptionParsed, FilterGroupOptionParsed, PinnedFilterParsed,
} from "@altea/altea/client/FindOptions";
import { isFilterGroup } from "@altea/altea/client/FindOptions";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import type { QueryEntity } from "@altea/altea/data/queryEntity";
import { type int, toInt } from "@altea/altea/data/basics";
import type { FilterType } from "@altea/altea/data/dynamicQueries";
import {
    PinnedFilterActiveEnum, FilterGroupOperationEnum, FilterOperationEnum, DashboardBehaviourEnum,
} from "@altea/altea/data/dynamicQueries";
import { Enum } from "@altea/altea/data/enum";
import { parseFilterValue, stringifyFilterValue } from "@altea/altea-user-assets/client/FilterValueString";
import { QueryTokenEmbedded, PinnedQueryFilterEmbedded } from "@altea/altea-user-assets/data/Queries";
import { UserAssetClient } from "@altea/altea-user-assets/client/UserAssetClient";
import { ChartRequestModel, ChartTimeSeriesEmbedded } from "../../data/ChartRequest";
import { ChartColumnEmbedded } from "../../data/ChartColumn";
import { ChartParameterEmbedded } from "../../data/ChartParameter";
import { ChartClient } from "../ChartClient";
import {
    UserChartEntity, UserChartLite, UserChartEntity_Filters, UserChartEntity_Columns, UserChartEntity_Parameters,
} from "../../data/UserChart";
import UserChartMenu from "./UserChartMenu";
import { ChartDashboardClient } from "../Dashboard/ChartDashboardClient";
import { ToolbarClient } from "@altea/altea-toolbar/client/ToolbarClient";
import UserChartToolbarConfig from "./UserChartToolbarConfig";

// Port of Signum's Signum.Chart/UserChart/UserChartClient.tsx. Registers the UserChart entity view, the
// /userChart page, and the quick-links to run a saved chart. The direct analogue of UserQueriesClient.
//
// altea divergences:
//  - No server parseFilters/stringifyFilters round-trip: `Converter.toChartRequest` builds the
//    ChartRequestModel directly from the stored (flat, indentation-based) filter rows — altea resolves
//    tokens + values on the client (Finder.TokenCompleter), exactly as FilterBuilderEmbedded / UserQuery do.
//  - The custom-lite carries the display fields directly (UserChartLite), so quick-links read
//    `(uc as UserChartLite).hideQuickLink`, not Signum's `uc.model`.
//  - Signum reaches the chart page via ChartClient.Encoder.chartPathPromise (a URL round-trip of the whole
//    ChartRequestModel). altea has no chart-URL Encoder, so UserChartPage builds the ChartRequestModel via
//    the Converter and renders it in a ChartRequestView directly (see UserChartPage.tsx).
//  - DEFERRED (matching what altea-chart itself deferred): the chart-toolbar UserChart MENU (Signum's
//    ChartClient.ButtonBarChart + the ChartRequestView "handle" it needs — ButtonBarChart is not ported in
//    altea-chart's ChartClient), the Toolbar / Omnibox / Dashboard / CombinedUserChart / CustomDrilldown
//    wiring, and the `EntityPack.userCharts` extension.

export namespace UserChartClient {

    export function start(cb: ClientBuilder): void {
        // Shared user-asset infrastructure: the import route + the "Export to XML" quick-link on UserChart.
        UserAssetClient.start(cb.routes);
        UserAssetClient.registerExportAssertLink(UserChartEntity);

        // The saved-chart page: runs the UserChart in a ChartRequestView.
        cb.routes.push({
            path: "/userChart/:userChartId/:entity?",
            element: <ImportComponent onImport={() => import("./UserChartPage")} />,
        });

        // The toolbar config for an element pointing at a UserChart (Signum registered it from here too).
        // Registering into the toolbar's config registry is INERT when the toolbar module is not started.
        ToolbarClient.registerConfig(new UserChartToolbarConfig());

        // The UserChart editor (never creable directly — created from the chart window in Signum).
        cb.configure(UserChartEntity)
            .withView(() => import("./UserChart"));

        // Global quick-link: on any entity, offer the user charts scoped to that entity type — each opens the
        // saved chart filtered by the current entity (Signum's registerGlobalQuickLink). Server-gated by
        // ViewCharting (altea has no client permission primitive — the /forEntityType route enforces it).
        QuickLinkClient.registerGlobalQuickLink(entityType =>
            API.forEntityType(entityType).then(ucs => ucs.map(uc =>
                new QuickLinkAction(uc.key(), () => uc.toString(), async ctx => {
                    window.open(AppContext.toAbsoluteUrl(userChartUrl(uc, ctx.lite)));
                }, {
                    icon: "chart-bar", iconColor: "darkviolet", color: "info",
                    onlyForToken: (uc as UserChartLite).hideQuickLink,
                }),
            )));

        // Preview quick-link on a UserChart itself (Signum's "preview").
        QuickLinkClient.registerQuickLink(UserChartEntity, new QuickLinkAction(
            "preview", () => "Preview", async ctx => {
                const uc = await Navigator.API.fetch(ctx.lite as Lite<UserChartEntity>);
                if (uc == null)
                    return;
                if (uc.entityType == null)
                    window.open(AppContext.toAbsoluteUrl(userChartUrl(uc.toLite())));
                // else: scoping to a chosen entity needs Finder.find (a stub in altea) — deferred.
            },
            { icon: "eye", iconColor: "blue", color: "info" },
        ));

        // The UserChart DASHBOARD part (Signum registered its view + renderer inline here; altea keeps it in
        // one module so the @altea/altea-dashboard dependency is visible in a single place).
        ChartDashboardClient.start(cb);

        // The UserChart menu on the chart page toolbar (Signum's ChartClient.ButtonBarChart) — list / apply /
        // create / edit a saved chart from the current ChartRequestView.
        ChartClient.ButtonBarChart.onButtonBarElements.push(ctx =>
            <UserChartMenu chartRequestView={ctx.chartRequestView} />);
    }

    export function userChartUrl(uc: Lite<UserChartEntity>, entity?: Lite<Entity>): string {
        return entity ? `/userChart/${uc.id}/${entity.key()}` : `/userChart/${uc.id}`;
    }

    // ---- Converter (Signum's UserChartClient.Converter) --------------------------------------------

    export namespace Converter {

        // Build the ChartRequestModel that runs a UserChart. altea resolves tokens + coerces values
        // client-side (Finder.TokenCompleter), then synchronizes the chart columns against the ChartScript.
        export async function toChartRequest(uc: UserChartEntity, entity?: Lite<Entity>): Promise<ChartRequestModel> {
            const cr = new ChartRequestModel();
            cr.queryKey = uc.query.key;
            cr.chartScript = uc.chartScript;
            cr.maxRows = uc.maxRows;
            cr.chartTimeSeries = uc.chartTimeSeries == null ? null : cloneTimeSeries(uc.chartTimeSeries);

            const canTimeSeries = uc.chartTimeSeries != null ? SubTokensOptions.CanTimeSeries : 0;
            const colOptions = SubTokensOptions.CanElement | SubTokensOptions.CanAggregate | canTimeSeries;
            const filterOptions = SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | SubTokensOptions.CanAggregate | canTimeSeries;

            const rootToken = await Finder.getQueryRoot(uc.query.key);
            const completer = new Finder.TokenCompleter(rootToken);
            for (const c of uc.columns ?? [])
                if (c.element.token?.tokenString) completer.request(c.element.token.tokenString);
            for (const f of uc.filters ?? [])
                if (f.token?.tokenString) completer.request(f.token.tokenString);
            await completer.finished();

            cr.columns = (uc.columns ?? []).map(c => toChartColumn(c.element, completer, colOptions));
            cr.parameters = (uc.parameters ?? []).map(p => toChartParameter(p.element));
            cr.filterOptions = buildFilterTree(uc.filters ?? [], 0, completer, filterOptions, entity);

            const cs = await ChartClient.getChartScript(cr.chartScript);
            ChartClient.synchronizeColumns(cr, cs);
            return cr;
        }
    }

    // ---- API (Signum's UserChartClient.API) --------------------------------------------------------

    export namespace API {
        export function forEntityType(type: string): Promise<Lite<UserChartEntity>[]> {
            return ajaxGet({ url: "/api/userChart/forEntityType/" + type });
        }
        export function forQuery(queryKey: string): Promise<Lite<UserChartEntity>[]> {
            return ajaxGet({ url: "/api/userChart/forQuery/" + queryKey });
        }
        // The QueryEntity for a key — used to build a new UserChart's `query` FK (Signum read it from cache).
        export function queryEntity(queryKey: string): Promise<QueryEntity> {
            return ajaxGet({ url: "/api/userChart/queryEntity/" + queryKey });
        }
    }

    // Signum's UserChartMenu.createUserChart: build a new UserChart from the live ChartRequestModel — its query
    // FK, chart script, maxRows, time-series, the columns/parameters (wrapped as @part rows over COPIES of the
    // value objects), and the filters flattened to UserChartEntity_Filters rows (values stringified). altea does
    // the filter stringify client-side (no server round-trip), mirroring UserQueryMenu.createUserQuery.
    export async function createUserChart(cr: ChartRequestModel): Promise<UserChartEntity> {
        const uc = new UserChartEntity();
        uc.query = await API.queryEntity(cr.queryKey);
        uc.owner = AppContext.currentUser?.toLite() ?? null;
        uc.chartScript = cr.chartScript;
        uc.maxRows = cr.maxRows;
        uc.chartTimeSeries = cr.chartTimeSeries == null ? null : cloneTimeSeries(cr.chartTimeSeries);
        uc.filters = filterOptionsParsedToChartEmbedded(cr.filterOptions ?? []);
        uc.columns = (cr.columns ?? []).map((c, i) => {
            const row = new UserChartEntity_Columns();
            row.element = copyChartColumn(c);
            row.order = toInt(i);
            return row;
        });
        uc.parameters = (cr.parameters ?? []).map((p, i) => {
            const row = new UserChartEntity_Parameters();
            row.element = toChartParameter(p);
            row.order = toInt(i);
            return row;
        });
        uc.customDrilldowns = [];
        return uc;
    }
}

// ---- helpers ---------------------------------------------------------------------------------------

// A standalone copy of a ChartColumnEmbedded for a new UserChart (like toChartColumn but the token is already
// resolved, so no completer). The resolved `.token` (client-only, @serialize(false)) rides along harmlessly.
function copyChartColumn(c: ChartColumnEmbedded): ChartColumnEmbedded {
    const col = new ChartColumnEmbedded();
    col.displayName = c.displayName;
    col.format = c.format;
    col.orderByIndex = c.orderByIndex;
    col.orderByType = c.orderByType;
    if (c.token?.tokenString) {
        const t = new QueryTokenEmbedded();
        t.tokenString = c.token.tokenString;
        t.token = c.token.token;
        col.token = t;
    }
    return col;
}

// Flatten a parsed filter tree into the stored, indentation-tagged UserChartEntity_Filters rows (mirrors
// altea-user-queries' filterOptionsParsedToEmbedded, but for the chart-owned filter row + the chart enums).
function filterOptionsParsedToChartEmbedded(filters: FilterOptionParsed[]): UserChartEntity_Filters[] {
    const rows: UserChartEntity_Filters[] = [];
    function push(fo: FilterOptionParsed, indent: number): void {
        const row = new UserChartEntity_Filters();
        row.indentation = toInt(indent);
        row.pinned = fo.pinned ? toPinnedEmbedded(fo.pinned) : null;
        row.dashboardBehaviour = fo.dashboardBehaviour == null ? null : Enum.toValue(DashboardBehaviourEnum, fo.dashboardBehaviour);
        if (isFilterGroup(fo)) {
            row.isGroup = true;
            row.groupOperation = fo.groupOperation == null ? null : Enum.toValue(FilterGroupOperationEnum, fo.groupOperation);
            row.token = fo.token ? toTokenEmbedded(fo.token) : null;
            row.valueString = Array.isArray(fo.value) && fo.token
                ? fo.value.map(v => stringifyFilterValue(v, fo.token!.filterType)).join("|")
                : (fo.value != null ? String(fo.value) : null);
            rows.push(row);
            fo.filters.forEach(f => push(f, indent + 1));
        } else {
            row.token = fo.token ? toTokenEmbedded(fo.token) : null;
            row.operation = fo.operation == null ? null : Enum.toValue(FilterOperationEnum, fo.operation);
            row.valueString = Array.isArray(fo.value) && fo.token
                ? fo.value.map(v => stringifyFilterValue(v, fo.token!.filterType)).join("|")
                : stringifyFilterValue(fo.value, fo.token?.filterType);
            rows.push(row);
        }
    }
    filters.forEach(fo => push(fo, 0));
    return rows;
}

function toTokenEmbedded(token: QueryToken): QueryTokenEmbedded {
    const t = new QueryTokenEmbedded();
    t.tokenString = token.fullKey();
    t.token = token;
    return t;
}

function toPinnedEmbedded(p: PinnedFilterParsed): PinnedQueryFilterEmbedded {
    const e = new PinnedQueryFilterEmbedded();
    e.label = p.label ?? null;
    e.column = (p.column ?? null) as PinnedQueryFilterEmbedded["column"];
    e.colSpan = (p.colSpan ?? null) as PinnedQueryFilterEmbedded["colSpan"];
    e.row = (p.row ?? null) as PinnedQueryFilterEmbedded["row"];
    e.active = Enum.toValue(PinnedFilterActiveEnum, p.active ?? "Always");
    e.splitValue = p.splitValue ?? false;
    return e;
}

function cloneTimeSeries(ts: ChartTimeSeriesEmbedded): ChartTimeSeriesEmbedded {
    const e = new ChartTimeSeriesEmbedded();
    e.startDate = ts.startDate;
    e.endDate = ts.endDate;
    e.timeSeriesUnit = ts.timeSeriesUnit;
    e.timeSeriesStep = ts.timeSeriesStep;
    e.timeSeriesMaxRowsPerStep = ts.timeSeriesMaxRowsPerStep;
    e.splitQueries = ts.splitQueries;
    return e;
}

function toChartColumn(c: ChartColumnEmbedded, completer: Finder.TokenCompleter, subTokenOptions: SubTokensOptions): ChartColumnEmbedded {
    const col = new ChartColumnEmbedded();
    col.displayName = c.displayName;
    col.format = c.format;
    col.orderByIndex = c.orderByIndex;
    col.orderByType = c.orderByType;
    if (c.token?.tokenString) {
        const t = new QueryTokenEmbedded();
        t.tokenString = c.token.tokenString;
        t.token = completer.get(c.token.tokenString, subTokenOptions);
        col.token = t;
    }
    return col;
}

function toChartParameter(p: ChartParameterEmbedded): ChartParameterEmbedded {
    const cp = new ChartParameterEmbedded();
    cp.name = p.name;
    cp.value = p.value;
    return cp;
}

// Reconstruct the parsed filter tree from the flat, indentation-tagged stored rows (Signum's groupWhen on
// `indentation`), resolving each token client-side. Mirrors FilterBuilderEmbedded.toFilterOptionParsed.
function buildFilterTree(
    filters: UserChartEntity_Filters[], indent: number, completer: Finder.TokenCompleter,
    subTokenOptions: SubTokensOptions, entity: Lite<Entity> | undefined,
): FilterOptionParsed[] {
    return groupWhen(filters, f => (f.indentation as unknown as number) === indent).map(run => {
        const head = run[0];
        const children = run.slice(1);
        const token = head.token ? completer.get(head.token.tokenString, subTokenOptions) : undefined;
        if (head.isGroup) {
            return {
                token,
                groupOperation: Enum.toName(FilterGroupOperationEnum, head.groupOperation!),
                filters: buildFilterTree(children, indent + 1, completer, subTokenOptions, entity),
                value: parseValue(head.valueString, token?.filterType, entity),
                frozen: false,
                pinned: head.pinned ? toPinnedParsed(head.pinned) : undefined,
                dashboardBehaviour: head.dashboardBehaviour == null ? undefined : Enum.toName(DashboardBehaviourEnum, head.dashboardBehaviour),
            } as FilterGroupOptionParsed;
        }
        return {
            token,
            operation: head.operation == null ? "EqualTo" : Enum.toName(FilterOperationEnum, head.operation),
            value: parseValue(head.valueString, token?.filterType, entity),
            frozen: false,
            pinned: head.pinned ? toPinnedParsed(head.pinned) : undefined,
            dashboardBehaviour: head.dashboardBehaviour == null ? undefined : Enum.toName(DashboardBehaviourEnum, head.dashboardBehaviour),
        } as FilterConditionOptionParsed;
    });
}

// Recover a filter value from its stored string form (altea has no server value converter here). The special
// expressions "[CurrentEntity]" / "[CurrentUser]" resolve to the entity the UserChart is scoped to and the
// logged-in user; everything else goes through FilterValueString.parseFilterValue by filterType.
function parseValue(valueString: string | null, filterType: FilterType | undefined, entity: Lite<Entity> | undefined): unknown {
    if (valueString == null) return undefined;
    if (valueString === "[CurrentEntity]") return entity;
    if (valueString === "[CurrentUser]") return AppContext.currentUser?.toLite();
    return parseFilterValue(valueString, filterType);
}

function toPinnedParsed(p: PinnedQueryFilterEmbedded): PinnedFilterParsed {
    return {
        label: p.label || undefined,
        column: p.column ?? undefined,
        colSpan: p.colSpan ?? undefined,
        row: p.row ?? undefined,
        active: Enum.toName(PinnedFilterActiveEnum, p.active),
        splitValue: p.splitValue || undefined,
    };
}

function groupWhen<T>(list: T[], isGroupStart: (t: T) => boolean): T[][] {
    const result: T[][] = [];
    let current: T[] | null = null;
    for (const item of list) {
        if (isGroupStart(item)) {
            current = [item];
            result.push(current);
        } else if (current != null) {
            current.push(item);
        }
    }
    return result;
}
