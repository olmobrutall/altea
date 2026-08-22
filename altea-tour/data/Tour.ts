import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import {
    entity, primaryKey, uniqueIndex, implementedBy, stringLengthValidator, quoted,
    backReference, rowOrder, fieldValidation,
} from "@altea/altea/data/decorators";
import { noRepeatValidator } from "@altea/altea/data/validators";
import { type int } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TourTriggerSymbol } from "@altea/altea/data/tourTrigger";
import type { IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { DashboardEntity } from "@altea/altea-dashboard/data/Dashboard";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";

// Port of Signum.Tour's Tour.cs — a guided walkthrough of a page: an ordered list of STEPS, each one a
// popover anchored to a CSS selector, played by driver.js in the client.
//
// A tour is addressed by its TRIGGER — the thing it explains: an entity TYPE (its view), a DASHBOARD, a
// USER QUERY, or a declared `TourTriggerSymbol` (core's framework-level anchor, so any module can offer
// one without depending on this package).
//
// altea divergences:
//  - **no `Guid` field.** Like every other user asset here, the portable identity IS the uuid PRIMARY KEY
//    (see altea-user-queries' UserQueryEntity), so Signum's `[UniqueIndex] Guid Guid` and its separate
//    index are gone.
//  - **`MList` → `@part` rows twice over.** `Steps` is Signum's `[Ignore] MList` + `WithVirtualMList` —
//    which IS altea's `@part` collection — and `CssSteps` (a real MList of embeddeds) becomes `@part`
//    rows too, keeping Signum's `CssStepEmbedded` NAME, "Embedded" suffix included, exactly as the AD
//    configurations did.
//  - **`PropertyRouteEntity` does not exist in altea** (see altea-auth's RulePropertyEntity: a property is
//    keyed by its route STRING, not by a row in a routes table). So a "Property" CSS step stores the
//    route's `propertyString()` in `property` — which is also what the selector needs — and the whole
//    `PreDeleteSqlSync` cascade Signum hangs off PropertyRouteEntity disappears with the table.
//  - **the Property selector uses the route's LAST SEGMENT.** altea re-roots the PropertyRoute at each
//    embedded it renders, so a Line's `data-property-path` is its OWN member ("city"), not Signum's full
//    dotted route ("shipAddress.city") — the same divergence altea-playwright documents. `cssSelector()`
//    below builds the selector accordingly.

@reflect
@primaryKey("uuid")
@entity("Main", "Master")
export class TourEntity extends Entity implements IUserAssetEntity {

    /** What this tour explains. Signum's four implementations, unchanged. */
    @uniqueIndex
    @implementedBy(() => [TypeEntity, TourTriggerSymbol, DashboardEntity, UserQueryEntity])
    trigger: Lite<Entity>;

    /** Signum's `[QueryableProperty, Ignore, NoRepeatValidator, PreserveOrder] MList<TourStepEntity>`. */
    @noRepeatValidator()
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
@entity("Part", "Master")
export class TourStepEntity extends Entity {

    @backReference tour: Lite<TourEntity>;

    @rowOrder order: int;

    /** Signum marks this `[Translatable]` — see @altea/altea-translations' route registry. */
    @stringLengthValidator({ max: 200 })
    title: string;

    /** The steps that AND together into this popover's anchor selector (see {@link cssSelector}). */
    @noRepeatValidator()
    cssSteps: CssStepEmbedded[];

    /** Signum marks this `[Translatable]` too. Markdown — the client renders it through micromark. */
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
 * One segment of a step's anchor. Signum's `CssStepEmbedded` — a discriminated record where exactly one
 * field is set, chosen by `type`. Kept as an ENTITY here because it is a collection row (see the header).
 */
@reflect
@entity("Part", "Master")
export class CssStepEmbedded extends Entity {

    @backReference tourStep: Lite<TourStepEntity>;

    @rowOrder order: int;

    type: CssStepType = CssStepType.CSSSelector;

    // Signum's `PropertyValidation` with five `IsSetOnlyWhen` clauses, one per member: a field must be set
    // exactly when `type` selects it. Written as one validator per field, altea's shape for the same rule.
    @fieldValidation<CssStepEmbedded>(a => isSetOnlyWhen(a.cssSelector, a.type == CssStepType.CSSSelector, "cssSelector"))
    @stringLengthValidator({ max: 200 })
    cssSelector: string | null;

    /** A PropertyRoute's `propertyString()` — altea has no PropertyRouteEntity (see the header). */
    @fieldValidation<CssStepEmbedded>(a => isSetOnlyWhen(a.property, a.type == CssStepType.Property, "property"))
    @stringLengthValidator({ max: 400 })
    property: string | null;

    @fieldValidation<CssStepEmbedded>(a => isSetOnlyWhen(a.toolbarContent, a.type == CssStepType.ToolbarContent, "toolbarContent"))
    @implementedBy(() => [QueryEntity])
    toolbarContent: Lite<Entity> | null;

    /** The uuid of a `DashboardEntity_Part` row — the dashboard part this step points at. */
    @fieldValidation<CssStepEmbedded>(a => isSetOnlyWhen(a.dashboardPart, a.type == CssStepType.DashboardPart, "dashboardPart"))
    dashboardPart: string | null;

    @fieldValidation<CssStepEmbedded>(a => isSetOnlyWhen(a.tableColumn, a.type == CssStepType.TableColumn, "tableColumn"))
    @stringLengthValidator({ max: 400 })
    tableColumn: string | null;
}

// Signum's `(pi, value).IsSetOnlyWhen(condition)`.
function isSetOnlyWhen(value: unknown, condition: boolean, member: string): string | null {
    const isSet = value != null && value !== "";
    if (condition && !isSet)
        return TourMessage._0HasToBeSetWhenTypeIs1.niceToString(CssStepEmbedded.nicePropertyName(a => a.type), member);
    if (!condition && isSet)
        return TourMessage._0HasToBeNullWhenTypeIsNot1.niceToString(CssStepEmbedded.nicePropertyName(a => a.type), member);
    return null;
}

/**
 * The CSS selector one step resolves to — the space-joined selectors of its `cssSteps`, i.e. a descendant
 * chain. Signum computes this twice: on the SERVER (`TourController.ResolveCssSelector`, for the DTO the
 * player consumes) and again in the editor's preview. Here it lives ONCE, in the isomorphic data layer, so
 * the preview and the served DTO can never disagree.
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

export function cssStepSelector(s: CssStepEmbedded, toolbarContentKey: (lite: Lite<Entity>) => string): string | null {
    switch (s.type) {
        case CssStepType.CSSSelector:
            return s.cssSelector;
        // The LAST segment, not the whole route — altea's Lines render their own member (see the header).
        case CssStepType.Property:
            return s.property == null ? null : `[data-property-path='${lastSegment(s.property)}']`;
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
    // altea-only: Signum spells these two inline in `IsSetOnlyWhen`'s ValidationMessage.
    _0HasToBeSetWhenTypeIs1: msg("{0} has to be set when the type is {1}"),
    _0HasToBeNullWhenTypeIsNot1: msg("{0} has to be null when the type is not {1}"),
    FinalCSSSelector: msg("Final CSS selector"),
    CssStep: msg("CSS step"),
};
