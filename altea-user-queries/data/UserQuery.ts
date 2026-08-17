import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity, type PrimaryKey } from "@altea/altea/data/entity";
import { Lite, LiteImp, registerCustomLite } from "@altea/altea/data/lite";
import {
    entity, primaryKey, backReference, rowOrder, valueField, implementedBy,
    stringLengthValidator, fieldValidation, quoted,
} from "@altea/altea/data/decorators";
import { Temporal, type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import {
    RefreshModeEnum, ColumnOptionsModeEnum, PaginationModeEnum, FilterOperationEnum, FilterGroupOperationEnum,
    OrderTypeEnum, CombineRowsEnum, DashboardBehaviourEnum, SystemTimeModeEnum, SystemTimeJoinModeEnum, TimeSeriesUnitEnum,
} from "@altea/altea/data/dynamicQueries";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { QueryTokenEmbedded, PinnedQueryFilterEmbedded } from "@altea/altea-user-assets/data/Queries";
import { type IUserAssetEntity, type IHasEntityType } from "@altea/altea-user-assets/data/UserAssets";

// Port of Signum's Signum.UserQueries/UserQueryEntity.cs. A UserQuery is a user-authored, saved query
// definition (filters + columns + orders + pagination + optional system-time) over a registered query,
// portable via XML (IUserAssetEntity) and optionally scoped to an entity type (IHasEntityType).
//
// altea divergences, documented inline:
//  - Signum's shared `MList<QueryFilterEmbedded>` / `MList<QueryColumnEmbedded>` / `MList<QueryOrderEmbedded>`
//    (EmbeddedEntity types reused across UserQuery/UserChart/Dashboard) become altea per-owner `@part`
//    collection rows (a Part has exactly ONE concrete owner in altea — see schemaBuilder/PartOwnership),
//    so the row entities live HERE with their owner. The truly owner-agnostic value embeddeds
//    (QueryTokenEmbedded, PinnedQueryFilterEmbedded) stay shared in @altea/altea-user-assets.
//  - Signum's `ToXml`/`FromXml`/`ParseData`/`GetPagination` (System.Xml + server QueryDescription) are
//    server-only in altea — they live in UserQueriesXml.server.ts / UserQueriesLogic.server.ts, not on the
//    isomorphic entity.
//  - `entityType`'s C# setter (clears ShowTitleAsBreadcrumb when null) is handled in the editor's onChange
//    (altea entities are plain field bags, no property setters).
//  - The Dashboard part entities (BigValuePart/UserQueryPart/ValueUserQueryListPart), Toolbar/Omnibox
//    integration, and HealthCheck's server side are DEFERRED (missing extensions) — HealthCheck* is kept
//    as an isomorphic model so the editor can round-trip it.

// ---- Collection element rows (Signum's shared MList<QueryXEmbedded>, here UserQuery-owned @part rows) ----

// Signum's QueryFilterEmbedded (Signum.UserAssets/Queries/QueryFilterEmbedded.cs). One filter row: either
// a condition (token + operation + valueString) or a group header (isGroup + groupOperation), positioned
// in the filter tree by `indentation`. Owned by UserQueryEntity (Signum's [PreserveOrder, BindParent]).
@entity("Part")
export class QueryFilterEmbedded extends Entity {
    @backReference userQuery: Lite<UserQueryEntity>;
    @rowOrder order: int = toInt(0);

    token: QueryTokenEmbedded | null = null;
    isGroup: boolean = false;
    // Real altea enums (int FK to the enum table, translatable) — Signum's enum columns. The in-memory
    // value is the numeric ordinal; the wire/XML/query form is the member name (Enum.toName). See dynamicQueries.
    groupOperation: FilterGroupOperationEnum | null = null;
    operation: FilterOperationEnum | null = null;
    valueString: string | null = null;
    pinned: PinnedQueryFilterEmbedded | null = null;
    dashboardBehaviour: DashboardBehaviourEnum | null = null;
    indentation: int = toInt(0);
}

// Signum's QueryColumnEmbedded (Queries/QueryColumnEmbedded.cs). One result column: a token, an optional
// display name / summary (aggregate) token, hidden flag, and combine-rows behaviour.
@entity("Part")
export class QueryColumnEmbedded extends Entity {
    @backReference userQuery: Lite<UserQueryEntity>;
    @rowOrder order: int = toInt(0);

    token: QueryTokenEmbedded;
    displayName: string | null = null;
    summaryToken: QueryTokenEmbedded | null = null;
    hiddenColumn: boolean = false;
    combineRows: CombineRowsEnum | null = null;
}

// Signum's QueryOrderEmbedded (Queries/QueryOrderEmbedded.cs). One sort: a token + Ascending/Descending.
@entity("Part")
export class QueryOrderEmbedded extends Entity {
    @backReference userQuery: Lite<UserQueryEntity>;
    @rowOrder order: int = toInt(0);

    token: QueryTokenEmbedded;
    orderType: OrderTypeEnum = OrderTypeEnum.Ascending;
}

// Signum's `MList<Lite<Entity>> CustomDrilldowns` ([ImplementedBy(UserQueryEntity)], PreserveOrder,
// NoRepeat). altea MList-of-lite → a @part value row.
@entity("Part")
export class UserQueryEntity_CustomDrilldowns extends Entity {
    @backReference userQuery: Lite<UserQueryEntity>;
    @rowOrder order: int = toInt(0);
    @valueField @implementedBy(() => [UserQueryEntity]) drilldown: Lite<UserQueryEntity>;
}

// ---- Embedded value types owned by UserQuery -----------------------------------------------------------

// Signum's SystemTimeEmbedded (UserQueryEntity.cs). The optional system-versioned / time-series window.
@reflect
export class SystemTimeEmbedded extends EmbeddedEntity {
    mode: SystemTimeModeEnum = SystemTimeModeEnum.AsOf;
    // altea divergence: Signum stores StartDate/EndDate as `string?` (to allow smart/relative-date
    // expressions parsed at query time). altea has not ported that grammar, so these are the most
    // appropriate Temporal type — a system-versioned window is a point in time WITH a time component.
    startDate: Temporal.PlainDateTime | null = null;
    endDate: Temporal.PlainDateTime | null = null;
    joinMode: SystemTimeJoinModeEnum | null = null;
    timeSeriesUnit: TimeSeriesUnitEnum | null = null;
    timeSeriesStep: int | null = null;
    timeSeriesMaxRowsPerStep: int | null = null;
    splitQueries: boolean = false;
}

// Signum's HealthCheckConditionEmbedded (UserQueryEntity.cs). A "{count} {op} {value}" threshold.
@reflect
export class HealthCheckConditionEmbedded extends EmbeddedEntity {
    operation: FilterOperationEnum = FilterOperationEnum.GreaterThan;
    value: int = toInt(0);
}

// Signum's HealthCheckEmbedded (UserQueryEntity.cs). Optional fail / degraded thresholds on the row count.
@reflect
export class HealthCheckEmbedded extends EmbeddedEntity {
    failWhen: HealthCheckConditionEmbedded | null = null;
    degradedWhen: HealthCheckConditionEmbedded | null = null;
}

// ---- The UserQuery entity ------------------------------------------------------------------------------

// altea divergence: Signum's `Guid Guid = Guid.NewGuid()` [UniqueIndex] portable-identity field is
// replaced by a uuid PRIMARY KEY (`@primaryKey("uuid")`). The `id` IS the stable, portable identity used
// by XML export/import — so IUserAssetEntity is a bare marker (no `guid` field) and there is no separate
// unique index. (Import sets `entity.id` to the incoming uuid before saving.)
@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class UserQueryEntity extends Entity implements IUserAssetEntity, IHasEntityType {
    query: QueryEntity;

    groupResults: boolean = false;

    // Signum's `Lite<TypeEntity>? EntityType` — a plain reference to the type registry row (the entity
    // type this UserQuery is a quick-link of), not a polymorphic reference.
    entityType: Lite<TypeEntity> | null = null;

    hideQuickLink: boolean = false;

    showTitleAsBreadcrumb: boolean = false;

    includeDefaultFilters: boolean | null = null;

    // Signum's `Lite<Entity>? Owner` — AssertImplementedBy(User, Role) in logic. Whose UserQuery this is
    // (a personal one → a User; a shared one → a Role; null → global).
    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null = null;

    @stringLengthValidator({ min: 1, max: 200 })
    displayName: string = "";

    appendFilters: boolean = false;

    refreshMode: RefreshModeEnum = RefreshModeEnum.Auto;

    // Signum's [PreserveOrder, BindParent] MList<QueryFilterEmbedded>.
    filters: QueryFilterEmbedded[];

    // Signum's [PreserveOrder] MList<QueryOrderEmbedded>.
    orders: QueryOrderEmbedded[];

    columnsMode: ColumnOptionsModeEnum = ColumnOptionsModeEnum.Add;

    // Signum's [PreserveOrder] MList<QueryColumnEmbedded>.
    columns: QueryColumnEmbedded[];

    paginationMode: PaginationModeEnum | null = null;

    // Signum's [NumberIsValidator(GreaterThanOrEqualTo, 1)] — only set for Firsts/Paginate.
    @fieldValidation<UserQueryEntity>(uq =>
        uq.elementsPerPage != null && uq.elementsPerPage < 1
            ? UserQueryMessage.ElementsPerPageMustBeGreaterThanZero.niceToString()
            : null)
    elementsPerPage: int | null = null;

    systemTime: SystemTimeEmbedded | null = null;

    healthCheck: HealthCheckEmbedded | null = null;

    // Signum's [PreserveOrder, NoRepeatValidator, ImplementedBy(UserQueryEntity)] MList<Lite<Entity>>.
    customDrilldowns: UserQueryEntity_CustomDrilldowns[];

    @quoted
    toString(): string {
        return this.displayName;
    }
}

// Signum's UserQueryLiteModel (UserQueryEntity.cs) — the custom Lite that carries just enough for the
// quick-link / menu UI without fetching the whole entity (toStr = DisplayName + the two quick-link flags).
//
// altea divergence: Signum ships a separate `UserQueryLiteModel : ModelEntity` reached via `lite.model`;
// altea's custom-lite idiom is a `LiteImp` subclass carrying the model fields DIRECTLY on the lite (no
// `.model`) — so the client reads `(uq as UserQueryLite).hideQuickLink`, not `uq.model.hideQuickLink`.
export class UserQueryLite extends LiteImp<UserQueryEntity> {
    constructor(
        id: PrimaryKey, toStr: string,
        readonly hideQuickLink: boolean,
        readonly showTitleAsBreadcrumb: boolean,
    ) {
        super(id, UserQueryEntity, toStr);
    }
    static isCompatible(json: Record<string, unknown>): boolean {
        return typeof json.hideQuickLink === "boolean";
    }
    static fromJson(json: Record<string, unknown>): Lite<UserQueryEntity> {
        return new UserQueryLite(json.id as PrimaryKey, (json.toStr as string) ?? "",
            json.hideQuickLink as boolean, json.showTitleAsBreadcrumb as boolean);
    }
}

// The DEFAULT custom lite for UserQueryEntity: `toLite(uq)` (and query projections) yield a UserQueryLite
// carrying the display name + quick-link flags. The `fromEntity` lambda is transformer-quoted so the query
// provider can project the columns in SQL (like BandLite).
registerCustomLite(UserQueryEntity, UserQueryLite,
    uq => new UserQueryLite(uq.id, uq.displayName, uq.hideQuickLink, uq.showTitleAsBreadcrumb), true);

// Signum's `[AutoInit] static class UserQueryPermission`.
export namespace UserQueryPermission {
    export const ViewUserQuery: PermissionSymbol = init();
}

// Signum's `[AutoInit] static class UserQueryOperation`.
export namespace UserQueryOperation {
    export const Save: ExecuteSymbol<UserQueryEntity> = init();
    export const Delete: DeleteSymbol<UserQueryEntity> = init();
}

// Signum's UserQueryMessage (UserQueryEntity.cs / resx).
export const UserQueryMessage = {
    Edit: msg(),
    CreateNew: msg("Create"),
    BackToDefault: msg("Back to Default"),
    ApplyChanges: msg("Apply changes"),
    Use0ToFilterCurrentEntity: msg("Use {0} to filter current entity"),
    Preview: msg(),
    MakesThe0AvailableForCustomDrilldownsAndInContextualMenuWhenGrouping0: msg("Makes the {0} available for Custom Drilldowns and in the contextual menu when grouping {1}"),
    MakesThe0AvailableAsAQuickLinkOf1: msg("Makes the {0} available as Quick Link of {1}"),
    TheSelected0: msg("the selected {0}"),
    Date: msg(),
    Pagination: msg(),
    _0CountOf1Is2Than3: msg("{0} count of {1} is {2} than {3}"),
    // altea-only: the NumberIsValidator message for elementsPerPage.
    ElementsPerPageMustBeGreaterThanZero: msg("Elements per page must be greater than or equal to 1"),
};
