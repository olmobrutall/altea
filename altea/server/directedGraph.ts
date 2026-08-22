// Port of Signum's DirectedGraph<T> (Signum.Utilities/DataStructures/DirectedGraph.cs) —
// the subset the Saver/GraphExplorer actually use. Divergences from the C# (recorded per
// the port-faithfully rule):
//   - No IEqualityComparer: nodes are entity objects compared by reference, so a plain
//     Map/Set (identity) replaces the comparer-parameterised dictionary.
//   - C#'s overloaded `Add(from)` / `Add(from, to)` / `Add(from, elements)` split into
//     `add` (node only), `addEdge` (single) and `addEdges` (many) for TS clarity.
//   - Only the members reached from the save path are ported (add*, edges, relatedTo,
//     removeEdge(s), removeFullNode[Symetric], inverse, clone, sinks, feedbackEdgeSet).
//     Graphviz/DGML/ShortestPath/Dijkstra/BreadthExplore/CompilationOrderGroups etc. are
//     omitted until something needs them.

export interface Edge<T> {
    readonly from: T;
    readonly to: T;
}

export class DirectedGraph<T> {
    private readonly adjacency = new Map<T, Set<T>>();

    /** Ensures `from` is a node (no edges added). */
    add(from: T): void {
        this.getOrAdd(from);
    }

    /** Adds the edge `from → to`, creating either endpoint node if missing. */
    addEdge(from: T, to: T): void {
        this.getOrAdd(from).add(to);
        this.getOrAdd(to);
    }

    /** Adds edges `from → e` for every `e` in `elements`. */
    addEdges(from: T, elements: Iterable<T>): void {
        const f = this.getOrAdd(from);
        for (const item of elements) {
            this.getOrAdd(item);
            f.add(item);
        }
    }

    /**
     * Builds a graph from `nodes`, adding an edge `n → e` for every `e` in `expand(n)` (Signum's
     * DirectedGraph.Generate). Callers pass the full node set (e.g. all roles) and an expand that
     * returns already-included nodes (e.g. a role's direct `inheritsFrom`).
     */
    static generate<T>(nodes: Iterable<T>, expand: (node: T) => Iterable<T>): DirectedGraph<T> {
        const g = new DirectedGraph<T>();
        for (const n of nodes) {
            g.add(n);
            g.addEdges(n, expand(n));
        }
        return g;
    }

    /**
     * Topological order with dependencies FIRST: every node appears AFTER all nodes it points to
     * (its out-neighbours). For the role graph — where an edge is child → inherited-parent — this
     * yields parents before children (Signum's CompilationOrder), so a per-role fold can read its
     * parents' results. DFS post-order; assumes the graph is acyclic (callers check feedbackEdgeSet).
     */
    compilationOrder(): T[] {
        const result: T[] = [];
        const visited = new Set<T>();
        const visit = (node: T): void => {
            if (visited.has(node)) return;
            visited.add(node);
            for (const next of this.tryRelatedTo(node))
                visit(next);
            result.push(node);
        };
        for (const node of this.nodes)
            visit(node);
        return result;
    }

    private getOrAdd(node: T): Set<T> {
        let result = this.adjacency.get(node);
        if (result == null) {
            result = new Set<T>();
            this.adjacency.set(node, result);
        }
        return result;
    }

    get nodes(): Iterable<T> {
        return this.adjacency.keys();
    }

    get count(): number {
        return this.adjacency.size;
    }

    get isEmpty(): boolean {
        return this.adjacency.size === 0;
    }

    get edges(): Edge<T>[] {
        const result: Edge<T>[] = [];
        for (const [from, tos] of this.adjacency)
            for (const to of tos)
                result.push({ from, to });
        return result;
    }

    contains(node: T): boolean {
        return this.adjacency.has(node);
    }

    /** Out-neighbours of `node`. Throws if `node` is not in the graph (matches Signum). */
    relatedTo(node: T): Set<T> {
        const result = this.adjacency.get(node);
        if (result == null)
            throw new Error(`The node ${String(node)} is not in the graph`);
        return result;
    }

    tryRelatedTo(node: T): Set<T> {
        return this.adjacency.get(node) ?? new Set<T>();
    }

    /**
     * Every node reachable from `node` by following edges (Signum's `IndirectlyRelatedTo`), optionally
     * including `node` itself. A breadth-first walk with a visited set, so a cycle terminates. Used by
     * altea-cache: "load everything this type depends on" / "invalidate everything that depends on it".
     */
    indirectlyRelatedTo(node: T, includeInitialNode = false): Set<T> {
        const result = new Set<T>();
        const pending: T[] = [...this.tryRelatedTo(node)];
        while (pending.length > 0) {
            const current = pending.pop()!;
            if (result.has(current))
                continue;
            result.add(current);
            for (const next of this.tryRelatedTo(current))
                if (!result.has(next))
                    pending.push(next);
        }
        if (includeInitialNode)
            result.add(node);
        else
            result.delete(node);
        return result;
    }

    removeEdge(from: T, to: T): boolean {
        const set = this.adjacency.get(from);
        if (set == null) return false;
        return set.delete(to);
    }

    removeEdges(edges: Iterable<Edge<T>>): void {
        for (const e of edges)
            this.removeEdge(e.from, e.to);
    }

    /**
     * Removes `node` and every edge into it. `inverseRelated` must be the node's
     * in-neighbours (the caller passes them so this stays O(in-degree) rather than
     * rescanning the whole graph — Signum's "unsafer but faster" overload).
     */
    removeFullNode(node: T, inverseRelated: Iterable<T>): boolean {
        if (!this.adjacency.has(node)) return false;
        this.adjacency.delete(node);
        for (const n of inverseRelated)
            this.removeEdge(n, node);
        return true;
    }

    /** Removes `node` from both a graph and its inverse, keeping the pair consistent. */
    static removeFullNodeSymetric<T>(original: DirectedGraph<T>, inverse: DirectedGraph<T>, node: T): void {
        const from = inverse.relatedTo(node);
        const to = original.relatedTo(node);
        original.removeFullNode(node, from);
        inverse.removeFullNode(node, to);
    }

    inverse(): DirectedGraph<T> {
        const result = new DirectedGraph<T>();
        for (const item of this.nodes) {
            result.add(item);
            for (const related of this.relatedTo(item))
                result.addEdge(related, item);
        }
        return result;
    }

    unionWith(other: DirectedGraph<T>): void {
        for (const item of other.nodes)
            this.addEdges(item, other.relatedTo(item));
    }

    clone(): DirectedGraph<T> {
        const result = new DirectedGraph<T>();
        result.unionWith(this);
        return result;
    }

    /** Nodes with no outgoing edges. */
    sinks(): Set<T> {
        const result = new Set<T>();
        for (const [node, tos] of this.adjacency)
            if (tos.size === 0) result.add(node);
        return result;
    }

    /**
     * A small set of edges whose removal makes the graph acyclic (the "back edges" to
     * defer). Faithful port of Signum's linear-time Eades-Lin-Smyth greedy heuristic:
     * peel sinks to the tail and sources to the head; when neither exists a cycle is
     * present, so cut the most source-like or most sink-like vertex (by out-minus-in
     * degree) and record the cut edges. The returned graph's edges are the ones the
     * Saver removes to break cycles and whose `from` endpoints get a deferred FK update.
     */
    feedbackEdgeSet(): DirectedGraph<T> {
        const result = new DirectedGraph<T>();
        const clone = this.clone();
        const inv = this.inverse();

        while (clone.count > 0) {
            const sinks = clone.sinks();
            if (sinks.size !== 0) {
                for (const sink of sinks)
                    DirectedGraph.removeFullNodeSymetric(clone, inv, sink);
                continue;
            }

            const sources = inv.sinks();
            if (sources.size !== 0) {
                for (const source of sources)
                    DirectedGraph.removeFullNodeSymetric(clone, inv, source);
                continue;
            }

            const fanInOut = (n: T): number => clone.relatedTo(n).size - inv.relatedTo(n).size;
            const mm = clone.minMaxBy(fanInOut);

            if (fanInOut(mm.max) > -fanInOut(mm.min)) {
                // Most source-like vertex: cut its incoming edges (each `n → node`).
                // DIVERGENCE from Signum, which records `result.Add(node, n)` (reversed):
                // the callers remove these edges from the real graph and read `edge.from`
                // as the entity whose FK to defer, so they must be stored in their true
                // orientation `n → node`. Cutting a vertex's in-edges is a valid feedback
                // set regardless, so the choice of edges stays faithful.
                const node = mm.max;
                for (const n of inv.relatedTo(node))
                    result.addEdge(n, node);
                DirectedGraph.removeFullNodeSymetric(clone, inv, node);
            } else {
                // Most sink-like vertex: cut its outgoing edges (each `node → n`), already
                // in real orientation (matches Signum).
                const node = mm.min;
                for (const n of clone.relatedTo(node))
                    result.addEdge(node, n);
                DirectedGraph.removeFullNodeSymetric(clone, inv, node);
            }
        }

        return result;
    }

    private minMaxBy(selector: (node: T) => number): { min: T; max: T } {
        let min: T | undefined;
        let max: T | undefined;
        let minKey = Number.POSITIVE_INFINITY;
        let maxKey = Number.NEGATIVE_INFINITY;
        for (const node of this.nodes) {
            const key = selector(node);
            if (key <= minKey) { minKey = key; min = node; }
            if (key >= maxKey) { maxKey = key; max = node; }
        }
        if (min === undefined || max === undefined)
            throw new Error('minMaxBy on an empty graph');
        return { min, max };
    }
}

// ---- DirectedEdgedGraph ---------------------------------------------------------------------------------

/**
 * Port of Signum's `DirectedEdgedGraph<N, E>` (Signum.Utilities/DataStructures/DirectedEdgedGraph.cs) — a
 * directed graph whose EDGES carry a value. Added for @altea/altea-workflow's WorkflowNodeGraph, where the
 * value is the set of WorkflowConnections between two nodes (two nodes CAN be joined by more than one
 * connection, so the value is a collection and the pair (from,to) stays unique).
 *
 * Divergences from the C#:
 *   - C#'s IEqualityComparer becomes an optional `keyOf` projection. It is NOT decoration: Signum can key on
 *     the entity OBJECT because it wraps its graph build in `using (new EntityCache())`, an ambient identity
 *     map that makes every RetrieveAll hand back the same instance per row. altea has no such scope — each
 *     query gets its own Retriever — so the same row read by two queries is two objects, and an
 *     identity-keyed graph would silently never join them. Pass `e => e.toLite().key()` and the graph
 *     compares by row identity instead. Without `keyOf` the behaviour is C#'s (reference equality).
 *   - only the members the workflow graph reaches are ported (getOrCreate / relatedTo / edgesWithValue /
 *     inverse / depthExploreConnections). Graphviz/DGML and the shortest-path family are omitted.
 */
export interface EdgeWithValue<N, E> {
    readonly from: N;
    readonly to: N;
    readonly value: E;
}

export class DirectedEdgedGraph<N, E> {
    // key → (node, out-edges). The node is kept beside its edges so `nodes` / `edgesWithValue` still answer
    // the objects, not the keys.
    private readonly adjacency = new Map<unknown, { node: N; edges: Map<unknown, E> }>();

    constructor(private readonly createValue: () => E, private readonly keyOf: (node: N) => unknown = n => n) { }

    /** Ensures `node` is in the graph (no edges added). */
    add(node: N): void {
        this.getOrAddNode(node);
    }

    /** The edge value for `from → to`, creating the edge (and either endpoint) if missing. */
    getOrCreate(from: N, to: N): E {
        const entry = this.getOrAddNode(from);
        this.getOrAddNode(to);
        const toKey = this.keyOf(to);
        let value = entry.edges.get(toKey);
        if (value == null) {
            value = this.createValue();
            entry.edges.set(toKey, value);
        }
        return value;
    }

    get nodes(): N[] {
        return [...this.adjacency.values()].map(e => e.node);
    }

    get count(): number {
        return this.adjacency.size;
    }

    contains(node: N): boolean {
        return this.adjacency.has(this.keyOf(node));
    }

    /** Out-edges of `node` as a `to → value` map. Throws if `node` is not in the graph (matches Signum). */
    relatedTo(node: N): Map<N, E> {
        const entry = this.adjacency.get(this.keyOf(node));
        if (entry == null)
            throw new Error(`The node ${String(node)} is not in the graph`);
        return this.toNodeMap(entry.edges);
    }

    tryRelatedTo(node: N): Map<N, E> {
        const entry = this.adjacency.get(this.keyOf(node));
        return entry == null ? new Map<N, E>() : this.toNodeMap(entry.edges);
    }

    /** Every edge, with its value (Signum's `EdgesWithValue`). */
    get edgesWithValue(): EdgeWithValue<N, E>[] {
        const result: EdgeWithValue<N, E>[] = [];
        for (const entry of this.adjacency.values())
            for (const [toKey, value] of entry.edges)
                result.push({ from: entry.node, to: this.adjacency.get(toKey)!.node, value });
        return result;
    }

    inverse(): DirectedEdgedGraph<N, E> {
        const result = new DirectedEdgedGraph<N, E>(this.createValue, this.keyOf);
        for (const node of this.nodes)
            result.add(node);
        for (const entry of this.adjacency.values())
            for (const [toKey, value] of entry.edges)
                result.adjacency.get(toKey)!.edges.set(this.keyOf(entry.node), value);
        return result;
    }

    private toNodeMap(edges: Map<unknown, E>): Map<N, E> {
        const result = new Map<N, E>();
        for (const [toKey, value] of edges)
            result.set(this.adjacency.get(toKey)!.node, value);
        return result;
    }

    /**
     * Depth-first walk from `node`, calling `condition(prev, value, next)` on each edge; a falsy result
     * stops the walk from descending into `next`. Signum's `DepthExploreConnections` — used by the workflow
     * validator to collect the activities that precede a gateway.
     */
    depthExploreConnections(node: N, condition: (prev: N, value: E, next: N) => boolean): void {
        const visited = new Set<N>();
        const explore = (current: N): void => {
            if (visited.has(current))
                return;
            visited.add(current);
            for (const [next, value] of this.tryRelatedTo(current))
                if (condition(current, value, next))
                    explore(next);
        };
        explore(node);
    }

    private getOrAddNode(node: N): { node: N; edges: Map<unknown, E> } {
        const key = this.keyOf(node);
        let result = this.adjacency.get(key);
        if (result == null) {
            result = { node, edges: new Map<unknown, E>() };
            this.adjacency.set(key, result);
        }
        return result;
    }
}
