import * as React from "react";
import { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import * as AppContext from "@altea/altea/client/AppContext";
import { ajaxGet } from "@altea/altea/client/Services";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { QuickLinkClient, QuickLinkAction } from "@altea/altea/client/QuickLinkClient";
import type {
    FindOptions, FindOptionsParsed, FilterOption, FilterConditionOption, FilterGroupOption, ColumnOption, OrderOption,
} from "@altea/altea/client/FindOptions";
import { isFilterGroup } from "@altea/altea/client/FindOptions";
import type { Pagination, SystemTime } from "@altea/altea/data/dynamicQuery/queryRequest";
import type { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import type { QueryEntity } from "@altea/altea/data/queryEntity";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { Enum } from "@altea/altea/data/enum";
import {
    RefreshModeEnum, ColumnOptionsModeEnum, PaginationModeEnum, OrderTypeEnum, CombineRowsEnum,
    FilterGroupOperationEnum, FilterOperationEnum, SystemTimeModeEnum, SystemTimeJoinModeEnum, TimeSeriesUnitEnum,
    PinnedFilterActiveEnum,
} from "@altea/altea/data/dynamicQueries";
import { UserQueryEntity, UserQueryLite, QueryFilterEmbedded } from "../data/UserQuery";
import type { PinnedQueryFilterEmbedded } from "@altea/altea-user-assets/data/Queries";
import { UserAssetClient } from "@altea/altea-user-assets/client/UserAssetClient";
import UserQueryMenu from "./UserQueryMenu";
import { UserQueriesDashboardClient } from "./Dashboard/UserQueriesDashboardClient";
import { ToolbarClient } from "@altea/altea-toolbar/client/ToolbarClient";
import UserQueryToolbarConfig from "./UserQueryToolbarConfig";

// Port of Signum's Signum.UserQueries/UserQueryClient.tsx. Registers the UserQuery entity view, the
// /userQuery page, and the quick-links to run a saved query. altea divergences:
//  - No server parseFilters/stringifyFilters round-trip: `Converter.toFindOptions` builds the FindOptions
//    directly from the stored (flat, indentation-based) filter rows — altea resolves tokens + values on the
//    client (SearchControl.parseFindOptions). Filter values are recovered from their string form here.
//  - The custom-lite carries the display fields directly (UserQueryLite), so the menu/quick-links read
//    `(uq as UserQueryLite).hideQuickLink`, not Signum's `uq.model`.
//  - Omnibox / ContextualItems / CustomDrilldown wiring is deferred (missing modules); the Dashboard parts
//    and the Toolbar config ARE registered (see UserQueriesDashboardClient / UserQueryToolbarConfig).

export namespace UserQueriesClient {

    export function start(cb: ClientBuilder): void {
        // Shared user-asset infrastructure: the import route + the "Export to XML" quick-link on UserQuery.
        UserAssetClient.start(cb.routes);
        UserAssetClient.registerExportAssertLink(UserQueryEntity);

        // The saved-query page: runs the UserQuery in a full SearchControl.
        cb.routes.push({
            path: "/userQuery/:userQueryId/:entity?",
            element: <ImportComponent onImport={() => import("./Templates/UserQueryPage")} />,
        });

        // The UserQuery editor (Never creable directly — created from a SearchControl via the menu).
        cb.configure(UserQueryEntity)
            .withView(() => import("./Templates/UserQuery"));

        // Global quick-link: on any entity, offer the user queries scoped to that entity type — each opens
        // the saved query filtered by the current entity (Signum's registerGlobalQuickLink). Server-gated by
        // ViewUserQuery (altea has no client permission primitive — the /forEntityType route enforces it).
        QuickLinkClient.registerGlobalQuickLink(entityType =>
            API.forEntityType(entityType).then(uqs => uqs.map(uq =>
                new QuickLinkAction(uq.key(), () => uq.toString(), async ctx => {
                    const uqe = await Navigator.API.fetch(uq);
                    const url = await getUserQueryUrl(uqe, ctx.lite);
                    window.open(AppContext.toAbsoluteUrl(url));
                }, {
                    icon: "rectangle-list", iconColor: "dodgerblue", color: "info",
                    onlyForToken: (uq as UserQueryLite).hideQuickLink,
                }),
            )));

        // Preview quick-link on a UserQuery itself (Signum's "preview").
        QuickLinkClient.registerQuickLink(UserQueryEntity, new QuickLinkAction(
            "preview", () => "Preview", async ctx => {
                const uq = await Navigator.API.fetch(ctx.lite as Lite<UserQueryEntity>);
                if (uq == null)
                    return;
                if (uq.entityType == null) {
                    const url = await getUserQueryUrl(uq);
                    window.open(AppContext.toAbsoluteUrl(url));
                }
                // else: scoping to a chosen entity needs Finder.find (a stub in altea) — deferred.
            },
            { icon: "eye", iconColor: "blue", color: "info" },
        ));

        // The three UserQuery DASHBOARD parts (Signum registered their views + renderers inline here; altea
        // keeps them in one module so the @altea/altea-dashboard dependency is visible in a single place).
        UserQueriesDashboardClient.start(cb);

        // The toolbar config for an element pointing at a UserQuery (Signum registered it from here too).
        // Registering into the toolbar's config registry is INERT when the toolbar module is not started.
        ToolbarClient.registerConfig(new UserQueryToolbarConfig());

        // The UserQuery menu in the SearchControl toolbar (Signum's ButtonBarQuery.onButtonBarElements).
        Finder.ButtonBarQuery.onButtonBarElements.push(ctx => {
            const isHidden = !ctx.searchControl.props.showBarExtension ||
                !(ctx.searchControl.props.showBarExtensionOption?.showUserQuery ?? ctx.searchControl.props.largeToolbarButtons);
            return { button: <UserQueryMenu searchControl={ctx.searchControl} isHidden={isHidden} /> };
        });
    }

    // Signum's getUserQueryUrl: the SearchControl URL that runs this UserQuery (optionally over an entity).
    export async function getUserQueryUrl(uq: UserQueryEntity, entity?: Lite<Entity>): Promise<string> {
        if (Enum.toName(RefreshModeEnum, uq.refreshMode) === "Manual")
            return userQueryUrl(uq.toLite(), entity);

        const fo = await Converter.toFindOptions(uq, entity);
        return Finder.findOptionsPath(fo, { userQuery: uq.toLite().key(), entity: entity ? entity.key() : undefined });
    }

    export function userQueryUrl(uq: Lite<UserQueryEntity>, entity?: Lite<Entity>): string {
        return entity ? `/userQuery/${uq.id}/${entity.key()}` : `/userQuery/${uq.id}`;
    }

    // ---- Converter (Signum's UserQueryClient.Converter) --------------------------------------------

    export namespace Converter {

        // Build the FindOptions that runs a UserQuery. altea resolves tokens + coerces values client-side,
        // so we hand string tokens + recovered values straight to the SearchControl.
        export async function toFindOptions(uq: UserQueryEntity, entity: Lite<Entity> | undefined): Promise<FindOptions> {
            const fo: FindOptions = { queryName: uq.query.key, groupResults: uq.groupResults };

            // Enum fields are stored as int-FK ordinals (see UserQuery.ts / dynamicQueries); FindOptions
            // wants the member-name string, so normalise every enum read with Enum.toName. Temporal dates
            // cross the wire as their ISO string.
            fo.filterOptions = buildFilterTree(uq.filters ?? [], 0, entity);
            fo.includeDefaultFilters = uq.includeDefaultFilters ?? undefined;
            fo.columnOptionsMode = Enum.toName(ColumnOptionsModeEnum, uq.columnsMode);
            fo.columnOptions = (uq.columns ?? []).map(c => ({
                token: c.token.tokenString,
                displayName: c.displayName ?? undefined,
                summaryToken: c.summaryToken?.tokenString,
                hiddenColumn: c.hiddenColumn,
                combineRows: c.combineRows == null ? undefined : Enum.toName(CombineRowsEnum, c.combineRows),
            }) as ColumnOption);
            fo.orderOptions = (uq.orders ?? []).map(o => ({
                token: o.token.tokenString,
                orderType: Enum.toName(OrderTypeEnum, o.orderType),
            }) as OrderOption);

            const paginationMode = uq.paginationMode == null ? undefined : Enum.toName(PaginationModeEnum, uq.paginationMode);
            fo.pagination = paginationMode == null ? undefined : {
                mode: paginationMode,
                currentPage: paginationMode === "Paginate" ? 1 : undefined,
                elementsPerPage: paginationMode === "All" ? undefined : (uq.elementsPerPage ?? undefined),
            } as Pagination;

            fo.systemTime = uq.systemTime == null ? undefined : {
                mode: Enum.toName(SystemTimeModeEnum, uq.systemTime.mode),
                startDate: uq.systemTime.startDate?.toString() ?? undefined,
                endDate: uq.systemTime.endDate?.toString() ?? undefined,
                joinMode: uq.systemTime.joinMode == null ? undefined : Enum.toName(SystemTimeJoinModeEnum, uq.systemTime.joinMode),
                timeSeriesStep: uq.systemTime.timeSeriesStep ?? undefined,
                timeSeriesUnit: uq.systemTime.timeSeriesUnit == null ? undefined : Enum.toName(TimeSeriesUnitEnum, uq.systemTime.timeSeriesUnit),
                timeSeriesMaxRowsPerStep: uq.systemTime.timeSeriesMaxRowsPerStep ?? undefined,
                splitQueries: uq.systemTime.splitQueries ?? undefined,
            } as SystemTime;

            // `entity` (the CurrentEntity a quick-link scopes to) is applied by the caller via the URL /
            // extraOptions; the stored [CurrentEntity] filter value passes through unchanged.
            return fo;
        }

        // Signum's applyUserQuery: overlay a UserQuery onto a live SearchControl's parsed FindOptions.
        export function applyUserQuery(
            fop: FindOptionsParsed, uq: UserQueryEntity, entity: Lite<Entity> | undefined, defaultIncludeDefaultFilters: boolean,
        ): Promise<FindOptionsParsed> {
            return toFindOptions(uq, entity)
                .then(fo => Finder.getQueryRoot(fo.queryName)
                    .then(qt => Finder.parseFindOptions(fo, qt, uq.includeDefaultFilters == null ? defaultIncludeDefaultFilters : uq.includeDefaultFilters)))
                .then(fop2 => {
                    if (!uq.appendFilters)
                        fop.filterOptions = fop.filterOptions.filter(a => a.frozen);
                    fop.filterOptions.push(...fop2.filterOptions);
                    fop.groupResults = fop2.groupResults;
                    fop.orderOptions = fop2.orderOptions;
                    fop.columnOptions = fop2.columnOptions;
                    fop.pagination = fop2.pagination;
                    fop.systemTime = fop2.systemTime;
                    return fop;
                });
        }
    }

    // ---- API (Signum's UserQueryClient.API) --------------------------------------------------------

    export namespace API {
        export function forEntityType(type: string): Promise<Lite<UserQueryEntity>[]> {
            return ajaxGet({ url: "/api/userQueries/forEntityType/" + type });
        }
        export function forQuery(queryKey: string): Promise<Lite<UserQueryEntity>[]> {
            return ajaxGet({ url: "/api/userQueries/forQuery/" + queryKey });
        }
        export function forQueryAppendFilters(queryKey: string): Promise<Lite<UserQueryEntity>[]> {
            return ajaxGet({ url: "/api/userQueries/forQueryAppendFilters/" + queryKey });
        }
        // The QueryEntity for a key — used to build a new UserQuery's `query` FK (Signum read it from cache).
        export function queryEntity(queryKey: string): Promise<QueryEntity> {
            return ajaxGet({ url: "/api/userQueries/queryEntity/" + queryKey });
        }
    }
}

// ---- helpers ---------------------------------------------------------------------------------------

// Reconstruct the nested filter tree from the flat, indentation-tagged stored rows (Signum's groupWhen on
// `indentation`): each run starts at an element whose indentation === `indent`; deeper rows are its children.
function buildFilterTree(filters: QueryFilterEmbedded[], indent: number, entity: Lite<Entity> | undefined): FilterOption[] {
    const runs = groupWhen(filters, f => (f.indentation as unknown as number) === indent);
    return runs.map(run => {
        const head = run[0];
        const children = run.slice(1);
        if (head.isGroup) {
            return {
                token: head.token?.tokenString,
                groupOperation: Enum.toName(FilterGroupOperationEnum, head.groupOperation!),
                filters: buildFilterTree(children, indent + 1, entity),
                pinned: toPinned(head.pinned),
                value: parseValue(head.valueString, entity),
            } as FilterGroupOption;
        }
        return {
            token: head.token!.tokenString,
            operation: head.operation == null ? "EqualTo" : Enum.toName(FilterOperationEnum, head.operation),
            value: parseValue(head.valueString, entity),
            pinned: toPinned(head.pinned),
        } as FilterConditionOption;
    });
}

function toPinned(p: PinnedQueryFilterEmbedded | null): FilterConditionOption["pinned"] {
    if (p == null) return undefined;
    return {
        label: p.label ?? undefined,
        column: p.column ?? undefined,
        colSpan: p.colSpan ?? undefined,
        row: p.row ?? undefined,
        active: Enum.toName(PinnedFilterActiveEnum, p.active),
        splitValue: p.splitValue,
    };
}

// Recover a filter value from its stored string form (altea has no server value converter here). Lists use
// "|"; a "PascalType;id" segment whose type resolves is a Lite; else bool / number / raw string. The special
// expressions "[CurrentEntity]" / "[CurrentUser]" (authored via FilterBuilderEmbedded's value↔expression
// toggle) are resolved client-side here — to the entity the UserQuery is scoped to, and the logged-in user.
function parseValue(valueString: string | null, entity: Lite<Entity> | undefined): unknown {
    if (valueString == null) return undefined;
    if (valueString === "[CurrentEntity]") return entity;
    if (valueString === "[CurrentUser]") return AppContext.currentUser?.toLite();
    if (valueString.includes("|"))
        return valueString.split("|").map(s => parseScalar(s.trim()));
    return parseScalar(valueString);
}

function parseScalar(s: string): unknown {
    const semi = s.indexOf(";");
    if (semi > 0 && /^[A-Z]\w*$/.test(s.slice(0, semi)) && tryGetTypeInfo(s.slice(0, semi)) != null) {
        try { return Lite.parse(s); } catch { /* fall through */ }
    }
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
}

// Signum's SearchControlLoaded module augmentation: the toolbar's "show user query" opt-in flag.
declare module "@altea/altea/client/SearchControl/SearchControlLoaded" {
    interface ShowBarExtensionOption {
        showUserQuery?: boolean;
    }
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
