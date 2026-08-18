import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, type PrimaryKey } from "@altea/altea/data/entity";
import { Lite, LiteImp, registerCustomLite } from "@altea/altea/data/lite";
import {
    entity, primaryKey, backReference, rowOrder, valueField, implementedBy,
    stringLengthValidator, quoted,
} from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import { FilterOperationEnum, FilterGroupOperationEnum, DashboardBehaviourEnum } from "@altea/altea/data/dynamicQueries";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { QueryTokenEmbedded, PinnedQueryFilterEmbedded, QueryFilterBaseEntity } from "@altea/altea-user-assets/data/Queries";
import { type IUserAssetEntity, type IHasEntityType } from "@altea/altea-user-assets/data/UserAssets";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import { ChartScriptSymbol } from "./ChartScript";
import { ChartColumnEmbedded } from "./ChartColumn";
import { ChartParameterEmbedded } from "./ChartParameter";
import { ChartTimeSeriesEmbedded } from "./ChartRequest";

// Port of Signum's Signum.Chart/UserChart/UserChart.cs (UserChartEntity). A UserChart is a user-authored,
// saved chart definition (a chart script + column/parameter bindings + filters) over a registered query,
// portable via XML (IUserAssetEntity) and optionally scoped to an entity type (IHasEntityType). It is the
// direct analogue of the UserQuery port (@altea/altea-user-queries) — this file mirrors data/UserQuery.ts.
//
// altea divergences, documented inline:
//  - Signum's `UserChartEntity : ... IChartBase` is NOT reproduced. IChartBase requires
//    `columns: ChartColumnEmbedded[]` / `parameters: ChartParameterEmbedded[]` (plain embedded arrays), but
//    altea cannot persist an EmbeddedEntity array on a real table — only `PartEntity[]` collections exist
//    (SchemaBuilder). So the persisted collections are per-owner `@part` rows that WRAP the shared chart
//    value objects on an `element` embedded (Signum's shared `MList<ChartColumnEmbedded>` / `MList<
//    ChartParameterEmbedded>` element). The Converter (UserChartClient) maps a UserChart to a
//    ChartRequestModel — which IS the altea IChartBase — at view time.
//  - Signum's `MList<QueryFilterEmbedded>` (a UserAssets shared embedded) likewise becomes a per-owner
//    `@part` filter row (single-owner in altea — see data/UserQuery.ts's identical note). The owner-agnostic
//    value embeddeds (QueryTokenEmbedded, PinnedQueryFilterEmbedded) stay shared in @altea/altea-user-assets,
//    as does the filter row's member set (QueryFilterBaseEntity, subclassed here with just a backReference).
//  - Signum's `Guid Guid` [UniqueIndex] portable-identity field → a uuid PRIMARY KEY (`@primaryKey("uuid")`),
//    exactly as UserQueryEntity does; the `id` IS the stable, portable identity used by XML import/export.
//  - Signum's `ToXml`/`FromXml`/`ParseData`/`SynchronizeColumns`/`PostRetrieving`/`PropertyValidation` are
//    server-only (System.Xml + QueryDescription) — they live in UserChartXml.server.ts / UserChartLogic.
//  - The Dashboard part entities (UserChartPartEntity / CombinedUserChartPartEntity), Toolbar/Omnibox
//    integration, and CachedQuery are DEFERRED (those extensions are not ported to altea).

// ---- Collection element rows (Signum's shared MLists, here UserChart-owned @part rows) -----------------

// Signum's QueryFilterEmbedded (Signum.UserAssets/Queries/QueryFilterEmbedded.cs), owned by UserChartEntity
// (Signum's [PreserveOrder, BindParent]). Every member lives on the shared QueryFilterBaseEntity in
// @altea/altea-user-assets: a @part row has exactly ONE owner (and each part class name must be unique in the
// type registry), so a UserChart filter is that base plus its own `@backReference` — nothing else. Sharing the
// base is what lets altea-user-queries' FilterBuilderEmbedded edit a chart's filters too.
@entity("Part")
export class UserChartEntity_Filter extends QueryFilterBaseEntity {
    @backReference userChart: Lite<UserChartEntity>;
}

// Signum's `[BindParent, PreserveOrder] MList<ChartColumnEmbedded> Columns` element. altea wraps the shared
// ChartColumnEmbedded value object as `element` on a @part row (the persisted-collection idiom above).
@entity("Part")
export class UserChartEntity_Column extends Entity {
    @backReference userChart: Lite<UserChartEntity>;
    @rowOrder order: int;
    element: ChartColumnEmbedded;
}

// Signum's `[NoRepeatValidator] MList<ChartParameterEmbedded> Parameters` element (wrapped as above).
@entity("Part")
export class UserChartEntity_Parameter extends Entity {
    @backReference userChart: Lite<UserChartEntity>;
    @rowOrder order: int;
    element: ChartParameterEmbedded;
}

// Signum's `[NoRepeatValidator, PreserveOrder, ImplementedBy(UserQueryEntity)] MList<Lite<Entity>>
// CustomDrilldowns`. altea MList-of-lite → a @part value row (mirrors UserQueryEntity_CustomDrilldown).
@entity("Part")
export class UserChartEntity_CustomDrilldown extends Entity {
    @backReference userChart: Lite<UserChartEntity>;
    @rowOrder order: int;
    @valueField @implementedBy(() => [UserQueryEntity]) drilldown: Lite<UserQueryEntity>;
}

// ---- The UserChart entity ------------------------------------------------------------------------------

// altea divergence (see file header): the Guid portable-identity is a uuid PRIMARY KEY, so IUserAssetEntity
// is a bare marker. IHasEntityType carries the `entityType` quick-link scope.
@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class UserChartEntity extends Entity implements IUserAssetEntity, IHasEntityType {
    query: QueryEntity;

    // Signum's `Lite<TypeEntity>? EntityType` — the entity type this UserChart is a quick-link of.
    entityType: Lite<TypeEntity> | null;

    hideQuickLink: boolean = false;

    // Signum's `Lite<Entity>? Owner` — AssertImplementedBy(User, Role) in logic. Whose UserChart this is
    // (a personal one → a User; a shared one → a Role; null → global).
    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null;

    @stringLengthValidator({ min: 3, max: 200 })
    displayName: string;

    includeDefaultFilters: boolean | null;

    maxRows: int | null;

    chartTimeSeries: ChartTimeSeriesEmbedded | null;

    // Signum's ChartScript SETTER (which runs SynchronizeColumns) has no altea equivalent (no property
    // setters); the editor / Converter call ChartClient.synchronizeColumns on change.
    chartScript: ChartScriptSymbol;

    // Signum's [NoRepeatValidator] MList<ChartParameterEmbedded>.
    parameters: UserChartEntity_Parameter[];

    // Signum's [BindParent, PreserveOrder] MList<ChartColumnEmbedded>.
    columns: UserChartEntity_Column[];

    // Signum's [PreserveOrder, BindParent] MList<QueryFilterEmbedded>.
    filters: UserChartEntity_Filter[];

    // Signum's [NoRepeatValidator, PreserveOrder, ImplementedBy(UserQueryEntity)] MList<Lite<Entity>>.
    customDrilldowns: UserChartEntity_CustomDrilldown[];

    @quoted
    toString(): string {
        return this.displayName;
    }
}

// Signum's UserChartLiteModel (UserChart.cs) — the custom Lite that carries just enough for the quick-link
// UI without fetching the whole entity (toStr = DisplayName + HideQuickLink). altea's custom-lite idiom is
// a LiteImp subclass carrying the model fields DIRECTLY on the lite (no `.model`) — mirrors UserQueryLite.
export class UserChartLite extends LiteImp<UserChartEntity> {
    constructor(
        id: PrimaryKey, toStr: string,
        readonly hideQuickLink: boolean,
    ) {
        super(id, UserChartEntity, toStr);
    }
    static isCompatible(json: Record<string, unknown>): boolean {
        return typeof json.hideQuickLink === "boolean";
    }
    static fromJson(json: Record<string, unknown>): Lite<UserChartEntity> {
        return new UserChartLite(json.id as PrimaryKey, (json.toStr as string) ?? "",
            json.hideQuickLink as boolean);
    }
}

// The DEFAULT custom lite for UserChartEntity: `toLite(uc)` (and query projections) yield a UserChartLite
// carrying the display name + quick-link flag. The `fromEntity` lambda is transformer-quoted so the query
// provider can project the columns in SQL (like UserQueryLite / BandLite).
registerCustomLite(UserChartEntity, UserChartLite,
    uc => new UserChartLite(uc.id, uc.displayName, uc.hideQuickLink), true);

// Signum's `[AutoInit] static class UserChartOperation`.
export namespace UserChartOperation {
    export const Save: ExecuteSymbol<UserChartEntity> = init();
    export const Delete: DeleteSymbol<UserChartEntity> = init();
}
