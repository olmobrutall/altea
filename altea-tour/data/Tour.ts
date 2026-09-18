import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, part, primaryKey, uniqueIndex, implementedBy, quoted, backReference, rowOrder, translatable,
} from "@altea/altea/data/decorators";
import { stringLengthValidator, validate, noRepeatValidator } from "@altea/altea/data/validators";
import { type int } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { PropertyRouteEntity } from "@altea/altea/data/propertyRouteEntity";
import { TourTriggerSymbol } from "@altea/altea/data/tourTrigger";
import type { IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { DashboardEntity } from "@altea/altea-dashboard/data/Dashboard";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";

// A guided walkthrough of a page: an ordered list of STEPS, each one a popover anchored to a CSS selector,
// played by driver.js in the client.
//
// A tour is addressed by its TRIGGER — the thing it explains: an entity TYPE (its view), a DASHBOARD, a
// USER QUERY, or a declared `TourTriggerSymbol` (core's framework-level anchor, so any module can offer
// one without depending on this package).
//
// **The Property selector uses the route's LAST SEGMENT**, because a Line's `data-property-path` is its
// OWN member ("city") rather than the full dotted route — the divergence altea-playwright documents.
// `cssSelector()` below builds the selector accordingly, and lives HERE so the editor's live preview and
// the served DTO cannot drift.
//
// Port of Signum.Tour's Tour.cs — see port/Tour.md.

@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class TourEntity extends Entity implements IUserAssetEntity {

    /** What this tour explains — a type's view, a dashboard, a user query, or a declared trigger. */
    @uniqueIndex
    @implementedBy(() => [TypeEntity, TourTriggerSymbol, DashboardEntity, UserQueryEntity])
    trigger: Lite<Entity>;

    /** The steps, in order. */
    steps: TourStepEntity[];

    showProgress: boolean = false;

    animate: boolean = true;

    showCloseButton: boolean = true;

    @quoted toString(): string { return this.trigger?.toString() ?? ""; }
}

export namespace TourOperation {
    export const Save: ExecuteSymbol<TourEntity> = init();
    export const Delete: DeleteSymbol<TourEntity> = init();
}

@reflect
@part
export class TourStepEntity extends Entity {

    @backReference tour: Lite<TourEntity>;

    @rowOrder order: int;

    @translatable
    @stringLengthValidator({ max: 200 })
    title: string;

    /** The steps that AND together into this popover's anchor selector (see {@link cssSelector}). */
    cssSteps: CssStepEntity[];

    /** Markdown — the client renders it through micromark. `@translatable` as plain TEXT, not Html: the
     *  stored value is markdown source, which the translation editor should show as-is. */
    @translatable
    @stringLengthValidator({ multiLine: true })
    description: string;

    side: PopoverSide | null;

    align: PopoverAlign | null;

    click: ClickTrigger | null;

    @quoted toString(): string { return this.title ?? "Step"; }
}

export enum ClickTrigger {
    OnLoad,
    OnNext,
}

export enum PopoverSide {
    Top,
    Right,
    Bottom,
    Left,
}

export enum PopoverAlign {
    Start,
    Center,
    End,
}

export enum CssStepType {
    CSSSelector,
    Property,
    ToolbarContent,
    DashboardPart,
    TableColumn,
}

/**
 * One segment of a step's anchor: a discriminated record where exactly one field is set, chosen by `type`.
 * An ENTITY rather than an embedded because it is a collection row (see the header).
 */
@reflect
@part
export class CssStepEntity extends Entity {

    @backReference tourStep: Lite<TourStepEntity>;

    @rowOrder order: int;

    type: CssStepType = CssStepType.CSSSelector;

    // A field must be set exactly when `type` selects it — one validator per field.
    @validate<CssStepEntity>(a => isSetOnlyWhen(a.cssSelector, a.type == CssStepType.CSSSelector, "cssSelector"))
    @stringLengthValidator({ max: 200 })
    cssSelector: string | null;

    @validate<CssStepEntity>(a => isSetOnlyWhen(a.property, a.type == CssStepType.Property, "property"))
    property: PropertyRouteEntity | null;

    @validate<CssStepEntity>(a => isSetOnlyWhen(a.toolbarContent, a.type == CssStepType.ToolbarContent, "toolbarContent"))
    @implementedBy(() => [QueryEntity])
    toolbarContent: Lite<Entity> | null;

    /** The uuid of a `DashboardEntity_Part` row — the dashboard part this step points at. */
    @validate<CssStepEntity>(a => isSetOnlyWhen(a.dashboardPart, a.type == CssStepType.DashboardPart, "dashboardPart"))
    dashboardPart: string | null;

    @validate<CssStepEntity>(a => isSetOnlyWhen(a.tableColumn, a.type == CssStepType.TableColumn, "tableColumn"))
    @stringLengthValidator({ max: 400 })
    tableColumn: string | null;
}

// Set exactly when the condition holds: missing when it does, present when it does not, are both errors.
function isSetOnlyWhen(value: unknown, condition: boolean, member: string): string | null {
    const isSet = value != null && value !== "";
    if (condition && !isSet)
        return TourMessage._0HasToBeSetWhenTypeIs1.niceToString(CssStepEntity.nicePropertyName(a => a.type), member);
    if (!condition && isSet)
        return TourMessage._0HasToBeNullWhenTypeIsNot1.niceToString(CssStepEntity.nicePropertyName(a => a.type), member);
    return null;
}

/**
 * The CSS selector one step resolves to — the space-joined selectors of its `cssSteps`, i.e. a descendant
 * chain. It lives HERE, in the isomorphic data layer, so the editor's live preview and the DTO the player
 * consumes can never disagree — they call this one function.
 *
 * `toolbarContentKey` is supplied by the caller because resolving a `Lite<QueryEntity>` to its query KEY
 * needs a lookup the data layer cannot do; the server passes the retrieved key, the editor passes the
 * lite's toString (which for a QueryEntity IS its key).
 */
export function cssSelector(step: TourStepEntity, toolbarContentKey: (lite: Lite<Entity>) => string): string {
    return step.cssSteps
        .map(s => cssStepSelector(s, toolbarContentKey))
        .filter(s => s != null)
        .join(" ");
}

export function cssStepSelector(s: CssStepEntity, toolbarContentKey: (lite: Lite<Entity>) => string): string | null {
    switch (s.type) {
        case CssStepType.CSSSelector:
            return s.cssSelector;
        // The LAST segment, not the whole route — altea's Lines render their own member (see the header).
        case CssStepType.Property:
            return s.property == null ? null : `[data-property-path='${lastSegment(s.property.path)}']`;
        case CssStepType.ToolbarContent:
            return s.toolbarContent == null ? null : `[data-toolbar-content='${toolbarContentKey(s.toolbarContent)}']`;
        case CssStepType.DashboardPart:
            return s.dashboardPart == null ? null : `[data-part-content='${s.dashboardPart}']`;
        case CssStepType.TableColumn:
            return s.tableColumn == null ? null : `[data-column-name='${s.tableColumn}']`;
        default:
            return null;
    }
}

function lastSegment(propertyString: string): string {
    const i = propertyString.lastIndexOf(".");
    return i < 0 ? propertyString : propertyString.substring(i + 1);
}

export const TourMessage = {
    Next: msg("Next"),
    Previous: msg("Previous"),
    Close: msg("Close"),
    Done: msg("Done"),
    ReplayTour: msg("Replay tour"),
    StartTour: msg("Start tour"),
    CreateTour: msg("Create tour"),
    EditTour: msg("Edit tour"),
    // The two halves of the isSetOnlyWhen rule, as message keys so they are translatable.
    _0HasToBeSetWhenTypeIs1: msg("{0} has to be set when the type is {1}"),
    _0HasToBeNullWhenTypeIsNot1: msg("{0} has to be null when the type is not {1}"),
    FinalCSSSelector: msg("Final CSS selector"),
    CssStep: msg("CSS step"),
};

setDefaultDatabaseSchema("tour");
