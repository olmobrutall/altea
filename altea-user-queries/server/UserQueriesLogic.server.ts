import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/fluentOperations"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { Lite } from "@altea/altea/data/lite";
import { UserQueryEntity, UserQueryOperation } from "../data/UserQuery";
import { QueryAuthLogic } from "@altea/altea-auth/server/QueryAuthLogic";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { UserAssetLogic } from "@altea/altea-user-assets/server/UserAssetLogic.server";
import { UserAssetOwnerAuth } from "@altea/altea-user-assets/server/UserAssetOwnerAuth.server";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { UserQueriesServer } from "./UserQueriesServer.server";
import { registerUserQueryXml } from "./UserQueriesXml.server";
import { registerUserQueryDashboardParts } from "./UserQueriesDashboardXml.server";
import { ToolbarLogic } from "@altea/altea-toolbar/server/ToolbarLogic.server";

// Port of Signum's UserQueryLogic.Start (Signum.UserQueries/UserQueryLogic.cs). Registers the UserQuery
// entity + its Save/Delete operations + query, the in-memory caches (Signum's ResetLazy GlobalLazys), the
// XML (de)serializer, and — when a web host is present — the HTTP surface.
//
// altea divergences, documented inline:
//  - Signum's server `ParseData` on Retrieved is dropped: altea resolves query tokens CLIENT-SIDE, so the
//    server never materialises a QueryToken from the stored tokenString.
//  - Owner scoping IS ported: registerUserTypeCondition / registerRoleTypeCondition below, plus the in-memory
//    visibility filter every lookup applies (see @altea/altea-user-assets' UserAssetOwnerAuth).
//  - CachedQuery / Omnibox WhenIncluded blocks are omitted (those extensions are not ported); the
//    QueryEntity PreDeleteSqlSync cascade is deferred with them. The DASHBOARD parts (see
//    registerUserQueryDashboardParts) and the TOOLBAR content config ARE registered.

// The registered QueryName lives in the query CONTAINER (`withQuery` registers there); QueryLogic's
// `toQueryName` reads a legacy name-only registry nothing populates, so an unknown key means "not allowed".
async function isQueryKeyAllowed(queryKey: string): Promise<boolean> {
    const queryName = QueryLogic.tryGetQueryNameByKey(queryKey);
    return queryName != null && await QueryAuthLogic.isQueryAllowed(queryName, true);
}

export namespace UserQueriesLogic {

    // Signum's `ResetLazy<FrozenDictionary<Lite<UserQueryEntity>, UserQueryEntity>> UserQueries`.
    export let userQueriesLazy: ResetLazy<UserQueryEntity[]> = null!;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(UserQueryEntity)
            .withSave(UserQueryOperation.Save)
            .withDelete(UserQueryOperation.Delete)
            .withQuery();

        // Start the shared user-asset infrastructure (permission + import/export HTTP surface).
        UserAssetLogic.start(sb);

        // Register how a UserQueryEntity is (de)serialized to/from XML (Signum keeps ToXml/FromXml on the
        // entity; altea uses a per-type registry — see UserAssetsImportExport.server).
        registerUserQueryXml();

        // The three UserQuery DASHBOARD parts: their XML (de)serializer + clone, registered with
        // @altea/altea-dashboard's part registry (Signum did this inside `sb.Schema.WhenIncluded<
        // DashboardEntity>` — in altea the registration is inert until a dashboard actually uses a part, and
        // the part TABLES only exist if the app lists them in DashboardEntity_Part.content's implementedBy).
        registerUserQueryDashboardParts();

        // The TOOLBAR content config for a UserQuery element (Signum's `new ToolbarContentConfig<
        // UserQueryEntity> { … }.Register()` inside `WhenIncluded<ToolbarEntity>`): its label, whether this
        // role may use it, and the query it runs. Registering into the toolbar's registry is INERT when the
        // toolbar module is not started; Signum's `ToolbarLogic.RegisterDelete<UserQueryEntity>` has no
        // counterpart here because ToolbarLogic derives its delete cascades from the content field's
        // @implementedBy list (see ToolbarLogic.start).
        ToolbarLogic.registerContentConfig(UserQueryEntity, {
            defaultLabel: async lite => (await getUserQuery(lite)).displayName,
            isAuthorized: async lite => {
                const uq = await getUserQuery(lite);
                return await ToolbarLogic.inMemoryFilter(uq)
                    && await isQueryKeyAllowed(uq.query.key);
            },
            getRelatedQuery: async lite => (await getUserQuery(lite)).query,
        });

        // Signum's GlobalLazy over all user queries, invalidated on any UserQueryEntity change.
        userQueriesLazy = sb.globalLazy(() => table(UserQueryEntity).toArray() as Promise<UserQueryEntity[]>,
            { invalidateWith: [UserQueryEntity] });

        if (sb.webBuilder)
            UserQueriesServer.start(sb.webBuilder);
    }

    /** The cached UserQuery behind a lite (Signum's `UserQueries.Value.GetOrCreate(lite)`). */
    async function getUserQuery(lite: Lite<UserQueryEntity>): Promise<UserQueryEntity> {
        const all = await userQueriesLazy.value();
        const found = all.find(uq => String(uq.id) === String(lite.id));
        if (found == null)
            throw new Error(`UserQuery '${String(lite.id)}' not found`);
        return found;
    }

    /** Signum's `UserQueryLogic.RegisterUserTypeCondition` — this query belongs to the current USER. */
    export function registerUserTypeCondition(typeCondition: TypeConditionSymbol): void {
        UserAssetOwnerAuth.registerUserTypeCondition(UserQueryEntity, typeCondition);
    }

    /** Signum's `UserQueryLogic.RegisterRoleTypeCondition` — global (no owner), or owned by one of the current
     *  user's roles. */
    export function registerRoleTypeCondition(typeCondition: TypeConditionSymbol): void {
        UserAssetOwnerAuth.registerRoleTypeCondition(UserQueryEntity, typeCondition);
    }

    // Every lookup below serves from `userQueriesLazy`, whose factory runs in ExecutionMode.global — so the
    // row-level query filter never saw those reads, and each lookup applies the in-memory visibility filter
    // itself (Signum's `Schema.Current.GetInMemoryFilter<UserQueryEntity>(userInterface: false)`).

    // Signum's GetUserQueries(queryName, appendFilters=false): the global (entityType == null) user queries
    // registered against a query, that are not the "append filters" contextual-menu variant.
    export async function getUserQueriesForQuery(queryKey: string): Promise<Lite<UserQueryEntity>[]> {
        const all = await userQueriesLazy.value();
        const visible = await UserAssetOwnerAuth.filterVisible(
            all.filter(uq => uq.entityType == null && !uq.appendFilters && uq.query.key === queryKey));
        return visible.map(uq => uq.toLite() as Lite<UserQueryEntity>);
    }

    // Signum's GetUserQueries(queryName, appendFilters=true): the contextual-menu "use to filter current
    // grouping" variant (Signum's getGroupUserQueriesContextMenu).
    export async function getUserQueriesForQueryAppendFilters(queryKey: string): Promise<Lite<UserQueryEntity>[]> {
        const all = await userQueriesLazy.value();
        const visible = await UserAssetOwnerAuth.filterVisible(
            all.filter(uq => uq.entityType == null && uq.appendFilters && uq.query.key === queryKey));
        return visible.map(uq => uq.toLite() as Lite<UserQueryEntity>);
    }

    // Signum's GetUserQueries(Type entityType): the user queries scoped to (and offered as quick-links of)
    // a concrete entity type. altea matches by the TypeEntity's clean name (resolved to its id).
    export async function getUserQueriesForEntityType(typeCleanName: string): Promise<Lite<UserQueryEntity>[]> {
        const typeRows = await table(TypeEntity).filter(t => t.cleanName == typeCleanName).toArray() as TypeEntity[];
        const typeId = typeRows[0]?.id;
        if (typeId == null)
            return [];

        const all = await userQueriesLazy.value();
        const visible = await UserAssetOwnerAuth.filterVisible(
            all.filter(uq => uq.entityType != null && String(uq.entityType.id) === String(typeId)));
        return visible.map(uq => uq.toLite() as Lite<UserQueryEntity>);
    }

    // Signum's RetrieveUserQuery — the full entity for a lite (the client fetches this to run/edit it). In
    // altea the generic Navigator.API.fetch already retrieves it; this stays as the cache-hit fast path.
    export async function retrieveUserQuery(id: string): Promise<UserQueryEntity | undefined> {
        const all = await userQueriesLazy.value();
        const cached = all.find(uq => String(uq.id) === String(id));
        if (cached == null)
            return undefined;
        if (!await UserAssetOwnerAuth.isVisible(cached))
            return undefined;

        // Signum wraps this in `using (ViewLogLogic.LogView(userQuery, "UserQuery"))`, which makes
        // Signum.UserQueries depend on Signum.ViewLog. altea reports through the CORE seam instead
        // (`ExecutionMode.onApiRetrieved`, added for @altea/altea-view-log), so this module stays
        // independent of an optional one and nothing happens when no observer is installed.
        const after = await ExecutionMode.apiRetrievedScope(cached.toLite(), "UserQuery");
        await after?.();
        return cached;
    }
}
