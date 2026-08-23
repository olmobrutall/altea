import { init } from "@altea/altea/data/reflection";
import { msg } from "@altea/altea/data/utils/localization";
import type { EntityKind, EntityData } from "@altea/altea/data/decorators";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import type { OmniboxResult, OmniboxMatch } from "@altea/altea-omnibox/data/OmniboxResults";

// Port of Signum.Map's MapMessage.cs + Signum.Map.ts — plus, in the same file, the two WIRE DTO
// families the module is really about.
//
// Signum declares each DTO TWICE: once as a C# class (SchemaMap.cs / OperationMap.cs /
// MapColorProvider.cs) and again, by hand, as a TypeScript interface inside
// Schema/ClientColorProvider.ts and Operation/OperationMap.ts. altea is ONE language, so each shape is
// declared once here in the isomorphic DATA layer — the same call altea-omnibox makes in
// data/OmniboxResults.ts. The client's d3-facing SUPERTYPES (the ones that mix in
// d3.SimulationNodeDatum and carry the layout fields d3 mutates) stay in the client layer: they are not
// part of the wire contract, and the data layer must not import d3.
//
// ---- altea divergences in the model itself -------------------------------------------------------
//
//  - **MList is gone, so half the schema map's node kinds go with it.** Signum draws a table's MList
//    tables as extra CHILD nodes (`TableInfo.mlistTables`), joined to their owner by a special
//    `mlist_arrow`, plus a `entityBaseType: "MList"` shape and its own CSS. In altea a collection is
//    `@part` CHILD ROWS of an ordinary entity table, i.e. always Signum's VirtualMList shape — so those
//    tables are already first-class nodes and there is nothing to synthesise. `mlistTables` /
//    `MListTableInfo` / `MListRelationInfo` / `isMList` / `EntityBaseType.MList` are therefore NOT
//    ported. What survives is the ARROW that made a virtual MList legible: Signum's
//    `isVirtualMListBackReference` becomes `isBackReference` (read off `FieldInfo.isBackReference`,
//    which is exactly the same fact), still drawn dashed with the double-headed marker.
//  - **`EntityBaseType.SemiSymbol` is not ported** — altea has no SemiSymbol (see altea-alert on
//    AlertTypeSymbol).
//  - **`namespace` is the PACKAGE plus the declaring FOLDER.** altea has no C# namespace; the honest
//    analogue at the same granularity is the owning npm package + the directory the type is declared in
//    (`@altea/altea-auth/data`, `eastwind/orders`) — read off the transformer's `__fileInfo` through
//    `getLocation`, which is the same source altea-translations groups by. The field keeps Signum's
//    NAME so the ported colour provider reads unchanged.
//  - **`partitions` is dropped** from the runtime stats: it is SQL-Server-only and nothing renders it.

// ---- permission ----------------------------------------------------------------------------------
// Declared, not registered: altea's SymbolLogic picks up every `init()`ed symbol, so Signum's
// `PermissionLogic.RegisterPermissions(MapPermission.ViewMap)` has no counterpart.
export namespace MapPermission {
    /** Gates both pages, both routes and the omnibox suggestion. */
    export const ViewMap: PermissionSymbol = init();
}

// ---- messages ------------------------------------------------------------------------------------
export const MapMessage = {
    Map: msg("Map"),
    Namespace: msg("Namespace"),
    TableSize: msg("Table size"),
    Columns: msg("Columns"),
    Rows: msg("Rows"),
    Press0ToExploreEachTable: msg("Press {0} to explore each table"),
    Press0ToExploreStatesAndOperations: msg("Press {0} to explore states and operations"),
    Filter: msg("Filter"),
    Color: msg("Color"),
    State: msg("State"),
    StateColor: msg("State color"),
    RowsHistory: msg("Rows history"),
    TableSizeHistory: msg("Table size history"),
    Show: msg("Show"),
    All: msg("All"),
    Selected: msg("Selected"),
    SelectedAndNeighbors: msg("Selected and neighbors"),
    Help: msg("Help"),
    HelpClick: msg("Click a table to select it. Click again to deselect."),
    HelpShiftClick: msg("Shift+Click to add or remove a table from the selection."),
    HelpCtrlClick: msg("Ctrl+Click to open the table in a new tab."),
    NoHistoryTable: msg("No history table"),
};

// Signum's `DefaultState` — the three PSEUDO-states the operation map draws so that an operation with
// no `fromStates` / `toStates` still has something to point at: Start (a constructor's source), End (a
// delete's target) and All ("any state", when the list is present but empty).
export enum DefaultStateEnum {
    Start,
    All,
    End,
}
export type DefaultState = keyof typeof DefaultStateEnum;

// ---- the schema map's wire model (Signum's SchemaMap.cs) -----------------------------------------

export type EntityBaseType =
    | "EnumEntity"
    | "Symbol"
    | "Entity"
    | "Part";

/** Signum's `TableInfo`. `extra` is the bag a colour provider's `addExtra` fills (see AuthColorProvider). */
export interface TableInfo {
    typeName: string;
    niceName: string;
    tableName: string;
    entityKind?: EntityKind;
    entityData?: EntityData;
    entityBaseType: EntityBaseType;
    /** The owning package + declaring folder — see the divergence note above. */
    namespace: string;
    columns: number;
    rows: number | null;
    total_size_kb: number | null;
    rows_history: number | null;
    total_size_kb_history: number | null;
    extra: { [key: string]: unknown };
}

/** Signum's `RelationInfo` — one FK edge. */
export interface RelationInfo {
    fromTable: string;
    toTable: string;
    nullable: boolean;
    lite: boolean;
    /** Signum's `isVirtualMListBackReference` — a `@backReference` FK, i.e. a `@part` collection's own
     *  pointer back at its owner. Drawn dashed, with the double-headed marker at the SOURCE end. */
    isBackReference?: boolean;
}

/** Signum's `MapColorProviderInfo` — one entry of the "Color" dropdown. */
export interface MapColorProviderInfo {
    name: string;
    niceName: string;
}

export interface SchemaMapInfo {
    tables: TableInfo[];
    relations: RelationInfo[];
    providers: MapColorProviderInfo[];
}

// ---- the operation map's wire model (Signum's OperationMap.cs) -----------------------------------

/** Signum's `MapState`. `token` is the query token that filters the type by this state (see below). */
export interface MapState {
    key: string;
    niceName: string;
    count: number;
    /** The enum member is `Enum.markAsNotMapped`-ed (Signum's `[Ignore]`) — drawn dashed. */
    ignored: boolean;
    /** One of the three `DefaultState` pseudo-states rather than a real member. */
    isSpecial: boolean;
    color: string | null;
    /** ALTEA: a ROOTLESS camelCase token ("state", "scriptExecution.state"), where Signum sends
     *  "Entity.State". Null for a pseudo-state, and for a state type whose selector is not quotable. */
    token: string | null;
}

/** Signum's `MapOperation`. */
export interface MapOperation {
    key: string;
    niceName: string;
    count: number;
    fromStates: string[];
    toStates: string[];
}

export interface OperationMapInfo {
    states: MapState[];
    operations: MapOperation[];
}

// ---- the omnibox suggestion (Signum's MapOmniboxResult) ------------------------------------------
// Declared here, in the isomorphic layer, for the same reason altea-omnibox declares its own results in
// data/: the server generator produces it and the client provider renders it, and the client may not
// reference the server layer.

export interface MapOmniboxResult extends OmniboxResult {
    keywordMatch: OmniboxMatch;
    typeName?: string;
    typeMatch?: OmniboxMatch;
}

/** The discriminator the client's provider registry is keyed by — Signum's C# class name, verbatim. */
export const MapOmniboxResultTypeName = "MapOmniboxResult";
