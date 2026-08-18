import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { Lite } from "@altea/altea/data/lite";
import { UserChartEntity, UserChartOperation } from "../data/UserChart";
import { UserAssetLogic } from "@altea/altea-user-assets/server/UserAssetLogic.server";
import { UserChartServer } from "./UserChartServer.server";
import { registerUserChartXml } from "./UserChartXml.server";
import { UserAssetOwnerAuth } from "@altea/altea-user-assets/server/UserAssetOwnerAuth.server";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { registerUserChartDashboardParts } from "./ChartDashboardXml.server";
import { ToolbarLogic } from "@altea/altea-toolbar/server/ToolbarLogic.server";
import { QueryAuthLogic } from "@altea/altea-auth/server/QueryAuthLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";

// Port of Signum's UserChartLogic.Start (Signum.Chart/UserChart/UserChartLogic.cs). Registers the UserChart
// entity + its Save/Delete operations + query, the in-memory caches (Signum's ResetLazy GlobalLazys), the
// XML (de)serializer, and — when a web host is present — the HTTP surface. Mirrors UserQueriesLogic.
//
// altea divergences, documented inline:
//  - Signum's server `ParseData` / `SynchronizeColumns` on Retrieved is dropped: altea resolves query tokens
//    and synchronizes chart columns CLIENT-SIDE (UserChartClient.Converter), so the server never
//    materialises a QueryToken or a ChartScript definition from stored strings.
//  - Owner scoping IS ported: registerUserTypeCondition / registerRoleTypeCondition below, plus the in-memory
//    visibility filter every lookup applies (see @altea/altea-user-assets' UserAssetOwnerAuth).
//  - Toolbar / CachedQuery / Omnibox WhenIncluded blocks + TokenMigration are omitted (those extensions / the
//    interactive terminal sync are not ported); the QueryEntity PreDeleteSqlSync cascade is deferred with
//    them. The DASHBOARD part IS registered (see registerUserChartDashboardParts).

// The registered QueryName lives in the query CONTAINER (`withQuery` registers there); QueryLogic's
// `toQueryName` reads a legacy name-only registry nothing populates, so an unknown key means "not allowed".
async function isQueryKeyAllowed(queryKey: string): Promise<boolean> {
    const queryName = QueryLogic.tryGetQueryNameByKey(queryKey);
    return queryName != null && await QueryAuthLogic.isQueryAllowed(queryName, true);
}

export namespace UserChartLogic {

    // Signum's `ResetLazy<FrozenDictionary<Lite<UserChartEntity>, UserChartEntity>> UserCharts`.
    export let userChartsLazy: ResetLazy<UserChartEntity[]> = null!;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(UserChartEntity)
            .withSave(UserChartOperation.Save)
            .withDelete(UserChartOperation.Delete)
            .withQuery();

        // Start the shared user-asset infrastructure (permission + import/export HTTP surface).
        UserAssetLogic.start(sb);

        // Register how a UserChartEntity is (de)serialized to/from XML (Signum keeps ToXml/FromXml on the
        // entity; altea uses a per-type registry — see UserAssetsImportExport.server).
        registerUserChartXml();

        // The UserChart DASHBOARD part: its XML (de)serializer + clone, registered with @altea/altea-dashboard's
        // part registry (Signum did this inside `sb.Schema.WhenIncluded<DashboardEntity>`).
        registerUserChartDashboardParts();

        // The TOOLBAR content config for a UserChart element (Signum's ToolbarContentConfig inside
        // `WhenIncluded<ToolbarEntity>`). Inert when the toolbar module is not started.
        ToolbarLogic.registerContentConfig(UserChartEntity, {
            defaultLabel: async lite => (await getUserChart(lite)).displayName,
            isAuthorized: async lite => {
                const uc = await getUserChart(lite);
                return await ToolbarLogic.inMemoryFilter(uc)
                    && await isQueryKeyAllowed(uc.query.key);
            },
            getRelatedQuery: async lite => (await getUserChart(lite)).query,
        });

        // Signum's GlobalLazy over all user charts, invalidated on any UserChartEntity change.
        userChartsLazy = sb.globalLazy(() => table(UserChartEntity).toArray() as Promise<UserChartEntity[]>,
            { invalidateWith: [UserChartEntity] });

        if (sb.webBuilder)
            UserChartServer.start(sb.webBuilder);
    }

    /** Signum's `UserChartLogic.RegisterUserTypeCondition` — this chart belongs to the current USER. */
    export function registerUserTypeCondition(typeCondition: TypeConditionSymbol): void {
        UserAssetOwnerAuth.registerUserTypeCondition(UserChartEntity, typeCondition);
    }

    /** Signum's `UserChartLogic.RegisterRoleTypeCondition` — global (no owner), or owned by one of the current
     *  user's roles. */
    export function registerRoleTypeCondition(typeCondition: TypeConditionSymbol): void {
        UserAssetOwnerAuth.registerRoleTypeCondition(UserChartEntity, typeCondition);
    }

    /** The cached UserChart behind a lite (Signum's `UserCharts.Value.GetOrCreate(lite)`) — used by the
     *  toolbar content config registered in `start`. */
    async function getUserChart(lite: Lite<UserChartEntity>): Promise<UserChartEntity> {
        const all = await userChartsLazy.value();
        const found = all.find(uc => String(uc.id) === String(lite.id));
        if (found == null)
            throw new Error(`UserChart '${String(lite.id)}' not found`);
        return found;
    }

    // Every lookup below serves from `userChartsLazy`, whose factory runs in ExecutionMode.global — so the
    // row-level query filter never saw those reads, and each lookup applies the in-memory visibility filter
    // itself (Signum's `Schema.Current.GetInMemoryFilter<UserChartEntity>(userInterface: false)`).

    // Signum's GetUserCharts(queryName): the global (entityType == null) user charts registered against a
    // query.
    export async function getUserChartsForQuery(queryKey: string): Promise<Lite<UserChartEntity>[]> {
        const all = await userChartsLazy.value();
        const visible = await UserAssetOwnerAuth.filterVisible(
            all.filter(uc => uc.entityType == null && uc.query.key === queryKey));
        return visible.map(uc => uc.toLite() as Lite<UserChartEntity>);
    }

    // Signum's GetUserCharts(Type entityType) / GetUserChartsModel: the user charts scoped to (and offered as
    // quick-links of) a concrete entity type. altea matches by the TypeEntity's clean name (resolved to id).
    export async function getUserChartsForEntityType(typeCleanName: string): Promise<Lite<UserChartEntity>[]> {
        const typeRows = await table(TypeEntity).filter(t => t.cleanName == typeCleanName).toArray() as TypeEntity[];
        const typeId = typeRows[0]?.id;
        if (typeId == null)
            return [];

        const all = await userChartsLazy.value();
        const visible = await UserAssetOwnerAuth.filterVisible(
            all.filter(uc => uc.entityType != null && String(uc.entityType.id) === String(typeId)));
        return visible.map(uc => uc.toLite() as Lite<UserChartEntity>);
    }

    // Signum's RetrieveUserChart — the full entity for a lite (the client fetches this to run/edit it). In
    // altea the generic Navigator.API.fetch already retrieves it; this stays as the cache-hit fast path.
    export async function retrieveUserChart(id: string): Promise<UserChartEntity | undefined> {
        const all = await userChartsLazy.value();
        const cached = all.find(uc => String(uc.id) === String(id));
        if (cached == null)
            return undefined;
        return (await UserAssetOwnerAuth.isVisible(cached)) ? cached : undefined;
    }
}
