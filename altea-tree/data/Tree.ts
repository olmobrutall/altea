import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, ModelEntity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import {
    entity, implementedByAll, column, uniqueIndex,
    stringLengthValidator, fieldValidation,
} from "@altea/altea/data/decorators";
import { msg } from "@altea/altea/data/utils/localization";
import { type int } from "@altea/altea/data/basics";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { ValidationMessage, notNullValidator } from "@altea/altea/data/validators";
import type { OmniboxResult, OmniboxMatch } from "@altea/altea-omnibox/data/OmniboxResults";
import { UserQueryEntity } from "@altea/altea-user-queries/data/UserQuery";
import type { IPartEntity } from "@altea/altea-dashboard/data/Dashboard";

// Port of Signum.Tree's TreeEntity.cs — an entity whose rows form a FOREST, materialised as a
// depth-first PATH on each row, so "the subtree under X" and "the children of X" are one indexed
// predicate instead of a recursive query.
//
// ================================================================================================
// THE ONE BIG DIVERGENCE: `route` is a STRING, not a hierarchyid.
// ================================================================================================
//
// Signum types `Route` as `SqlHierarchyId` — a SQL Server CLR type — and leans on its methods
// (`GetRoot`, `GetDescendant`, `GetAncestor`, `GetLevel`, `IsDescendantOf`, `GetReparentedValue`) plus its
// native ordering. altea cannot: neither Node SQL driver surfaces hierarchyid, and PostgreSQL has no such
// type at all (its `ltree` is an extension, SQL-Server-less, and would not help with the hard part).
//
// So the route is a `varchar` holding Signum's own TEXTUAL form of a hierarchyid — `/1/`, `/1/3/`,
// `/1/3.1/` — and the arithmetic moves into TypeScript (server/TreeRoute). That form is not a
// re-invention: it is exactly what `SqlHierarchyId.ToString()` produces, so a database migrated from
// Signum reads unchanged, and the dotted label (`3.1`) is how hierarchyid itself represents a node
// inserted BETWEEN two siblings — which is what keeps the order dense.
//
// What each hierarchyid operation becomes:
//
//   IsDescendantOf(a)      →  route.startsWith(a)         →  SQL `LIKE 'a%'`  (indexed prefix)
//   GetAncestor(1)         →  the `parentRoute` COLUMN     →  SQL `=`         (Signum stores it too)
//   GetLevel()             →  a stored `level` COLUMN, maintained by TreeLogic.setRoute
//   GetDescendant(a, b)    →  a label strictly between a's and b's (see server/TreeRoute)
//   GetReparentedValue     →  a prefix swap
//   ORDER BY route         →  compared IN MEMORY, numerically per label
//
// The last one is the only place a string genuinely cannot stand in for the type: `'/10/' < '/2/'`
// lexicographically, and a database COLLATION may order punctuation and digits in ways that differ
// between dialects and locales. So the sort is done in TypeScript with a label-wise numeric comparator
// (`TreeRoute.compare`), which is deterministic everywhere. The tree UI loads a bounded set of nodes (the
// expanded ones plus the matches), so ordering them in memory costs nothing.

@reflect
export abstract class TreeEntity extends Entity {

    // The three ENGINE-MAINTAINED columns below (`route`, `parentRoute`, `fullName`) are computed by
    // `TreeLogic.setRoute` / `calculateFullName` inside the Save operation, so a new node reaches the
    // server with all three empty — hence `disabled: env => env !== "Saving"` on each of their
    // validators: they are checked only in the FINAL phase, once the operation has filled them in.
    // Signum expresses the same thing per field — `[NotNullValidator(Disabled = true)]` on ParentRoute,
    // `[NotNullValidator(Disabled = true)] [StringLengthValidator(…, DisabledInModelBinder = true)]` on
    // FullName, and `[InTypeScript(false)]` on Route (a hierarchyid struct always has a value, and it
    // never reaches the browser at all).

    /**
     * The depth-first path of this node — see the header. Signum's `Route`, textually identical.
     * `@uniqueIndex` because two rows may never occupy the same position.
     */
    @uniqueIndex
    @notNullValidator({ disabled: env => env !== "Saving" })
    @stringLengthValidator({ min: 3, max: 1024, disabled: env => env !== "Saving" })
    route: string;

    /**
     * The parent's route, or `"/"` for a root. Signum keeps this too (its `Route` setter writes it), and
     * it is what makes "the children of X" an equality filter rather than a LIKE.
     */
    @notNullValidator({ disabled: env => env !== "Saving" })
    @stringLengthValidator({ max: 1024, disabled: env => env !== "Saving" })
    parentRoute: string;

    /**
     * The node's depth, 1-based.
     *
     * ALTEA: a real COLUMN, where Signum declares it `[Ignore]` plus an `[ExpressionField]` over
     * `Route.GetLevel()`. With no hierarchyid there is no SQL function to compute it, and the only
     * alternative — deriving it from the route in a query — is not expressible portably. Storing it is
     * strictly better here: `level == 1` (the tree page's default filter, "show me the roots") becomes an
     * indexed integer comparison, and it is maintained in exactly one place (`TreeLogic.setRoute`), which
     * is also where Signum's `Route` setter maintained its copy.
     */
    level: int;

    /**
     * Where a NEW node goes: its parent (or, with `isSibling`, its preceding sibling). Not a column —
     * the Save operation reads it once to compute `route` and it is never persisted.
     */
    @column(false)
    @implementedByAll
    parentOrSibling: Lite<TreeEntity> | null = null;

    @column(false)
    isSibling: boolean = false;

    @stringLengthValidator({ min: 1, max: 255 })
    name: string;

    /**
     * The names of every ancestor plus this one, `" > "`-joined — recomputed whenever a name or a
     * position changes, so a search on the path is one indexed column.
     *
     * ALTEA: Signum declares it `nvarchar(max)`; a bounded column keeps it orderable and filterable as an
     * ordinary token (the tree's default order IS `fullName`), which an unbounded text column is not.
     * 4000 chars is ~15 levels of 255-char names.
     */
    @notNullValidator({ disabled: env => env !== "Saving" })
    @stringLengthValidator({ max: 4000, disabled: env => env !== "Saving" })
    fullName: string;

    toString(): string {
        return this.name;
    }
}

export namespace TreeOperation {
    export const CreateRoot: ConstructSymbol<TreeEntity> = init();
    export const CreateChild: ConstructSymbol<TreeEntity, From<TreeEntity>> = init();
    export const CreateNextSibling: ConstructSymbol<TreeEntity, From<TreeEntity>> = init();
    export const Save: ExecuteSymbol<TreeEntity> = init();
    export const Move: ExecuteSymbol<TreeEntity> = init();
    export const Copy: ConstructSymbol<TreeEntity, From<TreeEntity>> = init();
    export const Delete: DeleteSymbol<TreeEntity> = init();
}

// ---- move / copy ---------------------------------------------------------------------------------

// ALTEA: one plain numeric enum, the shape an ENTITY enum field takes here (eastwind's `OrderState`) — no
// `Enum`-suffixed object plus a string-union alias. That second shape belongs to the query layer, whose
// runtime values ARE the member-name strings; a model field is an ordinal, so `AutoLine` needs the enum
// itself as the member type and comparisons go through the members (`InsertPlace.After`).
export enum InsertPlace {
    FirstNode,
    After,
    Before,
    LastNode,
}

/** Signum's `MoveTreeModel` — where to put a node (the argument of Move and Copy). */
@reflect
export class MoveTreeModel extends ModelEntity {

    @implementedByAll
    newParent: Lite<TreeEntity> | null = null;

    insertPlace: InsertPlace;

    // Signum's PropertyValidation: a Before/After move needs the sibling it goes next to.
    @fieldValidation<MoveTreeModel>(m => (m.insertPlace === InsertPlace.After || m.insertPlace === InsertPlace.Before) && m.sibling == null
        ? ValidationMessage._0IsNotSet.niceToString(MoveTreeModel.nicePropertyName(a => a.sibling))
        : null)
    @implementedByAll
    sibling: Lite<TreeEntity> | null = null;

    toString(): string {
        return TreeMessage.Move0.niceToString(this.newParent?.toString() ?? "");
    }
}

// ---- the wire model the tree page reads ----------------------------------------------------------

/**
 * Signum's `TreeInfo` — everything the viewer needs about ONE node. In Signum it is the projection of a
 * registered `TreeInfo()` query expression, which the controller then rebases onto
 * `Entity.Ascendants.Element.TreeInfo`; here the server builds it directly (see server/TreeServer on why
 * the token-rebasing machinery has no altea counterpart).
 */
export interface TreeInfo {
    name: string;
    fullName: string;
    lite: Lite<TreeEntity>;
    disabled: boolean;
    childrenCount: int;
    route: string;
    level: int;
}

export type TreeNodeState = "Collapsed" | "Expanded" | "Filtered" | "Leaf";

/** Signum's `TreeNode` — a TreeInfo plus the children already loaded and the extra column values. */
export interface TreeNode {
    values: unknown[];
    lite: Lite<TreeEntity>;
    name: string;
    fullName: string;
    disabled: boolean;
    childrenCount: int;
    level: int;
    loadedChildren: TreeNode[];
    /** Filled CLIENT-side by `TreeClient.fixState` — the server does not know what is expanded. */
    nodeState: TreeNodeState;
}

export interface FindNodesRequest {
    /** The user's own filters (rows matching these, plus their ancestors, are shown). */
    userFilters: unknown[];
    /** Filters that always apply — a modal's "not this subtree", a dashboard part's context. */
    frozenFilters: unknown[];
    columns: unknown[];
    expandedNodes: Lite<TreeEntity>[];
    loadDescendants: boolean;
}

export interface FindNodesResponse {
    /** The token keys actually present in `TreeNode.values`, in order. */
    columns: string[];
    nodes: TreeNode[];
}

export interface GetNodeRequest {
    lite: Lite<TreeEntity>;
    columns: unknown[];
}

// ---- messages ------------------------------------------------------------------------------------

export const TreeMessage = {
    Tree: msg("Tree"),
    Descendants: msg("Descendants"),
    Parent: msg("Parent"),
    Ascendants: msg("Ascendants"),
    Children: msg("Children"),
    Level: msg("Level"),
    TreeInfo: msg("Tree info"),
    TreeType: msg("Tree type"),
    LevelShouldNotBeGreaterThan0: msg("Level should not be greater than {0}"),
    ImpossibleToMove0InsideOf1: msg("Impossible to move {0} inside of {1}"),
    ImpossibleToMove01Of2: msg("Impossible to move {0} {1} of {2}"),
    Move0: msg("Move {0}"),
    Copy0: msg("Copy {0}"),
    ListView: msg("List view"),
};

export const TreeViewerMessage = {
    Search: msg("Search"),
    AddRoot: msg("Add root"),
    AddChild: msg("Add child"),
    AddSibling: msg("Add sibling"),
    Remove: msg("Remove"),
    None: msg("None"),
    ExpandAll: msg("Expand all"),
    CollapseAll: msg("Collapse all"),
    // ALTEA: Signum reads these two off `EntityControlMessage.Expand` / `.Collapse`, which altea's core
    // does not declare (nothing else in the framework expands anything), so they live with the module
    // that needs them — same call the Help port made for `CopyLinkToken`.
    Expand: msg("Expand"),
    Collapse: msg("Collapse"),
};

// ---- the omnibox suggestion ----------------------------------------------------------------------

export interface TreeOmniboxResult extends OmniboxResult {
    /** The tree type's clean name (Signum serializes its `Type` through a converter to the query key). */
    type: string;
    typeMatch: OmniboxMatch;
}

export const TreeOmniboxResultTypeName = "TreeOmniboxResult";

// ---- the dashboard part --------------------------------------------------------------------------

/** Signum's `UserTreePartEntity` — a dashboard panel showing a tree, scoped by a stored user query. */
@reflect
@entity("Part", "Master")
export class UserTreePartEntity extends Entity implements IPartEntity {

    userQuery: UserQueryEntity;

    requiresTitle(): boolean {
        return false;
    }

    clone(): IPartEntity {
        return UserTreePartEntity.create({ userQuery: this.userQuery }) as unknown as IPartEntity;
    }

    toString(): string {
        return this.userQuery?.toString() ?? "";
    }
}
