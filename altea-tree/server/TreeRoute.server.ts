// The hierarchyid arithmetic, in TypeScript over Signum's own textual form.
//
// A route is a slash-DELIMITED, slash-TERMINATED list of labels: `"/"` is the root, `"/1/"` its first
// child, `"/1/3/"` that child's third child. A label is a dot-separated list of integers — `3` normally,
// `3.1` for a node inserted between siblings `3` and `4`. This is byte-for-byte what
// `SqlHierarchyId.ToString()` emits, so a database migrated from Signum needs no conversion.
//
// Why the dotted label exists: `GetDescendant(a, b)` must always be able to produce a position strictly
// between two siblings, however adjacent they already are. Between `3` and `4` there is no integer, so the
// label grows a component: `3.1`. Between `3` and `3.1` → `3.0.1`. This is hierarchyid's own scheme, and it
// is what makes the order DENSE — a tree can be rearranged indefinitely without ever renumbering siblings.
//
// Every function here is pure and total: no database, no dialect.
export namespace TreeRoute {

    export const root = "/";

    /** Signum's `SqlHierarchyId.GetRoot()`. */
    export function getRoot(): string {
        return root;
    }

    export function isRoot(route: string): boolean {
        return route === root;
    }

    /** The labels of a route, root first. `"/1/3.1/"` → `[[1], [3, 1]]`. */
    export function labels(route: string): number[][] {
        assertRoute(route);
        return route.split("/").filter(s => s.length > 0).map(parseLabel);
    }

    function parseLabel(label: string): number[] {
        const parts = label.split(".").map(s => {
            const n = Number(s);
            if (!Number.isInteger(n))
                throw new Error(`'${label}' is not a valid tree route label`);
            return n;
        });
        if (parts.length === 0)
            throw new Error(`'${label}' is not a valid tree route label`);
        return parts;
    }

    function formatLabel(label: number[]): string {
        return label.join(".");
    }

    function fromLabels(labelList: number[][]): string {
        return labelList.length === 0 ? root : "/" + labelList.map(formatLabel).join("/") + "/";
    }

    function assertRoute(route: string): void {
        if (!route.startsWith("/") || !route.endsWith("/"))
            throw new Error(`'${route}' is not a valid tree route (it must start and end with '/')`);
    }

    /** Signum's `GetLevel()` — 0 for the root, 1 for a root NODE, and so on. */
    export function getLevel(route: string): number {
        return labels(route).length;
    }

    /**
     * Signum's `GetAncestor(n)`. `getAncestor("/1/3/", 1)` → `"/1/"`. Asking for more ancestors than the
     * route has levels yields the root, matching hierarchyid.
     */
    export function getAncestor(route: string, n: number): string {
        const l = labels(route);
        return fromLabels(l.slice(0, Math.max(0, l.length - n)));
    }

    /** Signum's `IsDescendantOf` — INCLUSIVE, as hierarchyid's is (a node is its own descendant). */
    export function isDescendantOf(route: string, ancestor: string): boolean {
        assertRoute(route);
        assertRoute(ancestor);
        return route.startsWith(ancestor);
    }

    /**
     * Signum's `GetReparentedValue(oldRoot, newRoot)` — move a whole subtree by swapping its prefix.
     * Throws when `route` is not under `oldRoot`, exactly as hierarchyid does.
     */
    export function getReparentedValue(route: string, oldRoot: string, newRoot: string): string {
        if (!isDescendantOf(route, oldRoot))
            throw new Error(`'${route}' is not a descendant of '${oldRoot}'`);
        return newRoot + route.substring(oldRoot.length);
    }

    /**
     * Signum's `GetDescendant(child1, child2)`: a NEW child of `parent`, positioned after `child1` and
     * before `child2`. Either may be null ("no bound on that side").
     *
     * The three cases hierarchyid has:
     *   (null, null)   → the first child, label `1`
     *   (a, null)      → after `a`: its last component + 1
     *   (null, b)      → before `b`: `b`'s last component - 1 when there is room, else a deeper label
     *   (a, b)         → strictly between: an integer if one fits, else `a` with a component appended
     */
    export function getDescendant(parent: string, child1: string | null, child2: string | null): string {
        assertRoute(parent);

        const a = child1 == null ? null : lastLabelOfChild(parent, child1);
        const b = child2 == null ? null : lastLabelOfChild(parent, child2);

        return parent + formatLabel(between(a, b)) + "/";
    }

    /** The final label of `child`, which must be a DIRECT child of `parent`. */
    function lastLabelOfChild(parent: string, child: string): number[] {
        if (!isDescendantOf(child, parent))
            throw new Error(`'${child}' is not a descendant of '${parent}'`);

        const childLabels = labels(child);
        const parentLabels = labels(parent);

        if (childLabels.length !== parentLabels.length + 1)
            throw new Error(`'${child}' is not a DIRECT child of '${parent}'`);

        return childLabels[childLabels.length - 1];
    }

    /**
     * A label strictly between `a` and `b` (either may be null). This is the whole density argument, so
     * it is worth stating the invariant: the result is always > a and < b under {@link compareLabel}, for
     * ANY a < b — including adjacent integers and already-dotted labels.
     */
    export function between(a: number[] | null, b: number[] | null): number[] {
        if (a == null && b == null)
            return [1];

        if (b == null)
            return incrementLast(a!);

        if (a == null) {
            // Before `b`: one less, when that leaves room. `[1]` has no integer before it that a tree may
            // use (hierarchyid allows 0 and negatives; keeping to 1.. keeps every route human-readable),
            // so instead go DEEPER: `[1]` → `[0, 1]`, which sorts before `[1]`.
            const last = b[b.length - 1];
            if (last > 1)
                return [...b.slice(0, -1), last - 1];
            return [...b.slice(0, -1), last - 1, 1];
        }

        if (compareLabel(a, b) >= 0)
            throw new Error(`Cannot position a node between '${formatLabel(a)}' and '${formatLabel(b)}': they are not in order`);

        // Walk the shared prefix; the first component where they differ decides.
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const ai = i < a.length ? a[i] : Number.NEGATIVE_INFINITY;
            const bi = i < b.length ? b[i] : Number.NEGATIVE_INFINITY;

            if (ai === bi)
                continue;

            // Room for a whole number between them at this component.
            if (bi - ai > 1)
                return [...a.slice(0, i), ai + 1];

            // No room: keep `a`'s components up to here and go one level deeper. `a` may already have
            // more components (a = [3,1], b = [4] → [3,2]); when it does not, append (a = [3], b = [4] →
            // [3,1]).
            if (i + 1 < a.length)
                return incrementLast(a);

            return [...a, 1];
        }

        // Same components: `a` is a prefix of `b` or they are equal — the ordering check above rules
        // equality out, so `a` is shorter and the new label goes after it and before `b`'s next component.
        return [...a, 1];
    }

    function incrementLast(label: number[]): number[] {
        return [...label.slice(0, -1), label[label.length - 1] + 1];
    }

    /** Numeric, component-wise label order. A shorter label sorts BEFORE a longer one sharing its prefix. */
    export function compareLabel(a: number[], b: number[]): number {
        for (let i = 0; i < Math.min(a.length, b.length); i++)
            if (a[i] !== b[i])
                return a[i] - b[i];
        return a.length - b.length;
    }

    /**
     * Depth-first route order — hierarchyid's own, and the reason routes are NOT sorted in SQL: a
     * lexicographic string sort puts `/10/` before `/2/`, and a database collation may reorder
     * punctuation. Deterministic on every dialect.
     */
    export function compare(a: string, b: string): number {
        const la = labels(a);
        const lb = labels(b);

        for (let i = 0; i < Math.min(la.length, lb.length); i++) {
            const c = compareLabel(la[i], lb[i]);
            if (c !== 0)
                return c;
        }

        return la.length - lb.length;
    }
}
