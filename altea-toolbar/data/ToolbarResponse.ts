import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { ToolbarElementType, ShowCount } from "./Toolbar";

// The toolbar WIRE model: what `GET /api/toolbar/current/:location` and `GET /api/toolbarMenu/:menuId`
// return — the FLATTENED, authorization-filtered, label-resolved tree the renderers draw.
//
// Signum declared this twice: as C# classes (`ToolbarResponse` / `ToolbarExtraIcon` / `ToolbarResponseBase`
// in ToolbarLogic.cs, with `[JsonIgnore(WhenWritingNull)]` on every optional member) and again by hand as
// the `ToolbarResponse<T>` TS interface in ToolbarClient.tsx. altea is one language, so the contract is
// declared ONCE here in the isomorphic DATA layer: the server response builder produces these shapes and the
// client renderers consume them. Member names match Signum's JSON exactly, so the ported renderers read
// unchanged.
//
// Why a DTO at all (rather than shipping the entities): the response is a *derived* view — sub-toolbars are
// inlined, unauthorized elements and the dividers/headers they orphan are dropped, and each element's label
// / icon / related query are resolved from its content's registered ToolbarContentConfig. See
// ToolbarLogic.toResponseList.
//
// altea divergence: Signum's generic parameter (`ToolbarResponse<T extends Entity>`) only ever narrowed
// `content`, so it is kept — `ToolbarResponse<QueryEntity>` reads exactly as in Signum's configs.

/** Signum's ToolbarResponseBase — the members every element (and every extra icon) carries. */
export interface ToolbarResponseBase<T extends Entity = Entity> {
    /** The source element row's stable `guid` (see ToolbarElementBase.guid). Absent for the
     *  synthetic responses the builder creates (a Toolbar/ToolbarMenu header, a switcher option). */
    guid?: string;
    type: ToolbarElementType;
    label?: string;
    content?: Lite<T>;
    url?: string;
    iconName?: string;
    iconColor?: string;
    showCount?: ShowCount;
    autoRefreshPeriod?: number;
    openInPopup?: boolean;
    autoSelect?: boolean;
    withEntity?: boolean;
    /** The query this element ultimately runs, when its content has one (Signum's comment: "for
     *  authorization by selected entity"). Filled from the content config's `getRelatedQuery`. */
    queryKey?: string;
}

/** Signum's ToolbarResponse — a base response that may additionally NEST (a menu / switcher / inlined
 *  toolbar) and may carry the extra icons that trail it. */
export interface ToolbarResponse<T extends Entity = Entity> extends ToolbarResponseBase<T> {
    elements?: ToolbarResponse<any>[];
    extraIcons?: ToolbarResponse<any>[];
    /** The clean type name of an entity-scoped ToolbarMenu's type (Signum's `entityType`) — the menu then
     *  renders an entity picker and splits its elements by `withEntity`. */
    entityType?: string;
}

/** Signum's ToolbarExtraIcon — structurally the base (an extra icon never nests). Kept as a named alias so
 *  the port reads like the C#; the client array is typed `ToolbarResponse[]` exactly as Signum's TS was. */
export type ToolbarExtraIcon<T extends Entity = Entity> = ToolbarResponseBase<T>;
