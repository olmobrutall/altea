import type { RoleGraph } from "./AuthLogic";
import { MergeStrategy } from "../data/Role";

// A role's computed allowed value for a resource, cached PER (role, resource) — Signum's
// AuthCache.RoleAllowedCache (a DefaultDictionary computed once per role, reset on invalidation). The
// value is: the role's EXPLICIT rule if any; otherwise the MERGE of its direct parents' allowed values
// (per the role's merge strategy); a root role with no rule gets `getDefault(role)`.
export type ComputedCache<A> = Map<string, Map<string | number, A>>; // roleKey -> (resourceKey -> A)

// Fold (and memoise into `cache`) a resource's allowed value across the role graph. SYNCHRONOUS: the whole
// database — the raw rules AND the role graph — is already loaded (each authorization RulesCache resolves
// both in its factory), so there is nothing to await here. `cache` is the caller's PERSISTENT per-dimension
// memo (living on the RulesCache instance, so it is dropped when that snapshot is invalidated), letting each
// (role, resource) be folded across the graph ONCE and reused instead of re-walking on every lookup.
export function computeAllowed<A>(
    roleKey: string,
    resourceKey: string | number,
    rules: Map<string, Map<string | number, A>>,
    merge: (strategy: MergeStrategy, baseValues: A[]) => A,
    getDefault: (roleKey: string) => A,
    cache: ComputedCache<A>,
    graph: RoleGraph,
): A {
    const rec = (rk: string): A => {
        let inner = cache.get(rk);
        if (inner == null) cache.set(rk, inner = new Map());
        const cached = inner.get(resourceKey);
        if (cached !== undefined) return cached;

        const explicit = rules.get(rk)?.get(resourceKey);
        let result: A;
        if (explicit !== undefined) {
            result = explicit;
        } else {
            const parents = graph.relatedTo(rk);
            result = parents.size === 0
                ? getDefault(rk)
                : merge(graph.getMergeStrategy(rk), [...parents].map(rec));
        }
        inner.set(resourceKey, result);
        return result;
    };
    return rec(roleKey);
}
