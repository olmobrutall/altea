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

// Port of Signum's UserChartLogic.Start (Signum.Chart/UserChart/UserChartLogic.cs). Registers the UserChart
// entity + its Save/Delete operations + query, the in-memory caches (Signum's ResetLazy GlobalLazys), the
// XML (de)serializer, and — when a web host is present — the HTTP surface. Mirrors UserQueriesLogic.
//
// altea divergences, documented inline:
//  - Signum's server `ParseData` / `SynchronizeColumns` on Retrieved is dropped: altea resolves query tokens
//    and synchronizes chart columns CLIENT-SIDE (UserChartClient.Converter), so the server never
//    materialises a QueryToken or a ChartScript definition from stored strings.
//  - The auth in-memory visibility filter (Signum's `Schema.GetInMemoryFilter<UserChartEntity>`) and the
//    owner-scoped personal/role visibility are TODO (routes gate on ViewCharting); the type-auth retrieve
//    gate already applies on the entity itself.
//  - Toolbar / Dashboard / CachedQuery / Omnibox WhenIncluded blocks + TokenMigration are omitted (those
//    extensions / the interactive terminal sync are not ported); the QueryEntity PreDeleteSqlSync cascade is
//    deferred with them.

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

        // Signum's GlobalLazy over all user charts, invalidated on any UserChartEntity change.
        userChartsLazy = sb.globalLazy(() => table(UserChartEntity).toArray() as Promise<UserChartEntity[]>,
            { invalidateWith: [UserChartEntity] });

        if (sb.webBuilder)
            UserChartServer.start(sb.webBuilder);
    }

    // Signum's GetUserCharts(queryName): the global (entityType == null) user charts registered against a
    // query.
    export async function getUserChartsForQuery(queryKey: string): Promise<Lite<UserChartEntity>[]> {
        const all = await userChartsLazy.value();
        return all
            .filter(uc => uc.entityType == null && uc.query.key === queryKey)
            .map(uc => uc.toLite() as Lite<UserChartEntity>);
    }

    // Signum's GetUserCharts(Type entityType) / GetUserChartsModel: the user charts scoped to (and offered as
    // quick-links of) a concrete entity type. altea matches by the TypeEntity's clean name (resolved to id).
    export async function getUserChartsForEntityType(typeCleanName: string): Promise<Lite<UserChartEntity>[]> {
        const typeRows = await table(TypeEntity).filter(t => t.cleanName == typeCleanName).toArray() as TypeEntity[];
        const typeId = typeRows[0]?.id;
        if (typeId == null)
            return [];

        const all = await userChartsLazy.value();
        return all
            .filter(uc => uc.entityType != null && String(uc.entityType.id) === String(typeId))
            .map(uc => uc.toLite() as Lite<UserChartEntity>);
    }

    // Signum's RetrieveUserChart — the full entity for a lite (the client fetches this to run/edit it). In
    // altea the generic Navigator.API.fetch already retrieves it; this stays as the cache-hit fast path.
    export async function retrieveUserChart(id: string): Promise<UserChartEntity | undefined> {
        const all = await userChartsLazy.value();
        return all.find(uc => String(uc.id) === String(id));
    }
}
