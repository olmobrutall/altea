import * as React from "react";
import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import * as AppContext from "@altea/altea/client/AppContext";
import { ajaxGet } from "@altea/altea/client/Services";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { Finder } from "@altea/altea/client/Finder";
import { SubTokensOptions } from "@altea/altea/client/QueryToken";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import type { QueryEntity } from "@altea/altea/data/queryEntity";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { UserAssetClient } from "@altea/altea-user-assets/client/UserAssetClient";
import { ChartRequestModel, ChartTimeSeriesEmbedded } from "../../data/ChartRequest";
import { ChartColumnEmbedded } from "../../data/ChartColumn";
import { ChartParameterEmbedded } from "../../data/ChartParameter";
import { ChartClient } from "../ChartClient";
import {
    UserChartEntity, UserChartLite, UserChartEntity_Filter, UserChartEntity_Column, UserChartEntity_Parameter,
} from "../../data/UserChart";
import UserChartMenu from "./UserChartMenu";
import { ChartDashboardClient } from "../Dashboard/ChartDashboardClient";
import { ToolbarClient } from "@altea/altea-toolbar/client/ToolbarClient";
import UserChartToolbarConfig from "./UserChartToolbarConfig";

// Port of Signum's Signum.Chart/UserChart/UserChartClient.tsx. Registers the UserChart entity view, the
// /userChart page, and the quick-links to run a saved chart. The direct analogue of UserQueriesClient.
//
// altea divergences:
//  - The filters go through UserAssetClient.parseFilters / stringifyFilters as in Signum, but those resolve
//    tokens + values on the CLIENT (Finder.TokenCompleter) rather than on a server round-trip.
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
        cb.configure(UserChartEntity)
            .withQuickLink(new QuickLinkAction(
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
        ChartClient.ButtonBarChart.onButtonBarElements().push(ctx =>
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
            const cr = ChartRequestModel.create({
                queryKey: uc.query.key,
                chartScript: uc.chartScript,
                maxRows: uc.maxRows,
                chartTimeSeries: uc.chartTimeSeries == null ? null : cloneTimeSeries(uc.chartTimeSeries),
            });

            const canTimeSeries = uc.chartTimeSeries != null ? SubTokensOptions.CanTimeSeries : 0;
            const colOptions = SubTokensOptions.CanElement | SubTokensOptions.CanAggregate | canTimeSeries;
            const filterOptions = SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement | SubTokensOptions.CanAggregate | canTimeSeries;

            const rootToken = await Finder.getQueryRoot(uc.query.key);
            const completer = new Finder.TokenCompleter(rootToken);
            for (const c of uc.columns ?? [])
                if (c.element.token?.tokenString) completer.request(c.element.token.tokenString);
            await completer.finished();

            cr.columns = (uc.columns ?? []).map(c => toChartColumn(c.element, completer, colOptions));
            cr.parameters = (uc.parameters ?? []).map(p => toChartParameter(p.element));
            cr.filterOptions = await UserAssetClient.parseFilters(rootToken, uc.filters ?? [], filterOptions, { entity });

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
    // value objects), and the filters flattened to UserChartEntity_Filter rows (values stringified). altea does
    // the filter stringify client-side (no server round-trip), mirroring UserQueryMenu.createUserQuery.
    export async function createUserChart(cr: ChartRequestModel): Promise<UserChartEntity> {
        const uc = UserChartEntity.create({
            query: await API.queryEntity(cr.queryKey),
            owner: AppContext.currentUser?.toLite() ?? null,
            chartScript: cr.chartScript,
            maxRows: cr.maxRows,
            chartTimeSeries: cr.chartTimeSeries == null ? null : cloneTimeSeries(cr.chartTimeSeries),
            filters: UserAssetClient.stringifyFilters(cr.filterOptions ?? [], UserChartEntity_Filter),
        });
        uc.columns = (cr.columns ?? []).map(c => {
            const row = UserChartEntity_Column.create({ element: copyChartColumn(c) });
            return row;
        });
        uc.parameters = (cr.parameters ?? []).map(p => {
            const row = UserChartEntity_Parameter.create({ element: toChartParameter(p) });
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
    const col = ChartColumnEmbedded.create({
        displayName: c.displayName,
        format: c.format,
        orderByIndex: c.orderByIndex,
        orderByType: c.orderByType,
    });
    if (c.token?.tokenString) {
        const t = QueryTokenEmbedded.create({ tokenString: c.token.tokenString, token: c.token.token });
        col.token = t;
    }
    return col;
}

function cloneTimeSeries(ts: ChartTimeSeriesEmbedded): ChartTimeSeriesEmbedded {
    const e = ChartTimeSeriesEmbedded.create({
        startDate: ts.startDate,
        endDate: ts.endDate,
        timeSeriesUnit: ts.timeSeriesUnit,
        timeSeriesStep: ts.timeSeriesStep,
        timeSeriesMaxRowsPerStep: ts.timeSeriesMaxRowsPerStep,
        splitQueries: ts.splitQueries,
    });
    return e;
}

function toChartColumn(c: ChartColumnEmbedded, completer: Finder.TokenCompleter, subTokenOptions: SubTokensOptions): ChartColumnEmbedded {
    const col = ChartColumnEmbedded.create({
        displayName: c.displayName,
        format: c.format,
        orderByIndex: c.orderByIndex,
        orderByType: c.orderByType,
    });
    if (c.token?.tokenString) {
        const t = QueryTokenEmbedded.create({
            tokenString: c.token.tokenString,
            token: completer.get(c.token.tokenString, subTokenOptions),
        });
        col.token = t;
    }
    return col;
}

function toChartParameter(p: ChartParameterEmbedded): ChartParameterEmbedded {
    const cp = ChartParameterEmbedded.create({ name: p.name, value: p.value });
    return cp;
}
