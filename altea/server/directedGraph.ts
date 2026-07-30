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
