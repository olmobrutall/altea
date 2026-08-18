import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, primaryKey, backReference, rowOrder, implementedBy, uniqueIndex,
    stringLengthValidator, fieldValidation, format, unit,
} from "@altea/altea/data/decorators";
import { type int, type uuid, toInt } from "@altea/altea/data/basics";
import { Enum } from "@altea/altea/data/enum";
import { msg } from "@altea/altea/data/utils/localization";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { newGuid, type IUserAssetEntity, type IHasEntityType } from "@altea/altea-user-assets/data/UserAssets";

// Port of Signum's Signum.Toolbar/Toolbar.cs + ToolbarSwitcher.cs. A Toolbar is a user-authored,
// XML-portable NAVIGATION BAR: an ordered list of elements (headers, dividers, items, extra icons), each
// pointing at a query / a saved user asset / a permission-gated custom block / a raw URL — or at ANOTHER
// toolbar entity (a ToolbarMenu → a collapsible group, a ToolbarSwitcher → a pick-one-of-N dropdown, a
// nested Toolbar → inlined). Its `location` decides where it renders: the sidebar (Side), the navbar (Top)
// or a page of cards (Main).
//
// altea divergences, documented inline:
//  - Signum's `Guid Guid` [UniqueIndex] portable-identity field on the three ROOT entities (Toolbar /
//    ToolbarMenu / ToolbarSwitcher) → a uuid PRIMARY KEY (`@primaryKey("uuid")`), exactly like
//    DashboardEntity / UserQueryEntity: the `id` IS the identity XML import/export keys on. The element
//    ROWS keep a real `guid` field (their own PK is an int, and the client uses that guid to address an
//    element — see ToolbarClient.entityElementFilters).
//  - Signum's `MList<ToolbarElementEmbedded> Elements` (an EmbeddedEntity MList) → per-owner `@part` ROWS,
//    which are NOT EmbeddedEntities — hence the altea `<Owner>_<field>` row names below, not Signum's
//    `…Embedded` ones. That forces ONE further divergence: Signum has `ToolbarMenuElementEmbedded :
//    ToolbarElementEmbedded`
//    (one embedded type reused by two owners, the subclass adding WithEntity/AutoSelect), but an altea
//    @part row carries its OWN `@backReference` to its single owner — so the shared members move up into an
//    ABSTRACT base (`ToolbarElementBase`, no table) and each owner gets a concrete row type. Client
//    code that treats both uniformly types against the base (Signum's `ToolbarElementEmbedded`).
//  - `ToXml`/`FromXml` are server-only in altea (System.Xml + the user-asset context) — see
//    server/ToolbarXml.server.ts; the entities stay isomorphic.
//  - Signum's `StateValidator<ToolbarElementEmbedded, ToolbarElementType>` (a declarative per-state
//    must-be-set / must-be-null matrix) has no altea analogue; the same rules are expressed as explicit
//    `@fieldValidation`s below, keeping Signum's message keys.
//  - `[Translatable]` on Name / Label is dropped with the rest of instance translation (same deferral as
//    the dashboard port): the raw stored text is shown.
//  - `IToolbarEntity.GetSubToolbars()` IS ported (it drives the cycle check on save), as a method on each
//    root entity.

// ---- Enums ---------------------------------------------------------------------------------------------

// Signum's ToolbarLocation (Toolbar.cs): which of the app's three navigation surfaces renders this toolbar.
export enum ToolbarLocationEnum {
    Side,
    Top,
    Main,
}

// Signum's ToolbarElementType (Toolbar.cs). The explicit numeric values are Signum's (Header = 2 — the
// enum lost two members historically); altea persists an enum as an int FK to its enum table, so keeping
// the ordinals keeps a Signum-exported XML/database directly comparable.
export enum ToolbarElementTypeEnum {
    Header = 2,
    Divider = 3,
    Item = 4,
    ExtraIcon = 5,
}

// Signum's ShowCount (Toolbar.cs): whether the element's result count badge is always shown, or only when
// it is greater than zero.
export enum ShowCountEnum {
    MoreThan0 = 1,
    Always = 2,
}

// The string-union twins of the three enums above. altea's enum idiom is a numeric `XEnum` object (the
// in-memory / stored value is the ordinal) paired with a string-union alias of its member NAMES — which is
// the form that travels on the wire, so the ToolbarResponse DTOs and the client comparisons use these
// (`res.type == "Divider"`, exactly as in Signum's generated Signum.Toolbar.ts).
export type ToolbarLocation = keyof typeof ToolbarLocationEnum;
export type ToolbarElementType = keyof typeof ToolbarElementTypeEnum;
export type ShowCount = keyof typeof ShowCountEnum;

// ---- The element rows ----------------------------------------------------------------------------------

/** Signum's IToolbarEntity (Toolbar.cs) — a toolbar-ish root whose elements may reference OTHER such roots
 *  (so the graph must stay acyclic). `getSubToolbars()` is Signum's `IEnumerable<Lite<IToolbarEntity>>
 *  GetSubToolbars()`; the cycle check on save walks it (see ToolbarLogic). */
export interface IToolbarEntity extends Entity {
    getSubToolbars(): Lite<Entity>[];
}

// Signum's ToolbarElementEmbedded (Toolbar.cs), minus the owner FK: the members shared by a Toolbar element
// and a ToolbarMenu element. ABSTRACT (`@reflect`, not `@entity`) — only the two concrete row types below
// get tables (the same idiom as altea-auth's RuleEntity base).
@reflect
export abstract class ToolbarElementBase extends Entity {

    // Signum's `Guid Guid = Guid.NewGuid()`: the element's stable identity. Kept as a real field (the row's
    // own PK is an int, and a NEW element must already have an identity before it is saved) — it survives
    // the XML round-trip and addresses an element from the client (ToolbarClient.entityElementFilters).
    guid: uuid = newGuid();

    type: ToolbarElementTypeEnum = ToolbarElementTypeEnum.Item;

    // Signum's PropertyValidation: for an Item / a Header, a label is mandatory when there is no content
    // to take the label FROM. A Divider carries none of the four (Signum's StateValidator row).
    @fieldValidation<ToolbarElementBase>(e => isDivider(e)
        ? mustBeNull(e.label, ToolbarMessage.ADividerHasNoLabelIconContentOrUrl)
        : !e.label && e.content == null && isLabelledType(e)
            ? ToolbarMessage._0IsMandatoryWhen1IsNotSet.niceToString(
                ToolbarMessage.Label.niceToString(), ToolbarMessage.Content.niceToString())
            : null)
    @stringLengthValidator({ min: 1, max: 100 })
    label: string | null;

    @fieldValidation<ToolbarElementBase>(e => isDivider(e)
        ? mustBeNull(e.iconName, ToolbarMessage.ADividerHasNoLabelIconContentOrUrl) : null)
    @stringLengthValidator({ min: 3, max: 100 })
    iconName: string | null;

    showCount: ShowCountEnum | null;

    @format("Color")
    @stringLengthValidator({ min: 3, max: 20 })
    iconColor: string | null;

    // Signum's `[ImplementedBy()] Lite<Entity>? Content` — an EMPTY list that each module widened from its
    // own Logic.Start (`AssertImplementedBy(…)`). altea declares the toolbar module's OWN five here and the
    // APP widens the list with the assets of every registered module (Southwind did the same from
    // Starter.cs) — see eastwind/entityOverrides.data.ts's `overrideImplementedBy`. The list decides both
    // what the editor offers and which FK columns the element tables get.
    //
    // NOTE: the two concrete row types below INHERIT this one FieldInfo (altea's reflection seeds a
    // subclass's fields with the base's field objects), so ONE `overrideImplementedBy` on this base covers
    // both tables.
    @fieldValidation<ToolbarElementBase>(e => isDivider(e)
        ? mustBeNull(e.content, ToolbarMessage.ADividerHasNoLabelIconContentOrUrl) : null)
    @implementedBy(() => [QueryEntity, PermissionSymbol, ToolbarEntity, ToolbarMenuEntity, ToolbarSwitcherEntity])
    content: Lite<Entity> | null;

    // Signum's `[StringLengthValidator(Min = 1, Max = int.MaxValue), URLValidator(absolute: true,
    // aspNetSiteRelative: true)] string? Url` — an unbounded column (an altea string field with no declared
    // size is nvarchar(MAX) / varchar). altea's own `urlValidator` only accepts an ABSOLUTE http(s) URL, but
    // most toolbar urls are app-relative ("/order/1", "~/order/1") — Signum's `aspNetSiteRelative: true` —
    // so the check is written out here.
    //
    // Signum's second PropertyValidation: an Item / ExtraIcon needs a url when it has no content to
    // navigate to.
    @fieldValidation<ToolbarElementBase>(e => isDivider(e)
        ? mustBeNull(e.url, ToolbarMessage.ADividerHasNoLabelIconContentOrUrl)
        : e.url ? validateUrl(e.url)
            : e.content == null && isNavigableType(e)
                ? ToolbarMessage._0IsMandatoryWhen1IsNotSet.niceToString(
                    ToolbarMessage.Url.niceToString(), ToolbarMessage.Content.niceToString())
                : null)
    @stringLengthValidator({ min: 1 })
    url: string | null;

    openInPopup: boolean = false;

    // Signum's `[Unit("s"), NumberIsValidator(GreaterThanOrEqualTo, 10)]`.
    @unit("s")
    @fieldValidation<ToolbarElementBase>(e => e.autoRefreshPeriod != null && (e.autoRefreshPeriod as number) < 10
        ? ToolbarMessage.AutoRefreshPeriodMustBeGreaterThanOrEqualTo10Seconds.niceToString() : null)
    autoRefreshPeriod: int | null;

    toString(): string {
        const type = Enum.toName(ToolbarElementTypeEnum, this.type);
        return `${type}: ${this.label ?? (this.content == null ? "Null" : this.content.toString())}`;
    }
}

// Signum's ToolbarElementEmbedded as used by `ToolbarEntity.Elements` (here: the Toolbar-owned row).
@entity("Part")
export class ToolbarEntity_Elements extends ToolbarElementBase {
    @backReference toolbar: Lite<ToolbarEntity>;
    @rowOrder order: int;
}

// Signum's ToolbarMenuElementEmbedded (Toolbar.cs) — a ToolbarMenu element, which additionally says whether
// it applies WITH or WITHOUT the menu's selected entity, and whether picking the menu auto-navigates to it.
@entity("Part")
export class ToolbarMenuEntity_Elements extends ToolbarElementBase {
    @backReference toolbarMenu: Lite<ToolbarMenuEntity>;
    @rowOrder order: int;

    withEntity: boolean = false;
    autoSelect: boolean = false;
}

// ---- The root entities ---------------------------------------------------------------------------------

// Signum's ToolbarEntity (Toolbar.cs).
@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class ToolbarEntity extends Entity implements IUserAssetEntity, IToolbarEntity {

    // Signum's `Lite<IEntity>? Owner` — AssertImplementedBy(User, Role) in logic. Whose toolbar this is
    // (personal → a User; shared → a Role; null → global).
    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null;

    @stringLengthValidator({ max: 100 })
    name: string;

    location: ToolbarLocationEnum = ToolbarLocationEnum.Side;

    // Highest priority wins when several toolbars of one location are visible to the current role.
    priority: int | null;

    // Signum's `[PreserveOrder, NoRepeatValidator, BindParent] MList<ToolbarElementEmbedded>`.
    @fieldValidation<ToolbarEntity>(t => validateElements(t.elements))
    elements: ToolbarEntity_Elements[];

    /** Signum's `GetSubToolbars() => Elements.Select(a => a.Content).OfType<Lite<IToolbarEntity>>()`. */
    getSubToolbars(): Lite<Entity>[] {
        return subToolbarsOf(this.elements);
    }

    toString(): string {
        return this.name;
    }
}

// Signum's ToolbarMenuEntity (Toolbar.cs) — a reusable, collapsible GROUP of elements, optionally bound to
// an entity type (then the menu shows an entity picker and its elements split into with-/without-entity).
@reflect
@primaryKey("uuid")
@entity("Shared", "Master")
export class ToolbarMenuEntity extends Entity implements IUserAssetEntity, IHasEntityType, IToolbarEntity {

    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null;

    @stringLengthValidator({ max: 100 })
    name: string;

    @fieldValidation<ToolbarMenuEntity>(t => validateElements(t.elements))
    elements: ToolbarMenuEntity_Elements[];

    entityType: Lite<TypeEntity> | null;

    getSubToolbars(): Lite<Entity>[] {
        return subToolbarsOf(this.elements);
    }

    toString(): string {
        return this.name;
    }
}

// Signum's ToolbarSwitcherEntity (ToolbarSwitcher.cs) — one sidebar slot that switches between N
// ToolbarMenus (a dropdown; the picked menu's elements render below it).
@reflect
@primaryKey("uuid")
@entity("Shared", "Master")
export class ToolbarSwitcherEntity extends Entity implements IUserAssetEntity, IToolbarEntity {

    // Signum has [UniqueIndex] on Name here (it does not on Toolbar / ToolbarMenu).
    @uniqueIndex
    @stringLengthValidator({ max: 100 })
    name: string;

    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null;

    // Signum's `[PreserveOrder, NoRepeatValidator] MList<ToolbarSwitcherOptionEmbedded>`.
    options: ToolbarSwitcherEntity_Options[];

    /** Signum's `GetSubToolbars() => Options.Select(a => a.ToolbarMenu)`. */
    getSubToolbars(): Lite<Entity>[] {
        return (this.options ?? []).map(o => o.toolbarMenu as Lite<Entity>).filter(l => l != null);
    }

    toString(): string {
        return this.name;
    }
}

// Signum's ToolbarSwitcherOptionEmbedded (ToolbarSwitcher.cs) — one switchable menu plus its icon.
@entity("Part")
export class ToolbarSwitcherEntity_Options extends Entity {
    @backReference toolbarSwitcher: Lite<ToolbarSwitcherEntity>;
    @rowOrder order: int;

    toolbarMenu: Lite<ToolbarMenuEntity>;

    @stringLengthValidator({ min: 3, max: 100 })
    iconName: string | null;

    @format("Color")
    @stringLengthValidator({ min: 3, max: 20 })
    iconColor: string | null;

    toString(): string {
        return this.toolbarMenu?.toString() ?? "";
    }
}

// ---- Operations (Signum's `[AutoInit] static class ToolbarOperation` &c.) -------------------------------

export namespace ToolbarOperation {
    export const Save: ExecuteSymbol<ToolbarEntity> = init();
    export const Delete: DeleteSymbol<ToolbarEntity> = init();
}

export namespace ToolbarMenuOperation {
    export const Save: ExecuteSymbol<ToolbarMenuEntity> = init();
    export const Delete: DeleteSymbol<ToolbarMenuEntity> = init();
}

export namespace ToolbarSwitcherOperation {
    export const Save: ExecuteSymbol<ToolbarSwitcherEntity> = init();
    export const Delete: DeleteSymbol<ToolbarSwitcherEntity> = init();
}

// ---- Validation helpers (Signum's StateValidator rows + PropertyValidation) -----------------------------

function isDivider(e: ToolbarElementBase): boolean {
    return Enum.toName(ToolbarElementTypeEnum, e.type) === "Divider";
}

/** Signum's StateValidator "false" cell: for a Divider the member must NOT be set. */
function mustBeNull(value: unknown, message: { niceToString(): string }): string | null {
    return value == null || value === "" ? null : message.niceToString();
}

/** Label is mandatory-when-no-content for an Item / a Header (Signum's PropertyValidation guard). */
function isLabelledType(e: ToolbarElementBase): boolean {
    const type = Enum.toName(ToolbarElementTypeEnum, e.type);
    return type === "Item" || type === "Header";
}

/** Url is mandatory-when-no-content for an Item / an ExtraIcon (Signum's PropertyValidation guard). */
function isNavigableType(e: ToolbarElementBase): boolean {
    const type = Enum.toName(ToolbarElementTypeEnum, e.type);
    return type === "Item" || type === "ExtraIcon";
}

/** Signum's `URLValidator(absolute: true, aspNetSiteRelative: true)`: an absolute http(s) URL, or a
 *  site-relative path ("/order/1" or Signum's "~/order/1"). Toolbar urls may also carry the `:id` / `:type`
 *  / `:key` / `:toStr` entity placeholders (see client/ToolbarUrl.ts), which are legal path characters. */
function validateUrl(url: string): string | null {
    const ok = /^https?:\/\/[^\s]+$/i.test(url) || /^~?\/[^\s]*$/.test(url);
    return ok ? null : ToolbarMessage.InvalidUrl0.niceToString(url);
}

/** Signum's `IToolbar_Saving` element checks, run as an owner-level validation (they span sibling rows):
 *  an ExtraIcon attaches to the element BEFORE it, so it may be neither first nor right after a Divider. */
function validateElements(elements: ToolbarElementBase[] | undefined): string | null {
    if (elements == null || elements.length === 0)
        return null;

    const typeOf = (e: ToolbarElementBase): string => Enum.toName(ToolbarElementTypeEnum, e.type);

    if (typeOf(elements[0]) === "ExtraIcon")
        return ToolbarMessage.FirstElementCanNotBeExtraIcon.niceToString();

    for (let i = 1; i < elements.length; i++)
        if (typeOf(elements[i]) === "ExtraIcon" && typeOf(elements[i - 1]) === "Divider")
            return ToolbarMessage.ExtraIconCanNotComeAfterDivider.niceToString();

    return null;
}

/** The sub-toolbar lites among a set of elements: a content pointing at another IToolbarEntity root.
 *  altea has no `OfType<Lite<IToolbarEntity>>` (a Lite carries a ctor, not an interface), so the three
 *  concrete root types are matched explicitly. */
function subToolbarsOf(elements: ToolbarElementBase[] | undefined): Lite<Entity>[] {
    return (elements ?? [])
        .map(e => e.content)
        .filter((c): c is Lite<Entity> => c != null && isToolbarEntityType(c));
}

/** Whether a lite points at one of the three IToolbarEntity roots. */
export function isToolbarEntityType(lite: Lite<Entity>): boolean {
    return lite.entityType === ToolbarEntity
        || lite.entityType === ToolbarMenuEntity
        || lite.entityType === ToolbarSwitcherEntity;
}

// ---- Messages ------------------------------------------------------------------------------------------

// Signum's ToolbarMessage (Toolbar.cs / resx). The trailing entries are altea-only: the messages Signum
// expressed through C# validator attributes (StateValidator / URLValidator / NumberIsValidator) and the two
// shared ValidationMessage reuses, which altea states explicitly.
export const ToolbarMessage = {
    RecursionDetected: msg("Recursion detected"),
    _0CyclesHaveBeenFoundInTheToolbarDueToTheRelationships: msg("{0} cycles have been found in the Toolbar due to the relationships:"),
    FirstElementCanNotBeExtraIcon: msg("First element can not be Extra icon"),
    ExtraIconCanNotComeAfterDivider: msg("Extra icon can not come after divider"),
    If0Selected: msg("If {0} selected"),
    No0Selected: msg("No {0} selected"),
    ShowTogether: msg("Show together"),
    // altea-only:
    _0IsMandatoryWhen1IsNotSet: msg("{0} is mandatory when {1} is not set"),
    ADividerHasNoLabelIconContentOrUrl: msg("A divider has no label, icon, content or url"),
    AutoRefreshPeriodMustBeGreaterThanOrEqualTo10Seconds: msg("Auto refresh period must be greater than or equal to 10 seconds"),
    InvalidUrl0: msg("Invalid url: {0}"),
    Label: msg("Label"),
    Content: msg("Content"),
    Url: msg("Url"),
    ToolbarConfigNotRegistered0: msg("{0}ToolbarConfig not registered"),
    NoContentOrUrlFound: msg("No Content or Url found"),
};

// Signum's LayoutMessage (Toolbar.cs) — `[AllowUnauthenticated]` there; altea messages are shipped in the
// reflection blob for every user, so the marker has no analogue.
export const LayoutMessage = {
    JumpToMainContent: msg("Jump to main content"),
    SelectA0_G: msg("Select a {0}"),
};

// Signum's SubPageMessage (Toolbar.cs). Kept with the module although the Subs/ feature it belongs to
// (SubFramePage / SubsClient — a sub-entity frame page bundled in Signum.Toolbar) is NOT ported: it needs
// FramePage internals altea has not exposed. The two messages cost nothing and mark the deferral.
export const SubPageMessage = {
    No0FoundIn1: msg("No {0} found in {1}"),
    NotAllowedToCreate0In1: msg("Not allowed to create {0} in {1}"),
};
