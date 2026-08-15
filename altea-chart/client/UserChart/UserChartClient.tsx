import * as React from "react";
import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import * as AppContext from "@altea/altea/client/AppContext";
import { ajaxGet } from "@altea/altea/client/Services";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { Finder } from "@altea/altea/client/Finder";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import type {
    FilterOptionParsed, FilterConditionOptionParsed, FilterGroupOptionParsed, PinnedFilterParsed,
} from "@altea/altea/client/FindOptions";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import type { QueryEntity } from "@altea/altea/data/queryEntity";
import type { FilterType } from "@altea/altea/data/dynamicQueries";
import { parseFilterValue } from "@altea/altea-user-assets/client/FilterValueString";
import type { PinnedQueryFilterEmbedded } from "@altea/altea-user-assets/data/Queries";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { UserAssetClient } from "@altea/altea-user-assets/client/UserAssetClient";
import { ChartRequestModel, ChartTimeSeriesEmbedded } from "../../data/ChartRequest";
import { ChartColumnEmbedded } from "../../data/ChartColumn";
import { ChartParameterEmbedded } from "../../data/ChartParameter";
import { ChartClient } from "../ChartClient";
import { UserChartEntity, UserChartLite, UserChartFilterEmbedded } from "../../data/UserChart";

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
}

// ---- helpers ---------------------------------------------------------------------------------------

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
    filters: UserChartFilterEmbedded[], indent: number, completer: Finder.TokenCompleter,
    subTokenOptions: SubTokensOptions, entity: Lite<Entity> | undefined,
): FilterOptionParsed[] {
    return groupWhen(filters, f => (f.indentation as unknown as number) === indent).map(run => {
        const head = run[0];
        const children = run.slice(1);
        const token = head.token ? completer.get(head.token.tokenString, subTokenOptions) : undefined;
        if (head.isGroup) {
            return {
                token,
                groupOperation: head.groupOperation!,
                filters: buildFilterTree(children, indent + 1, completer, subTokenOptions, entity),
                value: parseValue(head.valueString, token?.filterType, entity),
                frozen: false,
                pinned: head.pinned ? toPinnedParsed(head.pinned) : undefined,
                dashboardBehaviour: head.dashboardBehaviour ?? undefined,
            } as FilterGroupOptionParsed;
        }
        return {
            token,
            operation: head.operation ?? "EqualTo",
            value: parseValue(head.valueString, token?.filterType, entity),
            frozen: false,
            pinned: head.pinned ? toPinnedParsed(head.pinned) : undefined,
            dashboardBehaviour: head.dashboardBehaviour ?? undefined,
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
        active: p.active || undefined,
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
