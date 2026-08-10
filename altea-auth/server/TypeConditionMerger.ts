import { TypeConditionSymbol, TypeAllowed, TypeAllowedBasic } from "../data/Rules";
import { MergeStrategy } from "../data/Role";
import { WithConditions, ConditionRule } from "./WithConditions";

// Port of Signum's TypeConditionMerger (Rules/TypeCache.cs) — the cross-role merge of
// WithConditions<TypeAllowed>. When a role inherits from several roles, their per-type condition rules
// (over possibly DIFFERENT symbol sets) cannot be merged rule-by-rule, so the algorithm expands each
// role's WithConditions into a 2^n truth-table (one cell per combination of the union symbols' truth
// values), merges cell-by-cell (Union → max, Intersection → min), then reconstructs a MINIMAL set of
// rules from the merged matrix. This is exactly Signum's GetMatrix / GetRules / MergeBaseImplementations.
//
// altea divergence: Signum's `TypeAllowedPrima` / `WithPrima` / `IsSimplest` tagging (which preserves
// conditions that PROPERTY or OPERATION auth might override) is DROPPED — altea has not ported
// property/operation authorization, so there are never such overrides, which is exactly Signum's
// behaviour with `hasPrima == false`: full minimization. It returns with the property/operation engines.

// Signum's MaxTypeAllowed / MinTypeAllowed — the per-cell merge, with the short-circuit at the extreme.
function maxTypeAllowed(collection: TypeAllowed[]): TypeAllowed {
    let result = TypeAllowed.None;
    for (const item of collection) {
        if (item > result) result = item;
        if (result === TypeAllowed.Write) return result;
    }
    return result;
}
function minTypeAllowed(collection: TypeAllowed[]): TypeAllowed {
    let result = TypeAllowed.Write;
    for (const item of collection) {
        if (item < result) result = item;
        if (result === TypeAllowed.None) return result;
    }
    return result;
}

// The per-symbol bit assignment: the distinct union of every base rule's symbols, ordered by key.
interface Condition { tc: TypeConditionSymbol; bit: number; }

export function mergeTypeConditions(strategy: MergeStrategy, baseRules: WithConditions<TypeAllowed>[]): WithConditions<TypeAllowed> {
    if (baseRules.length === 1)
        return baseRules[0];

    // Union's identity is None (a base of "nothing" doesn't raise the max); Intersection's is Write.
    const minIdentity = strategy === MergeStrategy.Union ? TypeAllowed.None : TypeAllowed.Write;
    const merge = strategy === MergeStrategy.Union ? maxTypeAllowed : minTypeAllowed;

    // If all but one base is the trivial identity, that one wins outright (Signum's onlyNotMin).
    const notMin = baseRules.filter(ta => !(ta.conditionRules.length === 0 && ta.fallback === minIdentity));
    if (notMin.length === 1)
        return notMin[0];

    if (baseRules.every(tac => tac.conditionRules.length === 0))
        return WithConditions.simple(merge(baseRules.map(t => t.fallback)));

    const symbols = [...new Map(baseRules.flatMap(ta => ta.conditionRules).flatMap(r => r.typeConditions).map(tc => [tc.key, tc])).values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (symbols.length > 31)
        throw new Error("You can not merge more than 31 type conditions");

    const conditions: Condition[] = symbols.map((tc, i) => ({ tc, bit: 1 << i }));
    const bitOf = new Map(conditions.map(c => [c.tc.key, c.bit]));
    const numCells = 1 << conditions.length;

    const matrixes = baseRules.map(tac => getMatrix(tac, numCells, bitOf));
    const merged: TypeAllowed[] = [];
    for (let i = 0; i < numCells; i++)
        merged.push(merge(matrixes.map(m => m[i])));

    return getRules(merged, numCells, conditions);
}

// Signum's GetMatrix: every cell starts at the fallback; each rule (in FORWARD order) overwrites every
// cell whose index has ALL of the rule's condition bits set. Later rules overwrite earlier ones — the
// bitmask mirror of the reverse-scan (last-match-wins) instance evaluator.
function getMatrix(tac: WithConditions<TypeAllowed>, numCells: number, bitOf: Map<string, number>): TypeAllowed[] {
    const matrix: TypeAllowed[] = new Array(numCells).fill(tac.fallback);
    for (const rule of tac.conditionRules) {
        let mask = 0;
        for (const tc of rule.typeConditions) mask |= bitOf.get(tc.key)!;
        for (let i = 0; i < numCells; i++)
            if ((i & mask) === mask) matrix[i] = rule.allowed;
    }
    return matrix;
}

// Signum's GetRules: reconstruct a minimal WithConditions from the merged matrix. Emit rules in ascending
// specificity (0 conditions = fallback exit; then 1; then >=2), clearing covered cells as we go, and
// return the rules REVERSED so the most specific are last (matching the reverse-scan evaluator).
function getRules(matrix: TypeAllowed[], numCells: number, conditions: Condition[]): WithConditions<TypeAllowed> {
    const array: (TypeAllowed | null)[] = matrix.slice();
    const conditionRules: ConditionRule<TypeAllowed>[] = [];
    let available = conditions.slice();

    // A non-null cell under `mask` must all agree; null cells (already covered) are "don't care".
    const onlyOneValue = (mask: number): TypeAllowed | null => {
        let current: TypeAllowed | null = null;
        for (let i = 0; i < numCells; i++) {
            if ((i & mask) === mask) {
                const v = array[i];
                if (v != null) {
                    if (current == null) current = v;
                    else if (current !== v) return null;
                }
            }
        }
        return current;
    };
    const clearArray = (mask: number): void => {
        for (let i = 0; i < numCells; i++)
            if ((i & mask) === mask) array[i] = null;
    };
    function* masksOf(numConditions: number, avail: Condition[], skip: number): Generator<number> {
        if (numConditions === 1) {
            for (let i = skip; i < avail.length; i++) yield avail[i].bit;
        } else {
            for (let i = skip; i < avail.length; i++) {
                const val = avail[i].bit;
                for (const item of masksOf(numConditions - 1, avail, skip + 1)) yield item | val;
            }
        }
    }

    let guard = 0;
    while (true) {
        if (++guard > numCells * conditions.length + numCells + 2)
            throw new Error("getRules: failed to converge (non-minimizable matrix)");

        { // 0 conditions — the only exit: everything left agrees on one value.
            const ta = onlyOneValue(0);
            if (ta != null)
                return new WithConditions<TypeAllowed>(ta, conditionRules.slice().reverse());
        }

        let emitted = false;

        // 1 condition.
        for (const c of available) {
            const ta = onlyOneValue(c.bit);
            if (ta != null) {
                conditionRules.push(new ConditionRule<TypeAllowed>([c.tc], ta));
                available = available.filter(x => x !== c);
                clearArray(c.bit);
                emitted = true;
                break;
            }
        }
        if (emitted) continue;

        // >= 2 conditions.
        for (let numConditions = 2; numConditions <= available.length && !emitted; numConditions++) {
            for (const mask of masksOf(numConditions, available, 0)) {
                const ta = onlyOneValue(mask);
                if (ta != null) {
                    const tcs = available.filter(c => (c.bit & mask) === c.bit).map(c => c.tc);
                    conditionRules.push(new ConditionRule<TypeAllowed>(tcs, ta));
                    clearArray(mask);
                    emitted = true;
                    break;
                }
            }
        }
        if (!emitted)
            throw new Error("getRules: no emittable rule for the residual matrix");
    }
}
