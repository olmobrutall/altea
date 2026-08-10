import { TypeConditionSymbol, TypeAllowed } from "../data/Rules";
import { MergeStrategy } from "../data/Role";
import { WithConditions, ConditionRule } from "./WithConditions";

// Port of Signum's TypeConditionMerger (Rules/TypeCache.cs) — the cross-role merge of WithConditions<A>.
// When a role inherits from several roles, their per-resource condition rules (over possibly DIFFERENT
// symbol sets) cannot be merged rule-by-rule, so the algorithm expands each role's WithConditions into a
// 2^n truth-table (one cell per combination of the union symbols' truth values), merges cell-by-cell
// (Union → max, Intersection → min), then reconstructs a MINIMAL set of rules from the merged matrix. This
// is exactly Signum's GetMatrix / GetRules / MergeBaseImplementations.
//
// GENERIC over the allowed enum A: Type / Operation / Property authorization all merge the same way — the
// only per-dimension inputs are the numeric enum ordering (higher = more access, so Union = numeric max /
// Intersection = numeric min) and the `top` value (the Intersection identity + max short-circuit). None is
// always 0 (the Union identity + min short-circuit). Signum's own maxTypeAllowed used `item > result`, i.e.
// numeric comparison — so the same core serves TypeAllowed's packed DB/UI value AND the single-level
// Operation/Property enums.
//
// altea divergence: Signum's `TypeAllowedPrima` / `WithPrima` / `IsSimplest` tagging (which preserved
// conditions that PROPERTY or OPERATION auth might override) was for the case where those dimensions coerce
// the type's conditions; altea evaluates property/operation coercion per-instance at the SCALAR level
// instead, so full minimization here is correct for every dimension.

const NONE = 0; // the Union identity + min short-circuit — None is 0 in every allowed enum.

// Per-cell merge with the short-circuit at the extreme (Signum's Max*/Min*Allowed).
function maxAllowed<A extends number>(collection: A[], top: A): A {
    let result = NONE as A;
    for (const item of collection) {
        if (item > result) result = item;
        if (result === top) return result;
    }
    return result;
}
function minAllowed<A extends number>(collection: A[], top: A): A {
    let result = top;
    for (const item of collection) {
        if (item < result) result = item;
        if (result === (NONE as A)) return result;
    }
    return result;
}

// The per-symbol bit assignment: the distinct union of every base rule's symbols, ordered by key.
interface Condition { tc: TypeConditionSymbol; bit: number; }

// Generic cross-role merge of WithConditions<A>. `top` is the enum's maximum (Write / Allow) — the
// Intersection identity. Used by the Type, Operation and Property dimensions.
export function mergeWithConditions<A extends number>(strategy: MergeStrategy, baseRules: WithConditions<A>[], top: A): WithConditions<A> {
    if (baseRules.length === 1)
        return baseRules[0];

    // Union's identity is None (a base of "nothing" doesn't raise the max); Intersection's is `top`.
    const minIdentity = (strategy === MergeStrategy.Union ? NONE : top) as A;
    const merge = strategy === MergeStrategy.Union
        ? (c: A[]): A => maxAllowed(c, top)
        : (c: A[]): A => minAllowed(c, top);

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
    const merged: A[] = [];
    for (let i = 0; i < numCells; i++)
        merged.push(merge(matrixes.map(m => m[i])));

    return getRules(merged, numCells, conditions);
}

// Signum's TypeConditionMerger for WithConditions<TypeAllowed> — the type dimension's wrapper.
export function mergeTypeConditions(strategy: MergeStrategy, baseRules: WithConditions<TypeAllowed>[]): WithConditions<TypeAllowed> {
    return mergeWithConditions(strategy, baseRules, TypeAllowed.Write);
}

// Signum's GetMatrix: every cell starts at the fallback; each rule (in FORWARD order) overwrites every
// cell whose index has ALL of the rule's condition bits set. Later rules overwrite earlier ones — the
// bitmask mirror of the reverse-scan (last-match-wins) instance evaluator.
function getMatrix<A>(tac: WithConditions<A>, numCells: number, bitOf: Map<string, number>): A[] {
    const matrix: A[] = new Array(numCells).fill(tac.fallback);
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
function getRules<A>(matrix: A[], numCells: number, conditions: Condition[]): WithConditions<A> {
    const array: (A | null)[] = matrix.slice();
    const conditionRules: ConditionRule<A>[] = [];
    let available = conditions.slice();

    // A non-null cell under `mask` must all agree; null cells (already covered) are "don't care".
    const onlyOneValue = (mask: number): A | null => {
        let current: A | null = null;
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
                return new WithConditions<A>(ta, conditionRules.slice().reverse());
        }

        let emitted = false;

        // 1 condition.
        for (const c of available) {
            const ta = onlyOneValue(c.bit);
            if (ta != null) {
                conditionRules.push(new ConditionRule<A>([c.tc], ta));
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
                    conditionRules.push(new ConditionRule<A>(tcs, ta));
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
