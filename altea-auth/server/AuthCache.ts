import { AuthLogic } from "./AuthLogic";
import { MergeStrategy } from "../data/Role";

// A role's computed allowed value for a resource, cached PER (role, resource) — Signum's
// AuthCache.RoleAllowedCache (a GlobalLazy DefaultDictionary computed once per role, reset on
// invalidation). The value is: the role's EXPLICIT rule if any; otherwise the MERGE of its direct
// parents' allowed values (per the role's merge strategy); a root role with no rule gets
// `getDefault(role)`. (Equivalent to Signum's precomputed DefaultDictionary: an unoverridden key bubbles
// up to the parents' defaults, and merge-of-parent-defaults equals the role's own default by construction.)
export type ComputedCache<A> = Map<string, Map<string | number, A>>; // roleKey -> (resourceKey -> A)

// Compute (and memoize into `cache`) the allowed value. CRUCIAL for performance: `cache` is the CALLER's
// PERSISTENT cache (one per authorization dimension, cleared on invalidate()) — NOT a per-call map — so
// each (role, resource) is folded across the role graph ONCE and reused, instead of re-walking the whole
// graph on every lookup (getTypeRulePack iterates every type, the row filter runs per query, …).
export async function computeAllowed<A>(
    roleKey: string,
    resourceKey: string | number,
    rules: Map<string, Map<string | number, A>>,
    merge: (strategy: MergeStrategy, baseValues: A[]) => A,
    getDefault: (roleKey: string) => Promise<A>,
    cache: ComputedCache<A>,
): Promise<A> {
    const rec = async (rk: string): Promise<A> => {
        let inner = cache.get(rk);
        if (inner == null) cache.set(rk, inner = new Map());
        const cached = inner.get(resourceKey);
        if (cached !== undefined) return cached;

        const explicit = rules.get(rk)?.get(resourceKey);
        let result: A;
        if (explicit !== undefined) {
            result = explicit;
        } else {
            const parents = await AuthLogic.relatedTo(rk);
            if (parents.size === 0)
                result = await getDefault(rk);
            else
                result = merge(await AuthLogic.getMergeStrategy(rk), await Promise.all([...parents].map(rec)));
        }
        inner.set(resourceKey, result);
        return result;
    };
    return rec(roleKey);
}

// SYNCHRONOUS twin of computeAllowed for the serialization-auth path — identical folding, but the role
// graph comes from an IMMUTABLE captured snapshot (SerializationAuthContext): `relatedTo` / `mergeStrategy`
// read that snapshot's graph, so a concurrent invalidation can't affect the in-flight walk. Shares the same
// persistent `cache`, so results match the async path exactly.
export function computeAllowedSync<A>(
    roleKey: string,
    resourceKey: string | number,
    rules: Map<string, Map<string | number, A>>,
    merge: (strategy: MergeStrategy, baseValues: A[]) => A,
    getDefaultSync: (roleKey: string) => A,
    cache: ComputedCache<A>,
    relatedTo: (roleKey: string) => Set<string>,
    mergeStrategy: (roleKey: string) => MergeStrategy,
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
            const parents = relatedTo(rk);
            if (parents.size === 0)
                result = getDefaultSync(rk);
            else
                result = merge(mergeStrategy(rk), [...parents].map(rec));
        }
        inner.set(resourceKey, result);
        return result;
    };
    return rec(roleKey);
}
