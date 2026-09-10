import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, part, primaryKey, backReference, rowOrder, implementedBy, uniqueIndex, format, unit, quoted,
} from "@altea/altea/data/decorators";
import { stringLengthValidator, validate } from "@altea/altea/data/validators";
import { type int, type uuid, toInt } from "@altea/altea/data/basics";
import { Enum } from "@altea/altea/data/enum";
import { msg } from "@altea/altea/data/utils/localization";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { UserEntity } from "@altea/altea-auth/data/User";
import { RoleEntity } from "@altea/altea-auth/data/Role";
import { type IUserAssetEntity, type IHasEntityType } from "@altea/altea-user-assets/data/UserAssets";

// Port of Signum.Toolbar's Toolbar.cs + ToolbarSwitcher.cs — see docs/port/Toolbar.md.
//
// A Toolbar is a user-authored, XML-portable NAVIGATION BAR: an ordered list of elements (headers,
// dividers, items, extra icons), each pointing at a query / a saved user asset / a permission-gated custom
// block / a raw URL — or at ANOTHER toolbar entity (a ToolbarMenu → a collapsible group, a ToolbarSwitcher
// → a pick-one-of-N dropdown, a nested Toolbar → inlined). Its `location` decides where it renders: the
// sidebar (Side), the navbar (Top) or a page of cards (Main).
//
// The three ROOTS and the element ROWS are all `@primaryKey("uuid")`: that id is the portable identity the
// XML keys on, and for a row it is also what the client addresses an element by (see
// ToolbarClient.entityElementFilters).
//
// An element row belongs to ONE owner through its `@backReference`, so the two owners cannot share a row
// type: the common members live on the ABSTRACT `ToolbarElementBaseEntity` (no table) and each owner has a
// concrete row. Client code that treats both uniformly types against the base.
//
// The per-state must-be-set / must-be-null rules are explicit `@validate`s below, keeping Signum's message
// keys (they are what a shipped translation file is keyed by). `getSubToolbars()` drives the cycle check on save. XML lives in server/ToolbarXml.ts, so the
// entities stay isomorphic.

// ---- Enums ---------------------------------------------------------------------------------------------

// Which of the app's three navigation surfaces renders this toolbar.
export enum ToolbarLocation {
    Side,
    Top,
    Main,
}

// The explicit numeric values are Signum's — Header = 2, the enum lost two members historically — and an
// enum persists as an int FK to its enum table, so keeping the ordinals keeps a Signum-exported XML or
// database directly comparable. Do not renumber.
export enum ToolbarElementType {
    Header = 2,
    Divider = 3,
    Item = 4,
    ExtraIcon = 5,
}

// Whether the element's result count badge is always shown, or only when
// it is greater than zero.
export enum ShowCount {
    MoreThan0 = 1,
    Always = 2,
}

// The string-union twins of the three enums above: the member NAMES are what travels on the wire, so the
// ToolbarResponse DTOs and the client comparisons use these (`res.type == "Divider"`).
export type ToolbarLocationKeys = keyof typeof ToolbarLocation;
export type ToolbarElementTypeKeys = keyof typeof ToolbarElementType;
export type ShowCountKeys = keyof typeof ShowCount;

// ---- The element rows ----------------------------------------------------------------------------------

/** A toolbar-ish root whose elements may reference OTHER such roots
 *  (so the graph must stay acyclic). The cycle check on save walks `getSubToolbars()` — see ToolbarLogic. */
export interface IToolbarEntity extends Entity {
    getSubToolbars(): Lite<Entity>[];
}

// The members shared by a Toolbar element and a ToolbarMenu element, minus the owner FK. ABSTRACT
// (`@reflect`, not `@entity`) — only the two concrete row types below get tables, the same idiom as
// altea-auth's RuleEntity base.
@reflect
export abstract class ToolbarElementBaseEntity extends Entity {

    type: ToolbarElementType = ToolbarElementType.Item;

    // For an Item / a Header, a label is mandatory when there is no content
    // to take the label FROM. A Divider carries none of the four.
    @validate<ToolbarElementBaseEntity>(e => isDivider(e)
        ? mustBeNull(e.label, ToolbarMessage.ADividerHasNoLabelIconContentOrUrl)
        : !e.label && e.content == null && isLabelledType(e)
            ? ToolbarMessage._0IsMandatoryWhen1IsNotSet.niceToString(
                ToolbarMessage.Label.niceToString(), ToolbarMessage.Content.niceToString())
            : null)
    @stringLengthValidator({ min: 1, max: 100 })
    label: string | null;

    @validate<ToolbarElementBaseEntity>(e => isDivider(e)
        ? mustBeNull(e.iconName, ToolbarMessage.ADividerHasNoLabelIconContentOrUrl) : null)
    @stringLengthValidator({ min: 3, max: 100 })
    iconName: string | null;

    showCount: ShowCount | null;

    @format("Color")
    @stringLengthValidator({ min: 3, max: 20 })
    iconColor: string | null;

    // An EMPTY list that each module widened from its
    // own Logic.Start (`AssertImplementedBy(…)`). altea declares the toolbar module's OWN five here and the
    // APP widens the list with the assets of every registered module (Southwind did the same from
    // Starter.cs) — see eastwind/entityOverrides.data.ts's `overrideImplementedBy`. The list decides both
    // what the editor offers and which FK columns the element tables get.
    //
    // NOTE: the two concrete row types below INHERIT this one FieldInfo (altea's reflection seeds a
    // subclass's fields with the base's field objects), so ONE `overrideImplementedBy` on this base covers
    // both tables.
    @validate<ToolbarElementBaseEntity>(e => isDivider(e)
        ? mustBeNull(e.content, ToolbarMessage.ADividerHasNoLabelIconContentOrUrl) : null)
    @implementedBy(() => [QueryEntity, PermissionSymbol, ToolbarEntity, ToolbarMenuEntity, ToolbarSwitcherEntity])
    content: Lite<Entity> | null;

    // Unbounded (a string field with no declared size is nvarchar(MAX) / varchar). The stock `urlValidator`
    // accepts only an ABSOLUTE http(s) URL, but most toolbar urls are app-relative ("/order/1",
    // "~/order/1"), so the check is written out below.
    //
    // An Item / ExtraIcon needs a url when it has no content to
    // navigate to.
    @validate<ToolbarElementBaseEntity>(e => isDivider(e)
        ? mustBeNull(e.url, ToolbarMessage.ADividerHasNoLabelIconContentOrUrl)
        : e.url ? validateUrl(e.url)
            : e.content == null && isNavigableType(e)
                ? ToolbarMessage._0IsMandatoryWhen1IsNotSet.niceToString(
                    ToolbarMessage.Url.niceToString(), ToolbarMessage.Content.niceToString())
                : null)
    @stringLengthValidator({ min: 1 })
    url: string | null;

    openInPopup: boolean = false;

    @unit("s")
    @validate<ToolbarElementBaseEntity>(e => e.autoRefreshPeriod != null && (e.autoRefreshPeriod as number) < 10
        ? ToolbarMessage.AutoRefreshPeriodMustBeGreaterThanOrEqualTo10Seconds.niceToString() : null)
    autoRefreshPeriod: int | null;

    toString(): string {
        const type = Enum.toName(ToolbarElementType, this.type);
        return `${type}: ${this.label ?? (this.content == null ? "Null" : this.content.toString())}`;
    }
}

// The Toolbar-owned element row.
@part
// The row id IDENTIFIES the element in the XML: it is written per row on export and matched on import,
// which is what lets a row keep its identity across databases (see UserAssetsImporter.syncRows).
@primaryKey("uuid")
export class ToolbarEntity_Element extends ToolbarElementBaseEntity {
    @backReference toolbar: Lite<ToolbarEntity>;
    @rowOrder order: int;
}

// A ToolbarMenu element, which additionally says whether
// it applies WITH or WITHOUT the menu's selected entity, and whether picking the menu auto-navigates to it.
@part
// The row id IDENTIFIES the element in the XML — see ToolbarEntity_Element above.
@primaryKey("uuid")
export class ToolbarMenuEntity_Element extends ToolbarElementBaseEntity {
    @backReference toolbarMenu: Lite<ToolbarMenuEntity>;
    @rowOrder order: int;

    withEntity: boolean = false;
    autoSelect: boolean = false;
}

// ---- The root entities ---------------------------------------------------------------------------------

@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class ToolbarEntity extends Entity implements IUserAssetEntity, IToolbarEntity {

    // AssertImplementedBy(User, Role) in logic. Whose toolbar this is
    // (personal → a User; shared → a Role; null → global).
    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null;

    @stringLengthValidator({ max: 100 })
    name: string;

    location: ToolbarLocation = ToolbarLocation.Side;

    // Highest priority wins when several toolbars of one location are visible to the current role.
    priority: int | null;

    @validate<ToolbarEntity>(t => validateElements(t.elements))
    elements: ToolbarEntity_Element[];

    getSubToolbars(): Lite<Entity>[] {
        return subToolbarsOf(this.elements);
    }

    @quoted

    toString(): string {
        return this.name;
    }
}

// A reusable, collapsible GROUP of elements, optionally bound to
// an entity type (then the menu shows an entity picker and its elements split into with-/without-entity).
@reflect
@primaryKey("uuid")
@entity("Shared", "Master")
export class ToolbarMenuEntity extends Entity implements IUserAssetEntity, IHasEntityType, IToolbarEntity {

    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null;

    @stringLengthValidator({ max: 100 })
    name: string;

    @validate<ToolbarMenuEntity>(t => validateElements(t.elements))
    elements: ToolbarMenuEntity_Element[];

    entityType: Lite<TypeEntity> | null;

    getSubToolbars(): Lite<Entity>[] {
        return subToolbarsOf(this.elements);
    }

    @quoted

    toString(): string {
        return this.name;
    }
}

// One sidebar slot that switches between N
// ToolbarMenus (a dropdown; the picked menu's elements render below it).
@reflect
@primaryKey("uuid")
@entity("Shared", "Master")
export class ToolbarSwitcherEntity extends Entity implements IUserAssetEntity, IToolbarEntity {

    // UNIQUE here only — Toolbar and ToolbarMenu names are not, in either framework.
    @uniqueIndex
    @stringLengthValidator({ max: 100 })
    name: string;

    @implementedBy(() => [UserEntity, RoleEntity])
    owner: Lite<Entity> | null;

    options: ToolbarSwitcherEntity_Option[];

    getSubToolbars(): Lite<Entity>[] {
        return (this.options ?? []).map(o => o.toolbarMenu as Lite<Entity>).filter(l => l != null);
    }

    @quoted

    toString(): string {
        return this.name;
    }
}

// One switchable menu plus its icon.
@part
export class ToolbarSwitcherEntity_Option extends Entity {
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

// ---- Operations ----------------------------------------------------------------------------------------

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

// ---- Validation helpers --------------------------------------------------------------------------------

function isDivider(e: ToolbarElementBaseEntity): boolean {
    return Enum.toName(ToolbarElementType, e.type) === "Divider";
}

/** For a Divider the member must NOT be set. */
function mustBeNull(value: unknown, message: { niceToString(): string }): string | null {
    return value == null || value === "" ? null : message.niceToString();
}

/** Label is mandatory-when-no-content for an Item / a Header. */
function isLabelledType(e: ToolbarElementBaseEntity): boolean {
    const type = Enum.toName(ToolbarElementType, e.type);
    return type === "Item" || type === "Header";
}

/** Url is mandatory-when-no-content for an Item / an ExtraIcon. */
function isNavigableType(e: ToolbarElementBaseEntity): boolean {
    const type = Enum.toName(ToolbarElementType, e.type);
    return type === "Item" || type === "ExtraIcon";
}

/** An absolute http(s) URL, or a
 *  site-relative path ("/order/1" or "~/order/1"). Toolbar urls may also carry the `:id` / `:type`
 *  / `:key` / `:toStr` entity placeholders (see client/ToolbarUrl.ts), which are legal path characters. */
function validateUrl(url: string): string | null {
    const ok = /^https?:\/\/[^\s]+$/i.test(url) || /^~?\/[^\s]*$/.test(url);
    return ok ? null : ToolbarMessage.InvalidUrl0.niceToString(url);
}

/** The element checks, run as an OWNER-level validation because they span sibling rows: an ExtraIcon
 *  attaches to the element BEFORE it, so it may be neither first nor right after a Divider. */
function validateElements(elements: ToolbarElementBaseEntity[] | undefined): string | null {
    if (elements == null || elements.length === 0)
        return null;

    const typeOf = (e: ToolbarElementBaseEntity): string => Enum.toName(ToolbarElementType, e.type);

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
function subToolbarsOf(elements: ToolbarElementBaseEntity[] | undefined): Lite<Entity>[] {
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

// The trailing entries are altea-only: the messages Signum expresses through C# validator attributes
// (StateValidator / URLValidator / NumberIsValidator) and two shared ValidationMessage reuses, which are
// stated explicitly here.
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

// `[AllowUnauthenticated]` there; altea messages are shipped in the
// reflection blob for every user, so the marker has no analogue.
export const LayoutMessage = {
    JumpToMainContent: msg("Jump to main content"),
    SelectA0_G: msg("Select a {0}"),
};

// Kept although the feature they belong to — SubFramePage / SubsClient, a sub-entity frame page bundled
// in Signum.Toolbar — is NOT ported: it needs FramePage internals altea has not exposed. The two messages
// cost nothing and mark the deferral.
export const SubPageMessage = {
    No0FoundIn1: msg("No {0} found in {1}"),
    NotAllowedToCreate0In1: msg("Not allowed to create {0} in {1}"),
};

// The database schema this package's tables live in. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("toolbar");
