import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { ToolbarElementTypeKeys, ShowCountKeys } from "./Toolbar";

// The toolbar WIRE model — see port/Toolbar.md.
//
// What `GET /api/toolbar/current/:location` and `GET /api/toolbarMenu/:menuId` return: the FLATTENED,
// authorization-filtered, label-resolved tree the renderers draw. Declared ONCE, in the isomorphic DATA
// layer, so the server builder and the client renderers cannot drift; member names match Signum's JSON
// exactly, which is what lets the ported renderers read unchanged.
//
// It is a DTO rather than the entities because the response is a DERIVED view: sub-toolbars are inlined,
// unauthorized elements and the dividers / headers they orphan are dropped, and each element's label /
// icon / related query are resolved from its content's registered ToolbarContentConfig. See
// ToolbarLogic.toResponseList.

/** The members every element (and every extra icon) carries. */
export interface ToolbarResponseBase<T extends Entity = Entity> {
    /** The source element row's stable `guid` (see ToolbarElementBaseEntity.guid). Absent for the
     *  synthetic responses the builder creates (a Toolbar/ToolbarMenu header, a switcher option). */
    guid?: string;
    type: ToolbarElementTypeKeys;
    label?: string;
    content?: Lite<T>;
    url?: string;
    iconName?: string;
    iconColor?: string;
    showCount?: ShowCountKeys;
    autoRefreshPeriod?: number;
    openInPopup?: boolean;
    autoSelect?: boolean;
    withEntity?: boolean;
    /** The query this element ultimately runs, when its content has one ("for
     *  authorization by selected entity"). Filled from the content config's `getRelatedQuery`. */
    queryKey?: string;
}

/** A base response that may additionally NEST (a menu / switcher / inlined
 *  toolbar) and may carry the extra icons that trail it. */
export interface ToolbarResponse<T extends Entity = Entity> extends ToolbarResponseBase<T> {
    elements?: ToolbarResponse<any>[];
    extraIcons?: ToolbarResponse<any>[];
    /** The clean type name of an entity-scoped ToolbarMenu's type — the menu then
     *  renders an entity picker and splits its elements by `withEntity`. */
    entityType?: string;
}

/** Structurally the base (an extra icon never nests). Kept as a named alias so
 *  the port reads like the C#; the client array is typed `ToolbarResponse[]`. */
export type ToolbarExtraIcon<T extends Entity = Entity> = ToolbarResponseBase<T>;
