import "@altea/altea/server"; // installs Entity.save()/delete()
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { Lite } from "@altea/altea/data/lite";
import { UserQueryEntity, UserQueryOperation } from "../data/UserQuery";
import { UserAssetLogic } from "@altea/altea-user-assets/server/UserAssetLogic.server";
import { UserQueriesServer } from "./UserQueriesServer.server";
import { registerUserQueryXml } from "./UserQueriesXml.server";

// Port of Signum's UserQueryLogic.Start (Signum.UserQueries/UserQueryLogic.cs). Registers the UserQuery
// entity + its Save/Delete operations + query, the in-memory caches (Signum's ResetLazy GlobalLazys), the
// XML (de)serializer, and — when a web host is present — the HTTP surface.
//
// altea divergences, documented inline:
//  - Signum's server `ParseData` on Retrieved is dropped: altea resolves query tokens CLIENT-SIDE, so the
//    server never materialises a QueryToken from the stored tokenString.
//  - The auth in-memory visibility filter (Signum's `Schema.GetInMemoryFilter<UserQueryEntity>`) and the
//    owner-scoped personal/role visibility are TODO (routes still assert ViewUserQuery); the type-auth
//    retrieve gate already applies on the entity itself.
//  - Toolbar / Dashboard / CachedQuery / Omnibox WhenIncluded blocks are omitted (those extensions are not
//    ported); the QueryEntity PreDeleteSqlSync cascade is deferred with them.

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

        // Signum's GlobalLazy over all user queries, invalidated on any UserQueryEntity change.
        userQueriesLazy = sb.globalLazy(() => table(UserQueryEntity).toArray() as Promise<UserQueryEntity[]>,
            { invalidateWith: [UserQueryEntity] });

        if (sb.webBuilder)
            UserQueriesServer.start(sb.webBuilder);
    }

    // Signum's GetUserQueries(queryName, appendFilters=false): the global (entityType == null) user queries
    // registered against a query, that are not the "append filters" contextual-menu variant.
    export async function getUserQueriesForQuery(queryKey: string): Promise<Lite<UserQueryEntity>[]> {
        const all = await userQueriesLazy.value();
        return all
            .filter(uq => uq.entityType == null && !uq.appendFilters && uq.query.key === queryKey)
            .map(uq => uq.toLite() as Lite<UserQueryEntity>);
    }

    // Signum's GetUserQueries(queryName, appendFilters=true): the contextual-menu "use to filter current
    // grouping" variant (Signum's getGroupUserQueriesContextMenu).
    export async function getUserQueriesForQueryAppendFilters(queryKey: string): Promise<Lite<UserQueryEntity>[]> {
        const all = await userQueriesLazy.value();
        return all
            .filter(uq => uq.entityType == null && uq.appendFilters && uq.query.key === queryKey)
            .map(uq => uq.toLite() as Lite<UserQueryEntity>);
    }

    // Signum's GetUserQueries(Type entityType): the user queries scoped to (and offered as quick-links of)
    // a concrete entity type. altea matches by the TypeEntity's clean name (resolved to its id).
    export async function getUserQueriesForEntityType(typeCleanName: string): Promise<Lite<UserQueryEntity>[]> {
        const typeRows = await table(TypeEntity).filter(t => t.cleanName == typeCleanName).toArray() as TypeEntity[];
        const typeId = typeRows[0]?.id;
        if (typeId == null)
            return [];

        const all = await userQueriesLazy.value();
        return all
            .filter(uq => uq.entityType != null && String(uq.entityType.id) === String(typeId))
            .map(uq => uq.toLite() as Lite<UserQueryEntity>);
    }

    // Signum's RetrieveUserQuery — the full entity for a lite (the client fetches this to run/edit it). In
    // altea the generic Navigator.API.fetch already retrieves it; this stays as the cache-hit fast path.
    export async function retrieveUserQuery(id: string): Promise<UserQueryEntity | undefined> {
        const all = await userQueriesLazy.value();
        return all.find(uq => String(uq.id) === String(id));
    }
}
