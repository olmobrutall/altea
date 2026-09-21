import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity, type PrimaryKey } from "@altea/altea/data/entity";
import { Lite, LiteImp, registerCustomLite } from "@altea/altea/data/lite";
import {
    backReference, entity, part, implementedBy, primaryKey, quoted, rowOrder, translatable, valueField,
    legacyColumnName,
} from "@altea/altea/data/decorators";
import { validate, noRepeatValidator, stringLengthValidator, numberIsValidator, ComparisonType, ValidationMessage } from "@altea/altea/data/validators";
import { Temporal, type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import {
    RefreshMode, ColumnOptionsMode, PaginationMode, FilterOperation, FilterGroupOperation,
    OrderType, CombineRows, DashboardBehaviour, SystemTimeMode, SystemTimeJoinMode, TimeSeriesUnit,
} from "@altea/altea/data/dynamicQueries";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { PermissionSymbol } from "@altea/altea/data/permissionSymbol";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { QueryTokenEmbedded, PinnedQueryFilterEmbedded, QueryFilterPinnedBaseEntity } from "@altea/altea-user-assets/data/Queries";
import { type IUserAssetEntity, type IHasEntityType } from "@altea/altea-user-assets/data/UserAssets";

// Port of Signum's Signum.UserQueries/UserQueryEntity.cs. A UserQuery is a user-authored, saved query
// definition (filters + columns + orders + pagination + optional system-time) over a registered query,
// portable via XML (IUserAssetEntity) and optionally scoped to an entity type (IHasEntityType).
//
// altea divergences, documented inline:
//  - Signum's shared `MList<QueryFilterEmbedded>` / `MList<QueryColumnEmbedded>` / `MList<QueryOrderEmbedded>`
//    (EmbeddedEntity types reused across UserQuery/UserChart/Dashboard) become altea per-owner `@part`
//    collection rows (a Part has exactly ONE concrete owner in altea — see schemaBuilder/PartOwnership),
//    so the row entities live HERE with their owner. What IS owner-agnostic stays shared in
//    @altea/altea-user-assets: the value embeddeds (QueryTokenEmbedded, PinnedQueryFilterEmbedded) and the
//    filter row's members (QueryFilterBaseEntity — the owner subclasses it and adds only its backReference).
//  - Signum's `ToXml`/`FromXml`/`ParseData`/`GetPagination` (System.Xml + server QueryDescription) are
//    server-only in altea — they live in UserQueriesXml.server.ts / UserQueriesLogic.server.ts, not on the
//    isomorphic entity.
//  - `entityType`'s C# setter (clears ShowTitleAsBreadcrumb when null) is handled in the editor's onChange
//    (altea entities are plain field bags, no property setters).
//  - The Dashboard part entities (BigValuePart/UserQueryPart/ValueUserQueryListPart), Toolbar/Omnibox
//    integration, and HealthCheck's server side are DEFERRED (missing extensions) — HealthCheck* is kept
//    as an isomorphic model so the editor can round-trip it.

// ---- Collection element rows (Signum's shared MList<QueryXEmbedded>, here UserQuery-owned @part rows) ----

// Signum's QueryFilterEmbedded (Signum.UserAssets/Queries/QueryFilterEmbedded.cs), owned by UserQueryEntity
// (Signum's [PreserveOrder, BindParent]). Every member lives on the shared QueryFilterBaseEntity in
// @altea/altea-user-assets — a @part row has exactly ONE owner, so an owner adds nothing but its
// `@backReference` (UserChartEntity_Filter is the same class with a different owner).
@part
// Signum declares this collection `[PrimaryKey(typeof(Guid))]` — "the row id identifies the element in
// the XML" — so the id is written per row on export and MATCHED on import, which is what lets a row keep
// its identity across databases (see UserAssetsImporter.syncRows).
@primaryKey("uuid")
export class UserQueryEntity_Filter extends QueryFilterPinnedBaseEntity {
    @backReference userQuery: Lite<UserQueryEntity>;
}

// Signum's QueryColumnEmbedded (Queries/QueryColumnEmbedded.cs). One result column: a token, an optional
// display name / summary (aggregate) token, hidden flag, and combine-rows behaviour.
@part
// Signum declares this collection `[PrimaryKey(typeof(Guid))]` — "the row id identifies the element in
// the XML" — so the id is written per row on export and MATCHED on import, which is what lets a row keep
// its identity across databases (see UserAssetsImporter.syncRows).
@primaryKey("uuid")
export class UserQueryEntity_Column extends Entity {
    @backReference userQuery: Lite<UserQueryEntity>;
    @legacyColumnName("Order")
    @rowOrder rowOrder: int;

    token: QueryTokenEmbedded;
    displayName: string | null;
    summaryToken: QueryTokenEmbedded | null;
    hiddenColumn: boolean = false;
    combineRows: CombineRows | null;

    /** Signum's QueryColumnEmbedded.Clone(). `order` / the `@backReference` are left to the save cascade. */
    clone(): UserQueryEntity_Column {
        return UserQueryEntity_Column.create({
            token: this.token.clone(),
            displayName: this.displayName,
            summaryToken: this.summaryToken?.clone() ?? null,
            hiddenColumn: this.hiddenColumn,
            combineRows: this.combineRows,
        });
    }
}

// Signum's QueryOrderEmbedded (Queries/QueryOrderEmbedded.cs). One sort: a token + Ascending/Descending.
@part
export class UserQueryEntity_Order extends Entity {
    @backReference userQuery: Lite<UserQueryEntity>;
    @legacyColumnName("Order")
    @rowOrder rowOrder: int;

    token: QueryTokenEmbedded;
    orderType: OrderType = OrderType.Ascending;

    /** Signum's QueryOrderEmbedded.Clone(). */
    clone(): UserQueryEntity_Order {
        return UserQueryEntity_Order.create({ token: this.token.clone(), orderType: this.orderType });
    }
}

// Signum's `MList<Lite<Entity>> CustomDrilldowns` ([ImplementedBy(UserQueryEntity)], PreserveOrder,
// NoRepeat). altea MList-of-lite → a @part value row.
@part
export class UserQueryEntity_CustomDrilldown extends Entity {
    @backReference userQuery: Lite<UserQueryEntity>;
    @legacyColumnName("Order")
    @rowOrder rowOrder: int;
    // DECLARED `Lite<Entity>` and NARROWED by `@implementedBy`, exactly as Signum declares it
    // (`[ImplementedBy(typeof(UserQueryEntity))] MList<Lite<Entity>>`). The declared type is what names
    // the column of an MList element in legacy mode — `EntityID_UserQuery`, the implementation supplying
    // only the suffix — and it is also the real contract: a drilldown target is open, and the
    // implementations list is the only thing that constrains it.
    @valueField @implementedBy(() => [UserQueryEntity]) drilldown: Lite<Entity>;

    /** Signum clones `CustomDrilldowns` with `ToMList()` — the LITES are shared, only the list is new.
     *  altea's element is a ROW, so the row is what has to be new; the lite it holds is still shared. */
    clone(): UserQueryEntity_CustomDrilldown {
        return UserQueryEntity_CustomDrilldown.create({ drilldown: this.drilldown });
    }
}

// ---- Embedded value types owned by UserQuery -----------------------------------------------------------

// Signum's SystemTimeEmbedded (UserQueryEntity.cs). The optional system-versioned / time-series window.
@reflect
export class SystemTimeEmbedded extends EmbeddedEntity {
    mode: SystemTimeMode = SystemTimeMode.AsOf;
    // Signum's `string?` with [StringLengthValidator(Max = 100)] — a date EXPRESSION, not a date: its
    // grammar allows relative forms parsed at query time. altea has not ported that grammar, and these
    // were narrowed to `Temporal.PlainDateTime` because of it — but the whole chain around the field is
    // already a STRING (`SystemTime.startDate` on the query request, the XML attribute, the URL
    // parameter), so the narrowing bought a date picker in one editor and cost a `.toString()` here and
    // a `.from()` there at every other boundary. Back to Signum's shape: the column is the same
    // `varchar(100)` a Signum database has, a value Signum wrote round-trips, and an unported relative
    // expression fails where it is PARSED rather than being unrepresentable.
    @stringLengthValidator({ max: 100 })
    startDate: string | null;
    @stringLengthValidator({ max: 100 })
    endDate: string | null;
    joinMode: SystemTimeJoinMode | null;
    timeSeriesUnit: TimeSeriesUnit | null;
    @numberIsValidator(ComparisonType.GreaterThan, 0)
    timeSeriesStep: int | null;
    @numberIsValidator(ComparisonType.GreaterThan, 0)
    timeSeriesMaxRowsPerStep: int | null;
    splitQueries: boolean = false;

    /** Signum's SystemTimeEmbedded.Clone(). */
    clone(): SystemTimeEmbedded {
        return SystemTimeEmbedded.create({
            mode: this.mode,
            startDate: this.startDate,
            endDate: this.endDate,
            joinMode: this.joinMode,
            timeSeriesUnit: this.timeSeriesUnit,
            timeSeriesStep: this.timeSeriesStep,
            timeSeriesMaxRowsPerStep: this.timeSeriesMaxRowsPerStep,
            splitQueries: this.splitQueries,
        });
    }
}

// Signum's HealthCheckConditionEmbedded (UserQueryEntity.cs). A "{count} {op} {value}" threshold.
@reflect
export class HealthCheckConditionEmbedded extends EmbeddedEntity {
    operation: FilterOperation = FilterOperation.GreaterThan;
    value: int = toInt(0);

    /** Signum's HealthCheckConditionEmbedded.Clone(). */
    clone(): HealthCheckConditionEmbedded {
        return HealthCheckConditionEmbedded.create({ operation: this.operation, value: this.value });
    }
}

// Signum's HealthCheckEmbedded (UserQueryEntity.cs). Optional fail / degraded thresholds on the row count.
@reflect
export class HealthCheckEmbedded extends EmbeddedEntity {
    failWhen: HealthCheckConditionEmbedded | null;
    // Signum's HealthCheckEmbedded.PropertyValidation: a health check with NEITHER threshold reports
    // nothing, so the embedded itself is the thing that should have been left null.
    @validate<HealthCheckEmbedded>((h, fi) => h.failWhen == null && h.degradedWhen == null
        ? ValidationMessage._0Or1ShouldBeSet.niceToString(
            HealthCheckEmbedded.nicePropertyName("failWhen"), fi.niceToString())
        : null)
    degradedWhen: HealthCheckConditionEmbedded | null;

    /** Signum's HealthCheckEmbedded.Clone(). */
    clone(): HealthCheckEmbedded {
        return HealthCheckEmbedded.create({
            failWhen: this.failWhen?.clone() ?? null,
            degradedWhen: this.degradedWhen?.clone() ?? null,
        });
    }
}

// ---- The UserQuery entity ------------------------------------------------------------------------------

// altea divergence: Signum's `Guid Guid = Guid.NewGuid()` [UniqueIndex] portable-identity field is
// replaced by a uuid PRIMARY KEY (`@primaryKey("uuid")`). The `id` IS the stable, portable identity used
// by XML export/import — so IUserAssetEntity is a bare marker (no `guid` field) and there is no separate
// unique index. (Import sets `entity.id` to the incoming uuid before saving.)
@primaryKey("uuid")
@entity("Main", "Master")
export class UserQueryEntity extends Entity implements IUserAssetEntity, IHasEntityType {
    query: QueryEntity;

    groupResults: boolean = false;

    // Signum's `Lite<TypeEntity>? EntityType` — a plain reference to the type registry row (the entity
    // type this UserQuery is a quick-link of), not a polymorphic reference.
    entityType: Lite<TypeEntity> | null;

    hideQuickLink: boolean = false;

    showTitleAsBreadcrumb: boolean = false;

    includeDefaultFilters: boolean | null;

    // Signum's `Lite<Entity>? Owner` — AssertImplementedBy(User, Role) in logic. Whose UserQuery this is
    // (a personal one → a User; a shared one → a Role; null → global).
    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null;

    @translatable
    @stringLengthValidator({ min: 1, max: 200 })
    displayName: string;

    /**
     * Signum's `CreateTitle` — overrides the SearchControl create button's default "Create new <Type>"
     * caption. `[Translatable]` as `displayName` is: both are user-authored labels.
     */
    @translatable
    @stringLengthValidator({ min: 1, max: 200 })
    createTitle: string | null;

    appendFilters: boolean = false;

    refreshMode: RefreshMode = RefreshMode.Auto;

    // Signum's [PreserveOrder, BindParent] MList<QueryFilterEmbedded>.
    filters: UserQueryEntity_Filter[];

    // Signum's [PreserveOrder] MList<QueryOrderEmbedded>.
    orders: UserQueryEntity_Order[];

    columnsMode: ColumnOptionsMode = ColumnOptionsMode.Add;

    // Signum's [PreserveOrder] MList<QueryColumnEmbedded>.
    columns: UserQueryEntity_Column[];

    paginationMode: PaginationMode | null;

    // Signum's [NumberIsValidator(GreaterThanOrEqualTo, 1)] — only set for Firsts/Paginate.
    @validate<UserQueryEntity>(uq =>
        uq.elementsPerPage != null && uq.elementsPerPage < 1
            ? UserQueryMessage.ElementsPerPageMustBeGreaterThanZero.niceToString()
            : null)
    @numberIsValidator(ComparisonType.GreaterThanOrEqualTo, 1)
    elementsPerPage: int | null;

    systemTime: SystemTimeEmbedded | null;

    healthCheck: HealthCheckEmbedded | null;

    // Signum's [PreserveOrder, NoRepeatValidator, ImplementedBy(UserQueryEntity)] MList<Lite<Entity>>.
    @noRepeatValidator()
    customDrilldowns: UserQueryEntity_CustomDrilldown[];

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
    /** Signum's `ConstructSymbol<UserQueryEntity>.From<UserQueryEntity> Clone`. */
    export const Clone: ConstructSymbol<UserQueryEntity, From<UserQueryEntity>> = init();
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

// The database schema this package's tables live in — altea's counterpart of Signum's
// `[assembly: AssemblySchemaName("userQueries")]`. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("userQueries");
