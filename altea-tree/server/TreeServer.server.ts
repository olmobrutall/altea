import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { table } from "@altea/altea/server/table";
import { Schema } from "@altea/altea/server/schema";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { parseQueryRequest } from "@altea/altea/server/queryServer";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { cleanTypeName } from "@altea/altea/data/registration";
import { toInt, type int } from "@altea/altea/data/basics";
import type {
    ColumnRequest, FilterRequest, QueryRequest as WireQueryRequest,
} from "@altea/altea/data/dynamicQuery/queryRequest";
import {
    TreeEntity,
    type FindNodesRequest, type FindNodesResponse, type GetNodeRequest, type TreeNode,
} from "../data/Tree";
import { TreeRoute } from "./TreeRoute.server";

// Port of Signum.Tree's TreeController.cs — the three routes the tree viewer calls.
//
// ================================================================================================
// DIVERGENCE: the tree STRUCTURE is loaded directly; only the user's COLUMNS go through the
// dynamic-query pipeline.
// ================================================================================================
//
// Signum runs FOUR dynamic queries per refresh, each with every requested column REBASED onto a
// collection-element token — `Entity.Ascendants.Element.TreeInfo`, `Entity.Descendants.Element.<col>` — so
// that one query returns a matching row together with its ancestors. Making a user's column token
// ("Customer.Name") sit under such a prefix takes ~120 lines of `RebaseToken` / `GetParts`, all of it
// reading `QueryDescription.Columns` and each column's `PropertyRoutes`.
//
// altea has no QueryDescription (see CLAUDE.md), so that machinery has no counterpart — and it is not
// needed: the two things Signum was buying with it are cheap here.
//
//   • "the rows matching the user's filters"  → ONE ordinary QueryRequest, exactly as a search page runs,
//     with the user's own columns untouched. So filters, columns and cell formatters behave identically to
//     the search control, which is the point of the feature.
//   • "…and their ancestors / children / descendants" → the ROUTE already answers this without a query
//     language: an ancestor's route is a prefix of the node's (computable in memory), a child's
//     `parentRoute` equals the parent's route, a descendant's route starts with it.
//
// The result is the same forest with the same column values, from 2–4 small queries instead of four
// token-rebased ones, and no dependence on a metadata DTO altea does not have.
export namespace TreeServer {

    export function start(ws: WebBuilder): void {

        // Signum's `findLiteLikeByName/{typeName}/{subString}/{count}`. ALTEA: the search text is a QUERY
        // parameter — a node name may contain a slash, which a path segment cannot carry.
        ws.get("/api/tree/findLiteLikeByName/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<Lite<TreeEntity>[]>() },
            async (req, res) => {
                const { typeName } = (req as unknown as { params: { typeName: string } }).params;
                const type = treeType(typeName);

                const subString = (req.query["q"] as string | undefined) ?? "";
                const count = Number(req.query["count"] ?? 5);

                return res.jsonTyped(await findLiteLikeByName(type, subString, count));
            });

        ws.post("/api/tree/findNodes/:typeName",
            { params: CustomType<{ typeName: string }>(), req: CustomType<FindNodesRequest>(), res: CustomType<FindNodesResponse>() },
            async (req, res) => {
                const { typeName } = (req as unknown as { params: { typeName: string } }).params;
                return res.jsonTyped(await findNodes(treeType(typeName), typeName, await req.jsonTyped()));
            });

        ws.post("/api/tree/getNode/:typeName",
            { params: CustomType<{ typeName: string }>(), req: CustomType<GetNodeRequest>(), res: CustomType<TreeNode>() },
            async (req, res) => {
                const { typeName } = (req as unknown as { params: { typeName: string } }).params;
                const request = await req.jsonTyped();
                return res.jsonTyped(await getNode(treeType(typeName), typeName, request));
            });
    }

    /** The concrete tree type behind a clean name, refusing anything that is not one. */
    function treeType(typeName: string): Type<TreeEntity> {
        const type = Entity.resolveType(typeName);
        if (!(type === TreeEntity || type.prototype instanceof TreeEntity))
            throw new Error(`'${typeName}' is not a tree type`);
        return type as unknown as Type<TreeEntity>;
    }

    // ---- autocomplete ----------------------------------------------------------------------------

    /** Signum's `FindTreeLiteLikeByNameGeneric` — every word of the pattern must appear in the name. */
    export async function findLiteLikeByName(
        type: Type<TreeEntity>,
        subString: string,
        count: number,
    ): Promise<Lite<TreeEntity>[]> {
        const parts = subString.trim().split(" ").filter(p => p.length > 0);

        // Signum's `ContainsAll` in one predicate; altea filters per word (the provider ANDs them) and
        // orders by name LENGTH, so the closest match comes first.
        let query = table(type);
        for (const part of parts)
            query = query.filter(a => a.name.includes(part));

        const nodes = await query.orderBy(a => a.name.length).top(count).toArray() as TreeEntity[];

        return nodes.map(n => n.toLite());
    }

    // ---- one node --------------------------------------------------------------------------------

    /** Signum's `GetNode` — the node a freshly created entity became, with its column values. */
    export async function getNode(
        type: Type<TreeEntity>,
        typeName: string,
        request: GetNodeRequest,
    ): Promise<TreeNode> {
        const node = await table(type).singleOrNull(a => a.id == request.lite.id) as TreeEntity | null;
        if (node == null)
            throw new Error(`'${request.lite.toString()}' no longer exists`);

        const columns = request.columns as ColumnRequest[];
        const values = await columnValues(typeName, columns, [node]);
        const childCounts = await childrenCounts(type, [node.route]);

        return toTreeNode(node, values.get(String(node.id)) ?? [], childCounts, []);
    }

    // ---- the forest ------------------------------------------------------------------------------

    export async function findNodes(
        type: Type<TreeEntity>,
        typeName: string,
        request: FindNodesRequest,
    ): Promise<FindNodesResponse> {

        const userFilters = (request.userFilters ?? []) as FilterRequest[];
        const frozenFilters = (request.frozenFilters ?? []) as FilterRequest[];
        const columns = (request.columns ?? []) as ColumnRequest[];

        // 1. the rows the user asked for — an ordinary query request, columns untouched.
        const matched = await queryNodes(type, typeName, [...userFilters, ...frozenFilters]);

        // 2. their ancestors, so every match is reachable from a root.
        const ancestorRoutes = new Set<string>();
        for (const node of matched)
            for (let r = TreeRoute.getAncestor(node.route, 1); !TreeRoute.isRoot(r); r = TreeRoute.getAncestor(r, 1))
                ancestorRoutes.add(r);

        // 3. the children of every expanded node — narrowed by the FROZEN filters only, which is Signum's
        //    rule too: expanding a node shows its real children, not only those matching the search.
        const expandedRoutes = await routesOf(type, request.expandedNodes ?? []);

        const byRoute = new Map<string, TreeEntity>();
        for (const node of matched)
            byRoute.set(node.route, node);

        for (const node of await nodesByRoute(type, [...ancestorRoutes]))
            byRoute.set(node.route, node);

        if (expandedRoutes.length > 0)
            for (const node of await queryNodes(type, typeName, frozenFilters, { parentRouteIn: expandedRoutes }))
                byRoute.set(node.route, node);

        // 4. "expand all" — every descendant of what matched.
        if (request.loadDescendants && matched.length > 0)
            for (const node of await queryNodes(type, typeName, frozenFilters, { descendantOf: matched.map(m => m.route) }))
                byRoute.set(node.route, node);

        const all = [...byRoute.values()].sort((a, b) => TreeRoute.compare(a.route, b.route));

        const values = await columnValues(typeName, columns, all);
        const childCounts = await childrenCounts(type, all.map(a => a.route));

        return {
            columns: columns.map(c => c.token),
            nodes: buildForest(all, values, childCounts),
        };
    }

    /**
     * The nodes matching `filters`, optionally narrowed to the children of / descendants of some routes.
     * The narrowing is added as a wire FILTER so it goes through the same pipeline (and the same row-level
     * authorization) as the user's own filters.
     */
    async function queryNodes(
        type: Type<TreeEntity>,
        typeName: string,
        filters: FilterRequest[],
        narrow?: { parentRouteIn?: string[]; descendantOf?: string[] },
    ): Promise<TreeEntity[]> {

        const all: FilterRequest[] = [...filters];

        if (narrow?.parentRouteIn != undefined)
            all.push({ token: "parentRoute", operation: "IsIn", value: narrow.parentRouteIn } as FilterRequest);

        if (narrow?.descendantOf != undefined)
            // One OR group of prefix tests — `StartsWith` is what altea lowers to `LIKE 'x%'`.
            all.push({
                groupOperation: "Or",
                filters: narrow.descendantOf.map(r => ({ token: "route", operation: "StartsWith", value: r })),
            } as unknown as FilterRequest);

        const wire: WireQueryRequest = {
            queryKey: typeName,
            groupResults: false,
            filters: all,
            orders: [],
            // The ENTITY column alone: the tree's own fields come from the rows we then load, and the
            // user's columns are fetched separately (see columnValues) so a column token can never change
            // the SHAPE of this query. ALTEA: the entity column's token is the EMPTY string — altea's
            // tokens are rootless, so the query root has key "" where Signum's is "Entity".
            columns: [{ token: "", displayName: "Entity" }],
            pagination: { mode: "All" },
        } as WireQueryRequest;

        const rt = await QueryLogic.queries.executeQueryAsync(parseQueryRequest(wire));

        const lites = rt.rows.map(r => r.entity).filter(e => e != undefined) as Lite<TreeEntity>[];
        if (lites.length === 0)
            return [];

        const ids = lites.map(l => l.id);
        return await table(type).filter(a => ids.includes(a.id)).toArray() as TreeEntity[];
    }

    /** The rows at exactly these routes. */
    async function nodesByRoute(type: Type<TreeEntity>, routes: string[]): Promise<TreeEntity[]> {
        if (routes.length === 0)
            return [];
        return await table(type).filter(a => routes.includes(a.route)).toArray() as TreeEntity[];
    }

    async function routesOf(type: Type<TreeEntity>, lites: Lite<TreeEntity>[]): Promise<string[]> {
        if (lites.length === 0)
            return [];
        const ids = lites.map(l => l.id);
        return await table(type).filter(a => ids.includes(a.id)).map(a => a.route).toArray();
    }

    /**
     * How many children each of these nodes has — what the viewer's expand/collapse icon reads (a node
     * with children but none loaded is "Collapsed"; with SOME loaded, "Filtered").
     *
     * One grouped query, Signum's `t.Children().Count()` inside its TreeInfo projection.
     */
    async function childrenCounts(type: Type<TreeEntity>, routes: string[]): Promise<Map<string, int>> {
        if (routes.length === 0)
            return new Map();

        const rows = await table(type)
            .filter(c => routes.includes(c.parentRoute))
            .groupBy(c => c.parentRoute)
            .map(g => ({ parentRoute: g.key, count: g.elements.length }))
            .toArray();

        return new Map(rows.map(r => [r.parentRoute, toInt(r.count)]));
    }

    /**
     * The user's extra COLUMN values, keyed by entity id — one ordinary query request filtered to the
     * nodes we are about to render. Separate from the structural queries so the columns are exactly the
     * ones a search page would produce (same tokens, same order, same server-only handling).
     */
    async function columnValues(
        typeName: string,
        columns: ColumnRequest[],
        nodes: TreeEntity[],
    ): Promise<Map<string, unknown[]>> {
        if (columns.length === 0 || nodes.length === 0)
            return new Map();

        const ids = nodes.map(n => n.id);

        const wire: WireQueryRequest = {
            queryKey: typeName,
            groupResults: false,
            filters: [{ token: "id", operation: "IsIn", value: ids } as FilterRequest],
            orders: [],
            columns: [{ token: "", displayName: "Entity" }, ...columns],
            pagination: { mode: "All" },
        } as WireQueryRequest;

        const rt = await QueryLogic.queries.executeQueryAsync(parseQueryRequest(wire));

        const result = new Map<string, unknown[]>();
        // The server ResultTable already SPLITS the entity column out of `columns` (see its constructor),
        // so the row's display values are exactly the user's columns — no leading slice.
        for (const row of rt.rows) {
            const lite = row.entity as Lite<TreeEntity> | undefined;
            if (lite == undefined)
                continue;
            result.set(String(lite.id), rt.columns.map((_c, i) => row.value(i)));
        }
        return result;
    }

    /** Assemble the flat, route-ordered list into a forest (Signum's `ToTreeNodes`). */
    function buildForest(
        all: TreeEntity[],
        values: Map<string, unknown[]>,
        childCounts: Map<string, int>,
    ): TreeNode[] {

        const nodeByRoute = new Map<string, TreeNode>();
        const roots: TreeNode[] = [];

        for (const entity of all) {
            const node = toTreeNode(entity, values.get(String(entity.id)) ?? [], childCounts, []);
            nodeByRoute.set(entity.route, node);

            // `all` is route-ordered, so every ancestor present has already been built.
            const parent = nodeByRoute.get(entity.parentRoute);
            if (parent != undefined)
                parent.loadedChildren.push(node);
            else
                roots.push(node);
        }

        return roots;
    }

    function toTreeNode(
        entity: TreeEntity,
        values: unknown[],
        childCounts: Map<string, int>,
        loadedChildren: TreeNode[],
    ): TreeNode {
        return {
            values,
            lite: entity.toLite(),
            name: entity.name,
            fullName: entity.fullName,
            // ALTEA: always false — DisabledMixin is not ported (see server/TreeLogic).
            disabled: false,
            childrenCount: childCounts.get(entity.route) ?? toInt(0),
            level: entity.level,
            loadedChildren,
            // The server does not know what the user expanded; `TreeClient.fixState` fills this.
            nodeState: "Leaf",
        };
    }

    /** Every mapped tree type — the omnibox generator and the client's type list both ask. */
    export function allTreeTypes(): Type<TreeEntity>[] {
        return [...Schema.current.tables.keys()]
            .filter(t => t !== TreeEntity && t.prototype instanceof TreeEntity) as Type<TreeEntity>[];
    }

    /** The clean name of a tree type, for a URL. */
    export function cleanNameOf(type: Type<TreeEntity>): string {
        return cleanTypeName(type);
    }
}
