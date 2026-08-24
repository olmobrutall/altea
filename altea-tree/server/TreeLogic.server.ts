import "@altea/altea/server";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import { operations } from "@altea/altea/server/fluentOperations";
import type { FluentInclude } from "@altea/altea/server/schema/fluentInclude";
import { table } from "@altea/altea/server/table";
import { Saver } from "@altea/altea/server/saver";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { withQuoted } from "@altea/altea/data/decorators";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { toInt, type int } from "@altea/altea/data/basics";
import { Enum } from "@altea/altea/data/enum";
import {
    TreeEntity, TreeMessage, TreeOperation, InsertPlace,
    type MoveTreeModel,
} from "../data/Tree";
import { TreeRoute } from "./TreeRoute.server";

// Port of Signum.Tree's TreeLogic.cs — the engine: the query expressions every tree type gets, the
// seven operations, and the route arithmetic that keeps a forest consistent when a node is added, renamed,
// moved or copied.
//
// altea divergences:
//  - **the route is a STRING** (see data/Tree.ts). Every `SqlHierarchyId` call becomes a `TreeRoute`
//    call, and the four "find the neighbouring sibling" queries order IN MEMORY rather than by the
//    route column — see `siblingsOf`.
//  - **each expression is a `withQuoted` PROTOTYPE method plus a query TWIN**, the shape
//    `OperationLogic.registerPreviousLog` established and the reason altea-workflow needed twins: a
//    `withQuoted` member is QUERY-ONLY (the transformer stamps the tree beside the body and leaves the
//    body's inner lambdas unstamped), so calling one in memory throws. The engine needs both — a filter on
//    `descendants` must run in SQL, and `fixName` must walk the descendants in process.
//  - **only FOUR of Signum's six expressions are registered.** `Level` becomes a stored COLUMN (see
//    data/Tree.ts) — so it is an ordinary token, filterable and orderable without an expression at all —
//    and `TreeInfo` is gone: it existed so the controller could project a node's display data through a
//    query token and rebase it onto `Entity.Ascendants.Element.TreeInfo`, machinery that has no altea
//    counterpart (see server/TreeServer).
//  - **`DisabledMixin` is not ported** (Signum.Basics has it, altea does not), so every branch guarding
//    `MixinDeclarations.IsDeclared(typeof(T), typeof(DisabledMixin))` is gone: no cascade of
//    Disable/Enable down the subtree, and `TreeInfo.disabled` is always false. The FIELD stays on the wire
//    (the viewer styles a disabled node) so a host that adds such a mixin later has somewhere to put it.
//  - **`Graph<T>.Construct.Untyped(...)` becomes `operations(T)`**, and the copy hook stays an optional
//    argument of `withTree`, as in Signum.
export namespace TreeLogic {

    /**
     * Signum's `WithTree` — everything a concrete tree type needs, in one call:
     *
     *   sb.include(MyTreeEntity).withTree()
     *
     * `copy` is Signum's optional `Func<T, MoveTreeModel, T>`: without it the Copy operation is not
     * registered at all (a tree type must say how to duplicate one of its rows).
     */
    export function withTree<T extends TreeEntity>(
        include: FluentInclude<T>,
        options?: { copy?: (node: T, model: MoveTreeModel) => T },
    ): FluentInclude<T> {
        const type = include.type as Type<T>;

        registerExpressions(type);
        registerOperations(type, options?.copy);

        // Signum's `WithUniqueIndex(n => new { n.ParentRoute, n.Name })` — two siblings may not share a name.
        include.withUniqueIndex(n => [n.parentRoute, n.name]);

        return include;
    }

    // ---- the four query expressions --------------------------------------------------------------

    /**
     * Signum's `RegisterExpressions<T>` minus Level and TreeInfo (see the header). Each is a
     * `withQuoted` method stamped on the CONCRETE type's
     * prototype (so `table(type)` is a real constant in the tree the transformer captures) plus a
     * registration that turns it into a navigable token.
     */
    export function registerExpressions<T extends TreeEntity>(type: Type<T>): void {
        const proto = (type as unknown as { prototype: Record<string, unknown> }).prototype;

        proto.treeChildren = withQuoted(function (this: TreeEntity) {
            return table(type).filter(c => c.parentRoute == this.route);
        });

        proto.treeParent = withQuoted(function (this: TreeEntity) {
            return table(type).singleOrNull(p => p.route == this.parentRoute);
        });

        // INCLUSIVE, as hierarchyid's IsDescendantOf is: a node is its own descendant / ascendant.
        proto.treeDescendants = withQuoted(function (this: TreeEntity) {
            return table(type).filter(d => d.route.startsWith(this.route));
        });

        proto.treeAscendants = withQuoted(function (this: TreeEntity) {
            return table(type).filter(a => this.route.startsWith(a.route));
        });

        QueryLogic.expressions.register(type, (e: ITreeNavigations) => e.treeChildren!(),
            { key: "Children", niceName: () => TreeMessage.Children.niceToString() });
        QueryLogic.expressions.register(type, (e: ITreeNavigations) => e.treeParent!(),
            { key: "Parent", niceName: () => TreeMessage.Parent.niceToString() });
        QueryLogic.expressions.register(type, (e: ITreeNavigations) => e.treeDescendants!(),
            { key: "Descendants", niceName: () => TreeMessage.Descendants.niceToString() });
        QueryLogic.expressions.register(type, (e: ITreeNavigations) => e.treeAscendants!(),
            { key: "Ascendants", niceName: () => TreeMessage.Ascendants.niceToString() });
    }

    // ---- the query twins (the same four, callable in memory) --------------------------------------
    // A `withQuoted` member cannot be invoked (see the header), so every engine path uses these.

    export function childrenQuery<T extends TreeEntity>(type: Type<T>, node: T) {
        const route = node.route;
        return table(type).filter(c => c.parentRoute == route);
    }

    export function descendantsQuery<T extends TreeEntity>(type: Type<T>, node: T) {
        const route = node.route;
        return table(type).filter(d => d.route.startsWith(route));
    }

    export function ascendantsQuery<T extends TreeEntity>(type: Type<T>, node: T) {
        const route = node.route;
        return table(type).filter(a => route.startsWith(a.route));
    }

    export async function parentOf<T extends TreeEntity>(type: Type<T>, node: T): Promise<T | null> {
        const parentRoute = node.parentRoute;
        if (parentRoute === TreeRoute.root)
            return null;
        return await table(type).singleOrNull(p => p.route == parentRoute) as T | null;
    }

    /** Signum's `CalculateFullName` — "Root > Branch > Leaf". */
    export async function calculateFullName<T extends TreeEntity>(type: Type<T>, node: T): Promise<void> {
        const ascendants = await ascendantsQuery(type, node).toArray() as T[];
        // Ordered by ROUTE, so root-first; ascendantsQuery is a prefix filter, which has no natural order.
        ascendants.sort((a, b) => TreeRoute.compare(a.route, b.route));
        node.fullName = ascendants.map(a => a.name).join(" > ");
    }

    // ---- the neighbouring-sibling lookups --------------------------------------------------------

    /**
     * The routes of every direct child of `parentRoute`, in tree order.
     *
     * ALTEA: Signum asks the database for the single neighbour it needs (`ORDER BY route DESC TOP 1`),
     * which a hierarchyid column can do. A varchar cannot be ordered that way (`'/10/' < '/2/'`, plus
     * collation), so the sibling routes are read and ordered here. A node's sibling count is the branching
     * factor of the tree, not its size, so this stays small — and only the route column is selected.
     */
    async function siblingRoutes<T extends TreeEntity>(type: Type<T>, parentRoute: string): Promise<string[]> {
        const routes = await ExecutionMode.global(() => table(type)
            .filter(c => c.parentRoute == parentRoute)
            .map(c => c.route)
            .toArray());

        return routes.sort(TreeRoute.compare);
    }

    /** Signum's `FirstChild<T>` / `LastChild<T>`. */
    async function firstChild<T extends TreeEntity>(type: Type<T>, parentRoute: string): Promise<string | null> {
        const routes = await siblingRoutes(type, parentRoute);
        return routes.length === 0 ? null : routes[0];
    }

    async function lastChild<T extends TreeEntity>(type: Type<T>, parentRoute: string): Promise<string | null> {
        const routes = await siblingRoutes(type, parentRoute);
        return routes.length === 0 ? null : routes[routes.length - 1];
    }

    /** Signum's `Next<T>` / `Previous<T>` — the sibling immediately after / before `route`. */
    async function nextSibling<T extends TreeEntity>(type: Type<T>, route: string): Promise<string | null> {
        const routes = await siblingRoutes(type, TreeRoute.getAncestor(route, 1));
        const i = routes.indexOf(route);
        return i < 0 || i + 1 >= routes.length ? null : routes[i + 1];
    }

    async function previousSibling<T extends TreeEntity>(type: Type<T>, route: string): Promise<string | null> {
        const routes = await siblingRoutes(type, TreeRoute.getAncestor(route, 1));
        const i = routes.indexOf(route);
        return i <= 0 ? null : routes[i - 1];
    }

    // ---- positioning -----------------------------------------------------------------------------

    /** Signum's `CalculateRoute` — where a NEW node goes, from its `parentOrSibling` + `isSibling`. */
    export async function calculateRoute<T extends TreeEntity>(type: Type<T>, node: T): Promise<string> {
        if (!node.isSibling) {
            const parentRoute = node.parentOrSibling == null
                ? TreeRoute.getRoot()
                : await routeOf(type, node.parentOrSibling);

            return TreeRoute.getDescendant(parentRoute, await lastChild(type, parentRoute), null);
        }

        const siblingRoute = await routeOf(type, node.parentOrSibling!);
        const parentRoute = TreeRoute.getAncestor(siblingRoute, 1);

        return TreeRoute.getDescendant(parentRoute, siblingRoute, await nextSibling(type, siblingRoute));
    }

    /** Signum's `lite.InDB(a => a.Route)`. */
    async function routeOf<T extends TreeEntity>(type: Type<T>, lite: Lite<TreeEntity>): Promise<string> {
        const id = lite.id;
        const route = await ExecutionMode.global(() => table(type).filter(a => a.id == id).map(a => a.route).firstOrNull());
        if (route == null)
            throw new Error(`'${lite.toString()}' no longer exists`);
        return route;
    }

    /** Signum's `GetNewPosition` — where a MOVE or COPY puts the node. */
    export async function getNewPosition<T extends TreeEntity>(type: Type<T>, model: MoveTreeModel, node: T): Promise<string> {
        const newParentRoute = model.newParent == null
            ? TreeRoute.getRoot()
            : await routeOf(type, model.newParent);

        if (TreeRoute.isDescendantOf(newParentRoute, node.route))
            throw new Error(TreeMessage.ImpossibleToMove0InsideOf1.niceToString(
                node.toString(), model.newParent?.toString() ?? ""));

        if (model.insertPlace === InsertPlace.FirstNode)
            return TreeRoute.getDescendant(newParentRoute, null, await firstChild(type, newParentRoute));

        if (model.insertPlace === InsertPlace.LastNode)
            return TreeRoute.getDescendant(newParentRoute, await lastChild(type, newParentRoute), null);

        const siblingRoute = await routeOf(type, model.sibling!);

        if (!TreeRoute.isDescendantOf(siblingRoute, newParentRoute)
            || TreeRoute.getLevel(siblingRoute) !== TreeRoute.getLevel(newParentRoute) + 1
            || siblingRoute === node.route)
            throw new Error(TreeMessage.ImpossibleToMove01Of2.niceToString(
                node.toString(), placeNiceName(model.insertPlace), model.newParent?.toString() ?? ""));

        if (model.insertPlace === InsertPlace.After)
            return TreeRoute.getDescendant(newParentRoute, siblingRoute, await nextSibling(type, siblingRoute));

        return TreeRoute.getDescendant(newParentRoute, await previousSibling(type, siblingRoute), siblingRoute);
    }

    function placeNiceName(place: InsertPlace): string {
        return Enum.niceName(InsertPlace, place);
    }

    // ---- save / move -----------------------------------------------------------------------------

    /** Signum's `FixName` — persist, then recompute the full name of this node and (if it moved) its subtree. */
    export async function fixName<T extends TreeEntity>(type: Type<T>, node: T): Promise<void> {
        const wasNew = node.isNew;

        if (wasNew) {
            node.fullName = node.name;
            await Saver.save([node]);
            await calculateFullName(type, node);
            await Saver.save([node]);
            return;
        }

        await Saver.save([node]);
        await calculateFullName(type, node);
        await Saver.save([node]);

        const descendants = (await descendantsQuery(type, node).toArray() as T[])
            .filter(d => d.route !== node.route);

        for (const d of descendants) {
            await calculateFullName(type, d);
            await Saver.save([d]);
        }
    }

    /** Signum's `FixRouteAndNames` — reposition the node AND carry its whole subtree with it. */
    export async function fixRouteAndNames<T extends TreeEntity>(type: Type<T>, node: T, model: MoveTreeModel): Promise<void> {
        const subtree = (await descendantsQuery(type, node).toArray() as T[])
            .filter(d => d.route !== node.route);

        const oldRoute = node.route;

        setRoute(node, await getNewPosition(type, model, node));

        await Saver.save([node]);
        await calculateFullName(type, node);
        await Saver.save([node]);

        for (const d of subtree) {
            setRoute(d, TreeRoute.getReparentedValue(d.route, oldRoute, node.route));
            await Saver.save([d]);
            await calculateFullName(type, d);
            await Saver.save([d]);
        }
    }

    /**
     * Signum's `Route` SETTER: writing the route also writes `parentRoute` and `level`. altea has no
     * property setters on entities, so it is this one function — and every writer must use it, which is
     * why nothing in this file assigns `.route` directly.
     */
    export function setRoute(node: TreeEntity, route: string): void {
        node.route = route;
        node.parentRoute = TreeRoute.getAncestor(route, 1);
        node.level = toInt(TreeRoute.getLevel(route));
    }

    /** Signum's `TreeEntitySave`. */
    export async function treeEntitySave<T extends TreeEntity>(type: Type<T>, node: T): Promise<void> {
        if (node.isNew)
            setRoute(node, await calculateRoute(type, node));

        await fixName(type, node);
    }

    /** Signum's `TreeEntityMove`. */
    export async function treeEntityMove<T extends TreeEntity>(type: Type<T>, node: T, model: MoveTreeModel): Promise<void> {
        await fixRouteAndNames(type, node, model);
        await Saver.save([node]);
    }

    /** Signum's `RemoveDescendants` — deleting a node deletes its whole subtree. */
    export async function removeDescendants<T extends TreeEntity>(type: Type<T>, node: T): Promise<void> {
        const route = node.route;
        await table(type).filter(d => d.route.startsWith(route)).executeDelete();
    }

    // ---- the seven operations --------------------------------------------------------------------

    /** Signum's `RegisterOperations<T>`. */
    export function registerOperations<T extends TreeEntity>(
        type: Type<T>,
        copy?: (node: T, model: MoveTreeModel) => T,
    ): void {
        // The standalone root: `type` is only known at RUNTIME (an app declares its own tree type),
        // so there is no `sb.include(…)` here to hang the operations off.
        const op = operations(type);

        op.withConstruct(TreeOperation.CreateRoot, {
            construct: () => {
                const node = newNode(type);
                node.parentOrSibling = null;
                node.level = toInt(1);
                node.isSibling = false;
                return node;
            },
        });

        op.withConstructFrom(type, TreeOperation.CreateChild, {
            construct: parent => {
                const node = newNode(type);
                node.parentOrSibling = parent.toLite();
                node.level = toInt(Number(parent.level ?? 0) + 1);
                node.isSibling = false;
                return node;
            },
        });

        op.withConstructFrom(type, TreeOperation.CreateNextSibling, {
            construct: sibling => {
                const node = newNode(type);
                node.parentOrSibling = sibling.toLite();
                node.level = sibling.level;
                node.isSibling = true;
                return node;
            },
        });

        op.withExecute(TreeOperation.Save, {
            canBeNew: true,
            canBeModified: true,
            execute: async node => { await treeEntitySave(type, node); },
        });

        op.withExecute(TreeOperation.Move, {
            execute: async (node, args) => {
                await treeEntityMove(type, node, args[0] as MoveTreeModel);
            },
        });

        op.withDelete(TreeOperation.Delete, {
            delete: async node => { await removeDescendants(type, node); },
        });

        if (copy != null) {
            op.withConstructFrom(type, TreeOperation.Copy, {
                construct: async (source, args) => {
                    const model = args[0] as MoveTreeModel;
                    const newRoute = await getNewPosition(type, model, source);

                    const subtree = (await descendantsQuery(type, source).toArray() as T[])
                        .sort((a, b) => TreeRoute.compare(a.route, b.route));

                    const copies = subtree.map(old => {
                        const clone = copy(old, model);
                        clone.parentOrSibling = model.newParent;
                        setRoute(clone, TreeRoute.getReparentedValue(old.route, source.route, newRoute));
                        clone.fullName = clone.name;
                        return clone;
                    });

                    await Saver.save(copies as unknown as Entity[]);

                    for (const c of copies) {
                        await calculateFullName(type, c);
                        await Saver.save([c]);
                    }

                    return copies[0];
                },
            });
        }    }

    function newNode<T extends TreeEntity>(type: Type<T>): T {
        // `create` (not `new`): a mixin's field initializers only run in the factory — see
        // OperationLogic's note on the operation log.
        return (type as unknown as { create(init?: object): T }).create({});
    }
}

/**
 * The four navigations {@link TreeLogic.registerExpressions} stamps onto each concrete tree type.
 * Declared as an interface rather than on TreeEntity for the reason `IOperationLogged` gives: the members
 * exist only on the types that were registered — and they are QUERY-ONLY (see the header), which a member
 * declared on the entity would not advertise.
 */
export interface ITreeNavigations extends TreeEntity {
    treeChildren?(): unknown;
    treeParent?(): unknown;
    treeDescendants?(): unknown;
    treeAscendants?(): unknown;
}
