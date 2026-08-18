import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, type PrimaryKey } from "@altea/altea/data/entity";
import { Lite, LiteImp, registerCustomLite } from "@altea/altea/data/lite";
import {
    entity, primaryKey, backReference, rowOrder, implementedBy, index,
    stringLengthValidator, fieldValidation, format, unit, quoted,
} from "@altea/altea/data/decorators";
import { type int, type uuid, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { noRepeatValidator, countIsValidator, ComparisonType } from "@altea/altea/data/validators";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";
import { newGuid, type IUserAssetEntity, type IHasEntityType } from "@altea/altea-user-assets/data/UserAssets";
import { TextPartEntity, ImagePartEntity, SeparatorPartEntity, HealthCheckPartEntity, CustomPartEntity } from "./Parts";

// Port of Signum's Signum.Dashboard/DashboardEntity.cs + PanelPart.cs. A Dashboard is a user-authored,
// XML-portable grid of PARTS (a saved query in a SearchControl, a chart, a big value, free text, …) laid out
// on a 12-column bootstrap grid, optionally scoped to an entity type (then it is offered as a quick-link /
// embedded widget of that entity).
//
// altea divergences, documented inline:
//  - Signum's `Guid Guid` [UniqueIndex] portable-identity field → a uuid PRIMARY KEY (`@primaryKey("uuid")`),
//    exactly like UserQueryEntity / UserChartEntity: the `id` IS the identity XML import/export keys on.
//  - Signum's `MList<PanelPartEmbedded> Parts` (an EmbeddedEntity MList) → per-owner `@part` ROWS
//    (DashboardEntity_Part is an `@entity("Part")` here): altea cannot persist an EmbeddedEntity array, and a
//    part row has exactly ONE owner. Same for the virtual MList `TokenEquivalencesGroups` and its nested
//    `TokenEquivalences` (a @part collection of the group).
//  - `ToXml`/`FromXml`/`ParseData` are server-only in altea (System.Xml + server QueryDescription) — see
//    server/DashboardXml.server.ts; the entity stays isomorphic.
//  - Signum's property SETTERS / ChildPropertyChanged / ChildCollectionChanged bookkeeping (clearing
//    EmbeddedInEntity when EntityType is cleared, re-notifying Row/Column) is handled in the editor
//    (altea entities are plain field bags with no change notification).
//  - DEFERRED with their missing extensions: `CacheQueryConfiguration` + CachedQueryEntity +
//    RegenerateCachedQueries (Signum.Files' FilePathEmbedded + Signum.Scheduler), `ITaskEntity`
//    (Scheduler), ToolbarMenuPartEntity (Signum.Toolbar) and the Omnibox provider. The per-part
//    `isQueryCached` flags go with them.

// ---- Enums (declared here so they auto-register with the entities that reference them) -----------------

// Signum's InteractionGroup (PanelPart.cs): the "cross-filtering channel" a part belongs to — clicking a
// chart in Group1 filters every other part in Group1.
export enum InteractionGroupEnum {
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
export enum DashboardEmbedededInEntityEnum {
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
@entity("Part")
export class DashboardEntity_Part extends Entity implements IGridEntity {
    @backReference dashboard: Lite<DashboardEntity>;
    @rowOrder order: int;

    // Signum's `Guid Guid = Guid.NewGuid()`: the part's stable identity, used as the React key / the
    // `data-part-content` attribute and preserved by the XML round-trip. Kept as a real field (the row's
    // own PK is an int, and a NEW part must already have an identity before it is saved).
    guid: uuid = newGuid();

    // Signum's PanelPartEmbedded.PropertyValidation(Title): a part whose content RequiresTitle must have one.
    @fieldValidation<DashboardEntity_Part>(p => !p.title && p.content?.requiresTitle()
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
    @fieldValidation<DashboardEntity_Part>(p => (p.row as number) < 0
        ? DashboardMessage.RowMustBeGreaterThanOrEqualToZero.niceToString() : null)
    row: int = toInt(0);

    // Signum's [NumberBetweenValidator(0, 11)].
    @fieldValidation<DashboardEntity_Part>(p => (p.startColumn as number) < 0 || (p.startColumn as number) > 11
        ? DashboardMessage.StartColumnMustBeBetween0And11.niceToString() : null)
    startColumn: int = toInt(0);

    // Signum's [NumberBetweenValidator(1, 12)]. The overlap / too-large checks Signum does in
    // DashboardEntity.ChildPropertyValidation need the sibling rows, so they live on the owner below.
    @fieldValidation<DashboardEntity_Part>(p => (p.columns as number) < 1 || (p.columns as number) > 12
        ? DashboardMessage.ColumnsMustBeBetween1And12.niceToString() : null)
    columns: int = toInt(12);

    interactionGroup: InteractionGroupEnum | null;

    @format("Color")
    customColor: string | null;

    // Signum's [BindParent, ImplementedBy(…the base parts…)] IPartEntity Content. The app WIDENS this list
    // to the parts of every registered module (Signum did the same from Southwind's Starter) — see
    // eastwind/entityOverrides.data.ts's `overrideImplementedBy(DashboardEntity_Part, "content", …)`.
    @implementedBy(() => [TextPartEntity, ImagePartEntity, SeparatorPartEntity, HealthCheckPartEntity, CustomPartEntity])
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
@entity("Part")
export class DashboardEntity_TokenEquivalenceGroup_Query extends Entity {
    @backReference tokenEquivalenceGroup: Lite<DashboardEntity_TokenEquivalenceGroup>;
    @rowOrder order: int;

    query: QueryEntity;
    token: QueryTokenEmbedded;
}

// Signum's DashboardEntity_TokenEquivalenceGroup (DashboardEntity.cs) — a set of mutually-equivalent tokens, optionally
// restricted to one InteractionGroup. In Signum this is a virtual MList (a real entity with a back-reference
// to the dashboard); in altea that IS the @part row idiom.
@entity("Part")
export class DashboardEntity_TokenEquivalenceGroup extends Entity {
    @backReference dashboard: Lite<DashboardEntity>;
    @rowOrder order: int;

    interactionGroup: InteractionGroupEnum | null;

    // Signum's [PreserveOrder, NoRepeatValidator, CountIsValidator(ComparisonType.GreaterThan, 1)] — an
    // equivalence of one token equates nothing.
    @noRepeatValidator()
    @countIsValidator(ComparisonType.GreaterThan, 1)
    tokenEquivalences: DashboardEntity_TokenEquivalenceGroup_Query[];

    toString(): string {
        return this.tokenEquivalences?.map(te => te.token?.tokenString).join(" = ") ?? "";
    }
}

// ---- The Dashboard entity -------------------------------------------------------------------------------

@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class DashboardEntity extends Entity implements IUserAssetEntity, IHasEntityType {

    // Signum's `Lite<TypeEntity>? EntityType` — the entity type this dashboard is a quick-link / embedded
    // widget of (null → a standalone dashboard). Its C# setter also cleared EmbeddedInEntity /
    // ShowTitleAsBreadcrumb; the editor does that in onChange (see client/Admin/Dashboard.tsx).
    entityType: Lite<TypeEntity> | null;

    embeddedInEntity: DashboardEmbedededInEntityEnum | null;

    // Signum's `Lite<Entity>? Owner` — AssertImplementedBy(User, Role) in logic. Whose dashboard this is
    // (personal → a User; shared → a Role; null → global).
    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null;

    dashboardPriority: int | null;

    // Signum's [Unit("s"), NumberIsValidator(GreaterThanOrEqualTo, 10)].
    @unit("s")
    @fieldValidation<DashboardEntity>(d => d.autoRefreshPeriod != null && (d.autoRefreshPeriod as number) < 10
        ? DashboardMessage.AutoRefreshPeriodMustBeGreaterThanOrEqualTo10Seconds.niceToString() : null)
    autoRefreshPeriod: int | null;

    @stringLengthValidator({ min: 2, max: 200 })
    displayName: string;

    hideDisplayName: boolean = false;

    showTitleAsBreadcrumb: boolean = false;

    combineSimilarRows: boolean = true;

    // Signum's [BindParent, NoRepeatValidator] MList<PanelPartEmbedded>. The grid-geometry checks Signum
    // runs in ChildPropertyValidation (a part sticking out past column 12, two parts overlapping in a row)
    // need the sibling rows, so they are an owner-level field validation here.
    @fieldValidation<DashboardEntity>(d => validateParts(d.parts))
    parts: DashboardEntity_Part[];

    // Signum's [Ignore, QueryableProperty, BindParent] MList<DashboardEntity_TokenEquivalenceGroup> (a virtual MList).
    @fieldValidation<DashboardEntity>(d => validateTokenEquivalences(d.tokenEquivalencesGroups))
    tokenEquivalencesGroups: DashboardEntity_TokenEquivalenceGroup[];

    @index
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

// Signum's DashboardEntity.PropertyValidation for EmbeddedInEntity (it is required exactly when EntityType
// is set) — an entity-level check because it spans two fields. Exposed for the editor / the save path.
export function validateEmbeddedInEntity(d: DashboardEntity): string | null {
    if (d.embeddedInEntity == null && d.entityType != null)
        return DashboardMessage.EmbeddedInEntityIsNecessaryWhenEntityTypeIsSet.niceToString();
    if (d.embeddedInEntity != null && d.entityType == null)
        return DashboardMessage.EmbeddedInEntityIsNotAllowedWithoutEntityType.niceToString();
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

// Signum's `[AutoInit] static class DashboardOperation` (RegenerateCachedQueries is deferred with CachedQuery).
export namespace DashboardOperation {
    export const Save: ExecuteSymbol<DashboardEntity> = init();
    export const Clone: ConstructSymbol<DashboardEntity, From<DashboardEntity>> = init();
    export const Delete: DeleteSymbol<DashboardEntity> = init();
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
    EmbeddedInEntityIsNecessaryWhenEntityTypeIsSet: msg("Embedded in entity is necessary when Entity Type is set"),
    EmbeddedInEntityIsNotAllowedWithoutEntityType: msg("Embedded in entity is not allowed without an Entity Type"),
};

// Signum's DashboardVariableMessage (DashboardEntity.cs) — the `$UserGreeting$` text-part variable.
export const DashboardVariableMessage = {
    GoodMorning: msg("Good morning"),
    GoodAfternoon: msg("Good afternoon"),
    GoodEvening: msg("Good evening"),
    GoodNight: msg("Good night"),
};
