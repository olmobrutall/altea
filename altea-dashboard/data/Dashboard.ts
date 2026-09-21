import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, EmbeddedEntity, type PrimaryKey } from "@altea/altea/data/entity";
import { Lite, LiteImp, registerCustomLite } from "@altea/altea/data/lite";
import { tryGetParentEntity } from "@altea/altea/data/parentEntity";
import {
    entity, part, primaryKey, backReference, rowOrder, implementedBy, format, unit, quoted, legacyTableName, bindParent,
    legacyClassName,
    legacyColumnName,
} from "@altea/altea/data/decorators";
import { stringLengthValidator, validate, noRepeatValidator, countIsValidator, ComparisonType, numberIsValidator, ValidationMessage } from "@altea/altea/data/validators";
import { type int, type uuid, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { PermissionSymbol } from "@altea/altea/data/permissionSymbol";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { type IUserAssetEntity, type IHasEntityType } from "@altea/altea-user-assets/data/UserAssets";
import { TextPartEntity, ImagePartEntity, SeparatorPartEntity, HealthCheckPartEntity, CustomPartEntity, ToolbarMenuPartEntity } from "./Parts";

// Port of Signum's Signum.Dashboard/DashboardEntity.cs + PanelPart.cs. A Dashboard is a user-authored,
// XML-portable grid of PARTS (a saved query in a SearchControl, a chart, a big value, free text, …) laid out
// on a 12-column bootstrap grid, optionally scoped to an entity type (then it is offered as a quick-link /
// embedded widget of that entity).
//
// altea divergences, documented inline:
//  - Signum's `Guid Guid` [UniqueIndex] portable-identity field → a uuid PRIMARY KEY (`@primaryKey("uuid")`),
//    exactly like UserQueryEntity / UserChartEntity: the `id` IS the identity XML import/export keys on.
//  - Signum's `MList<PanelPartEmbedded> Parts` (an EmbeddedEntity MList) → per-owner `@part` ROWS
//    (DashboardEntity_Part is an `@part` here): altea cannot persist an EmbeddedEntity array, and a
//    part row has exactly ONE owner. Same for the virtual MList `TokenEquivalencesGroups` and its nested
//    `TokenEquivalences` (a @part collection of the group).
//  - `ToXml`/`FromXml`/`ParseData` are server-only in altea (System.Xml + server QueryDescription) — see
//    server/DashboardXml.server.ts; the entity stays isomorphic.
//  - Signum's property SETTERS / ChildPropertyChanged / ChildCollectionChanged bookkeeping (clearing
//    EmbeddedInEntity when EntityType is cleared, re-notifying Row/Column) is handled in the editor
//    (altea entities are plain field bags with no change notification).
//  - DEFERRED with their missing extensions: `CacheQueryConfiguration` + CachedQueryEntity +
//    RegenerateCachedQueries (Signum.Files' FilePathEmbedded + Signum.Scheduler), `ITaskEntity`
//    (Scheduler) and the Omnibox provider. The per-part `isQueryCached` flags go with them.
//    (ToolbarMenuPartEntity was deferred with Signum.Toolbar and landed with it — see ./Parts.)

// ---- Enums (declared here so they auto-register with the entities that reference them) -----------------

// Signum's InteractionGroup (PanelPart.cs): the "cross-filtering channel" a part belongs to — clicking a
// chart in Group1 filters every other part in Group1.
export enum InteractionGroup {
    Group1,
    Group2,
    Group3,
    Group4,
    Group5,
    Group6,
    Group7,
    Group8,
}

// Signum's DashboardEmbedededInEntity (DashboardEntity.cs): where an entity-scoped dashboard shows up
// inside the entity's own view.
export enum DashboardEmbedededInEntity {
    None,
    Top,
    Bottom,
    Tab,
}

// ---- The dashboard grid ---------------------------------------------------------------------------------

/** Signum's IGridEntity (PanelPart.cs) — the row / column geometry the grid editor drags and resizes. */
export interface IGridEntity {
    row: int;
    startColumn: int;
    columns: int;
}

/** Signum's IPartEntity (PanelPart.cs) — the contract every dashboard part content entity implements.
 *  altea divergence: Signum's `Clone()` / `ToXml` / `FromXml` members are NOT on the isomorphic interface —
 *  both live in the server-side part registry (server/DashboardXml.server.ts). `requiresTitle` stays here:
 *  the "a title is mandatory for this part" validation is isomorphic. */
export interface IPartEntity extends Entity {
    requiresTitle(): boolean;
}

// Signum's PanelPartEmbedded (PanelPart.cs). ONE cell of the dashboard grid: its geometry, its chrome
// (title / icon / colors / tooltip), its interaction group, and the part `content` that renders in it.
@part
// Signum declares this collection `[PrimaryKey(typeof(Guid))]` — "the row id identifies the element in
// the XML" — so the id is written per row on export and MATCHED on import, which is what lets a row keep
// its identity across databases (see UserAssetsImporter.syncRows).
@primaryKey("uuid")
export class DashboardEntity_Part extends Entity implements IGridEntity {
    @backReference dashboard: Lite<DashboardEntity>;
    // No `@rowOrder`: Signum does not mark `DashboardEntity.Parts` [PreserveOrder], so its table has
    // no Order column. A part's place on the dashboard is its GEOMETRY (`row` / `startColumn` /
    // `columns`), which is what the grid lays out from — list position would say nothing.

    // Signum's PanelPartEmbedded.PropertyValidation(Title): a part whose content RequiresTitle must have one.
    @validate<DashboardEntity_Part>(p => !p.title && p.content?.requiresTitle()
        ? DashboardMessage.DashboardDN_TitleMustBeSpecifiedFor0.niceToString(p.content.toString()) : null)
    @stringLengthValidator({ min: 3, max: 100 })
    title: string | null;

    hideTitle: boolean = false;

    // Signum's [StringLengthValidator(MultiLine), Translatable] Tooltip — HTML in Signum (authored with
    // HtmlEditorLine). altea has no HtmlEditor port, so the editor uses a plain multi-line text box; the
    // stored value is still rendered as HTML by DashboardTooltipIcon.
    tooltip: string | null;

    @stringLengthValidator({ min: 3, max: 100 })
    iconName: string | null;

    @format("Color")
    @stringLengthValidator({ min: 3, max: 20 })
    iconColor: string | null;

    @format("Color")
    @stringLengthValidator({ min: 1, max: 20 })
    titleColor: string | null;

    // Signum's [NumberIsValidator(GreaterThanOrEqualTo, 0)].
    @validate<DashboardEntity_Part>(p => (p.row as number) < 0
        ? DashboardMessage.RowMustBeGreaterThanOrEqualToZero.niceToString() : null)
    row: int = toInt(0);

    // Signum's [NumberBetweenValidator(0, 11)].
    @validate<DashboardEntity_Part>(p => (p.startColumn as number) < 0 || (p.startColumn as number) > 11
        ? DashboardMessage.StartColumnMustBeBetween0And11.niceToString() : null)
    startColumn: int = toInt(0);

    // Signum's [NumberBetweenValidator(1, 12)]. The overlap / too-large checks Signum does in
    // DashboardEntity.ChildPropertyValidation need the sibling rows, so they live on the owner below.
    @validate<DashboardEntity_Part>(p => (p.columns as number) < 1 || (p.columns as number) > 12
        ? DashboardMessage.ColumnsMustBeBetween1And12.niceToString() : null)
    columns: int = toInt(12);

    interactionGroup: InteractionGroup | null;

    @format("Color")
    customColor: string | null;

    /** Whether the panel starts expanded. Null is the default, which is open. */
    defaultOpen: boolean | null;

    /**
     * CLIENT-ONLY (Signum's `[Ignore] bool IsOpen`): whether the panel is expanded right now. It lives on
     * the part rather than in the view so the DashboardController can skip the collapsed parts when it
     * decides whether the dashboard is still loading. No column — DashboardLogic.start hands the route to
     * SchemaSettings.ignoreFieldRoute — but it does ride the wire, like every other field.
     */
    isOpen: boolean = true;

    // Signum's [BindParent, ImplementedBy(…the base parts…)] IPartEntity Content. The app WIDENS this list
    // to the parts of every registered module (Signum did the same from Southwind's Starter) — see
    // eastwind/app/entityOverrides.data.ts's `overrideImplementedBy(DashboardEntity_Part, d => d.content, …)`.
    // Signum's [BindParent] on the same member: a part's content is a CONTINUATION of the dashboard,
    // and a rule on the content that has to know the dashboard (BigValuePartEntity's three, in
    // @altea/altea-user-queries) walks up through here. Nothing else changes — the parent lives in a
    // WeakMap, never on the wire.
    @bindParent
    @implementedBy(() => [TextPartEntity, ImagePartEntity, SeparatorPartEntity, HealthCheckPartEntity, CustomPartEntity, ToolbarMenuPartEntity])
    content: IPartEntity;

    toString(): string {
        return this.title ? this.title : this.content == null ? "" : this.content.toString();
    }

    /** Signum's PanelPartEmbedded.ColumnInterval() — [startColumn, startColumn + columns). */
    columnInterval(): { min: number; max: number } {
        return { min: this.startColumn as number, max: (this.startColumn as number) + (this.columns as number) };
    }
}

// Signum's TokenEquivalenceEmbedded (DashboardEntity.cs): "this token of THAT query means the same thing as
// that token of THIS query", so a cross-filter can travel between parts over different queries.
@part
export class DashboardEntity_TokenEquivalenceGroup_Query extends Entity {
    @backReference tokenEquivalenceGroup: Lite<DashboardEntity_TokenEquivalenceGroup>;
    @legacyColumnName("Order")
    @rowOrder rowOrder: int;

    query: QueryEntity;
    token: QueryTokenEmbedded;
}

// Signum's DashboardEntity_TokenEquivalenceGroup (DashboardEntity.cs) — a set of mutually-equivalent tokens, optionally
// restricted to one InteractionGroup. In Signum this is a virtual MList (a real entity with a back-reference
// to the dashboard); in altea that IS the @part row idiom.
@part
// Signum ships this as the standalone `TokenEquivalenceGroupEntity` where altea named the part after its
// OWNER — the right default for a part, and wrong here — so the Signum class name has to be given. Its
// clean name (`basics.type`, the query key, an @implementedBy column's suffix) and its table name both
// follow from it.
@legacyClassName("TokenEquivalenceGroupEntity")
// Signum wires it as a VIRTUAL MList, so there is no owner-plus-collection table to match and that rule
// must stand down. The NAME is the one derived above; only the structural fact is left to say.
@legacyTableName({ wasVirtualMList: true })
export class DashboardEntity_TokenEquivalenceGroup extends Entity {
    @backReference dashboard: Lite<DashboardEntity>;
    // No `@rowOrder`: this is a VIRTUAL MList in Signum — a standalone entity behind a back
    // reference, not an MList table — so there is no [PreserveOrder] to honour and no Order column.
    // (Its OWN collection below IS ordered; Signum declares [PreserveOrder] there.)

    interactionGroup: InteractionGroup | null;

    // Signum's [PreserveOrder, NoRepeatValidator, CountIsValidator(ComparisonType.GreaterThan, 1)] — an
    // equivalence of one token equates nothing.
    @noRepeatValidator<DashboardEntity_TokenEquivalenceGroup_Query>(a => a.query)
    @countIsValidator(ComparisonType.GreaterThan, 1)
    tokenEquivalences: DashboardEntity_TokenEquivalenceGroup_Query[];

    // No `toString()`: Signum's TokenEquivalenceGroupEntity does not override it, so its table has no
    // ToStr column. The natural string ("A = B = C") walks the CHILD COLLECTION, which no query can
    // expand inline — so keeping it would materialise a `to_str` Signum does not have.
}


// Signum's CacheQueryConfigurationEmbedded (DashboardEntity.cs) — present exactly when this dashboard's
// queries are SNAPSHOT to a file rather than run per view (see ./CachedQuery).
//
// altea divergence: `timeoutForQueries` is STORED and not applied. Signum wraps each regenerating query in
// `Connector.CommandTimeoutScope(...)`; altea's Connector has no command-timeout scope, so adding one is a
// core change with no other consumer. The column is kept so a Signum row round-trips.
@reflect
export class CacheQueryConfigurationEmbedded extends EmbeddedEntity {

    @unit("s")
    timeoutForQueries: int = toInt(5 * 60);

    maxRows: int = toInt(1000 * 1000);

    @unit("m")
    autoRegenerateWhenOlderThan: int | null = null;
}

// ---- The Dashboard entity -------------------------------------------------------------------------------

@primaryKey("uuid")
@entity("Main", "Master")
export class DashboardEntity extends Entity implements IUserAssetEntity, IHasEntityType {

    // Signum's `Lite<TypeEntity>? EntityType` — the entity type this dashboard is a quick-link / embedded
    // widget of (null → a standalone dashboard). Its C# setter also cleared EmbeddedInEntity /
    // ShowTitleAsBreadcrumb; the editor does that in onChange (see client/Admin/Dashboard.tsx).
    entityType: Lite<TypeEntity> | null;

    @validate<DashboardEntity>(d => validateEmbeddedInEntity(d))
    embeddedInEntity: DashboardEmbedededInEntity | null;

    // Signum's `Lite<Entity>? Owner` — AssertImplementedBy(User, Role) in logic. Whose dashboard this is
    // (personal → a User; shared → a Role; null → global).
    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null;

    dashboardPriority: int | null;

    // Signum's [Unit("s"), NumberIsValidator(GreaterThanOrEqualTo, 10)].
    @unit("s")
    @validate<DashboardEntity>(d => d.autoRefreshPeriod != null && (d.autoRefreshPeriod as number) < 10
        ? DashboardMessage.AutoRefreshPeriodMustBeGreaterThanOrEqualTo10Seconds.niceToString() : null)
    @numberIsValidator(ComparisonType.GreaterThanOrEqualTo, 10)
    autoRefreshPeriod: int | null;

    @stringLengthValidator({ min: 2, max: 200 })
    displayName: string;

    hideDisplayName: boolean = false;

    showTitleAsBreadcrumb: boolean = false;

    combineSimilarRows: boolean = true;

    // Signum's [BindParent, NoRepeatValidator] MList<PanelPartEmbedded>. The grid-geometry checks Signum
    // runs in ChildPropertyValidation (a part sticking out past column 12, two parts overlapping in a row)
    // need the sibling rows, so they are an owner-level field validation here.
    @bindParent
    @validate<DashboardEntity>(d => validateParts(d.parts))
    parts: DashboardEntity_Part[];

    // Signum's CacheQueryConfiguration: set it and the dashboard is served from a SNAPSHOT
    // (DashboardOperation.RegenerateCachedQueries builds one; the client runs every part's query against
    // it locally). Null means every part queries the database as it is viewed.
    // A cached dashboard is one SNAPSHOT for everybody, so it cannot also be an entity widget: an
    // embedded dashboard's parts are filtered by the entity it is shown on, and a snapshot has no entity
    // to be filtered by (Signum's third DashboardEntity.PropertyValidation branch).
    @validate<DashboardEntity>((d, fi) => d.cacheQueryConfiguration != null && d.entityType != null
        ? ValidationMessage._0ShouldBeNullWhen1IsSet.niceToString(
            fi.niceToString(), DashboardEntity.nicePropertyName("entityType"))
        : null)
    cacheQueryConfiguration: CacheQueryConfigurationEmbedded | null = null;

    // Signum's [Ignore, QueryableProperty, BindParent] MList<DashboardEntity_TokenEquivalenceGroup> (a virtual MList).
    @validate<DashboardEntity>(d => validateTokenEquivalences(d.tokenEquivalencesGroups))
    tokenEquivalencesGroups: DashboardEntity_TokenEquivalenceGroup[];

    // Signum: `[StringLengthValidator(Max = 200)] string? Key` — no index (DashboardEntity.cs).
    @stringLengthValidator({ max: 200 })
    key: string | null;

    hideQuickLink: boolean = false;

    @stringLengthValidator({ min: 3, max: 100 })
    iconName: string | null;

    @format("Color")
    @stringLengthValidator({ min: 3, max: 20 })
    iconColor: string | null;

    @format("Color")
    @stringLengthValidator({ min: 3, max: 20 })
    titleColor: string | null;

    @quoted
    toString(): string {
        return this.displayName;
    }
}

/**
 * Signum's `IPartEntity.GetDashboard()` — the dashboard a part CONTENT sits on, two `@bindParent` hops up
 * (content → its grid cell → the dashboard). A part validated outside a dashboard (one being constructed,
 * or one a test holds on its own) answers undefined and a rule that needs the dashboard stands down,
 * which is the same thing `tryGetParentEntity` does for a single hop.
 */
export function tryGetDashboard(part: IPartEntity): DashboardEntity | undefined {
    const cell = tryGetParentEntity(part, DashboardEntity_Part);
    return cell == null ? undefined : tryGetParentEntity(cell, DashboardEntity);
}

// Signum's DashboardEntity.PropertyValidation for EmbeddedInEntity (it is required exactly when EntityType
// is set) — an entity-level check because it spans two fields. Wired as the `@validate` on
// `embeddedInEntity`; still exported, because the editor asks it directly too.
//
// It used to say this with two DashboardMessage members of altea's own invention, written when core's
// ValidationMessage carried neither half of Signum's sentence. It carries both now, so this is Signum's
// wording again — and the two invented members are gone with it.
export function validateEmbeddedInEntity(d: DashboardEntity): string | null {
    const name = DashboardEntity.nicePropertyName("embeddedInEntity");
    if (d.embeddedInEntity == null && d.entityType != null)
        return ValidationMessage._0IsNecessary.niceToString(name);
    if (d.embeddedInEntity != null && d.entityType == null)
        return ValidationMessage._0IsNotAllowed.niceToString(name);
    return null;
}

// Signum's DashboardEntity.ChildPropertyValidation on PanelPartEmbedded.StartColumn: a part may not exceed
// the 12-column grid, and two parts in the same row may not overlap.
function validateParts(parts: DashboardEntity_Part[] | undefined): string | null {
    if (parts == null)
        return null;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if ((part.startColumn as number) + (part.columns as number) > 12)
            return DashboardMessage.Part0IsTooLarge.niceToString(part.toString());

        const other = parts.slice(0, i).find(p =>
            (p.row as number) === (part.row as number) && overlaps(p.columnInterval(), part.columnInterval()));

        if (other != null)
            return DashboardMessage.Part0OverlapsWith1.niceToString(part.toString(), other.toString());
    }
    return null;
}

function overlaps(a: { min: number; max: number }, b: { min: number; max: number }): boolean {
    return a.min < b.max && b.min < a.max;
}

// Signum's DashboardEntity.PropertyValidation for TokenEquivalencesGroups: the same token may not appear in
// two equivalence groups.
function validateTokenEquivalences(groups: DashboardEntity_TokenEquivalenceGroup[] | undefined): string | null {
    if (groups == null)
        return null;

    const count = new Map<string, number>();
    for (const gr of groups)
        for (const te of gr.tokenEquivalences ?? []) {
            const key = te.token?.tokenString;
            if (key)
                count.set(key, (count.get(key) ?? 0) + 1);
        }

    const dups = [...count.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${n} x ${k}`);
    return dups.length === 0 ? null : DashboardMessage.DuplicatedTokens0.niceToString(dups.join("\n"));
}

// Signum's DashboardLiteModel (DashboardEntity.cs) — the custom Lite carrying just what the quick-link /
// toolbar UI needs (display name + the hide-quick-link flag) without fetching the whole dashboard.
//
// altea divergence: Signum ships a separate `DashboardLiteModel : ModelEntity` reached via `lite.model`;
// altea's idiom is a `LiteImp` subclass carrying the model fields DIRECTLY on the lite — so the client reads
// `(d as DashboardLite).hideQuickLink`, not `d.model.hideQuickLink` (mirrors UserQueryLite / UserChartLite).
export class DashboardLite extends LiteImp<DashboardEntity> {
    constructor(
        id: PrimaryKey, toStr: string,
        readonly hideQuickLink: boolean,
    ) {
        super(id, DashboardEntity, toStr);
    }
    static isCompatible(json: Record<string, unknown>): boolean {
        return typeof json.hideQuickLink === "boolean";
    }
    static fromJson(json: Record<string, unknown>): Lite<DashboardEntity> {
        return new DashboardLite(json.id as PrimaryKey, (json.toStr as string) ?? "", json.hideQuickLink as boolean);
    }
}

// The DEFAULT custom lite for DashboardEntity: `toLite(d)` (and query projections) yield a DashboardLite.
// The `fromEntity` lambda is transformer-quoted so the query provider can project the columns in SQL.
registerCustomLite(DashboardEntity, DashboardLite,
    d => new DashboardLite(d.id, d.displayName, d.hideQuickLink), true);

// Signum's `[AutoInit] static class DashboardPermission`.
export namespace DashboardPermission {
    export const ViewDashboard: PermissionSymbol = init();
}

// Signum's `[AutoInit] static class DashboardOperation`.
export namespace DashboardOperation {
    export const Save: ExecuteSymbol<DashboardEntity> = init();
    export const Clone: ConstructSymbol<DashboardEntity, From<DashboardEntity>> = init();
    export const Delete: DeleteSymbol<DashboardEntity> = init();
    /** Signum's RegenerateCachedQueries — rebuild this dashboard's query snapshots. */
    export const RegenerateCachedQueries: ExecuteSymbol<DashboardEntity> = init();
}

// Signum's DashboardMessage (DashboardEntity.cs / resx). The trailing entries are altea-only: the validator
// messages Signum expressed with C# validator attributes (NumberIsValidator / NumberBetweenValidator /
// CountIsValidator) and the two ValidationMessage reuses, which altea states as explicit messages.
export const DashboardMessage = {
    CreateNewPart: msg("Create new part"),
    DashboardDN_TitleMustBeSpecifiedFor0: msg("Title must be specified for {0}"),
    Preview: msg(),
    _0Is1InstedOf2In3: msg("{0} is {1} (instead of {2}) in {3}"),
    Part0IsTooLarge: msg("Part {0} is too large"),
    Part0OverlapsWith1: msg("Part {0} overlaps with {1}"),
    RowsSelected: msg("Row[s] selected"),
    ForPerformanceReasonsThisDashboardMayShowOutdatedInformation: msg("For performance reasons this dashboard may show outdated information"),
    LasUpdateWasOn0: msg("Last update was on {0}"),
    TheUserQuery0HasNoColumnWithSummaryHeader: msg("The User Query '{0}' has no column with summary header"),
    Edit: msg(),
    MoreInformation: msg("More information"),
    CLickInOneChartToFilterInTheOthers: msg("Click in one chart to filter in the others"),
    CtrlClickToFilterByMultipleElements: msg("[Ctrl] + Click to filter by multiple elements"),
    AltClickToOpenResultsInAModalWindow: msg("[Alt] + Click to open results in a modal window"),
    CopyHealthCheckDashboardData: msg("Copy health check dashboard data"),
    _0CanOnlyBeUserInA1With2: msg("{0} can only be used in a {1} with {2}"),
    InteractiveDashboard: msg("Interactive Dashboard"),
    SelectIcon: msg("Select icon"),
    Close: msg(),
    IncompatibleEntityType: msg("Incompatible Entity Type"),
    NotFilteringBy0: msg("Not filtering by {0}"),
    // altea-only (validator messages Signum got from attributes / shared ValidationMessages):
    RowMustBeGreaterThanOrEqualToZero: msg("Row must be greater than or equal to 0"),
    StartColumnMustBeBetween0And11: msg("Start column must be between 0 and 11"),
    ColumnsMustBeBetween1And12: msg("Columns must be between 1 and 12"),
    AutoRefreshPeriodMustBeGreaterThanOrEqualTo10Seconds: msg("Auto refresh period must be greater than or equal to 10 seconds"),
    DuplicatedTokens0: msg("Duplicated tokens: {0}"),
};

// Signum's DashboardVariableMessage (DashboardEntity.cs) — the `$UserGreeting$` text-part variable.
export const DashboardVariableMessage = {
    GoodMorning: msg("Good morning"),
    GoodAfternoon: msg("Good afternoon"),
    GoodEvening: msg("Good evening"),
    GoodNight: msg("Good night"),
};
