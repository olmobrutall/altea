import type { Lite } from "@altea/altea/data/lite";
import type { TypeConditionSymbol } from "../../data/Rules";

// Shared helpers for the type-condition "slice" editor the property and operation rule packs use — see
// port/Auth.md.
//
// A rule's allowance is a WithConditionsModel (a fallback + per-condition-set overrides); the editor shows
// ONE slice at a time — either the Fallback or one configured type-condition SET — and binds every row to
// that slice. Picking a slice is what replaces Signum's per-row condition sub-rows, which do not scale to
// a table with one row per property route.

/** The selected slice: a type-condition SET, or `undefined` for the Fallback. */
export type Slice = Lite<TypeConditionSymbol>[] | undefined;

const setKey = (tcs: readonly Lite<TypeConditionSymbol>[]): string => tcs.map(l => String(l.id)).sort().join("&");

/** Stable key for a slice (empty string = Fallback) — used as the `<select>` option value. */
export const sliceKey = (s: Slice): string => s == null ? "" : setKey(s);

interface WithConditionsLike<A, CR> { fallback: A; conditionRules: CR[]; }

/** The value of a WithConditionsModel for a SLICE: the matching conditionRule's `allowed`, else the fallback. */
export function sliceValue<A>(wc: WithConditionsLike<A, { typeConditions: Lite<TypeConditionSymbol>[]; allowed: A }>, slice: Slice): A {
    if (slice == null)
        return wc.fallback;
    const key = setKey(slice);
    return wc.conditionRules.find(cr => setKey(cr.typeConditions) === key)?.allowed ?? wc.fallback;
}

// A get/set binding onto the value of a WithConditionsModel FOR A SLICE:
//   • Fallback slice  → the model's `fallback`.
//   • a condition set → the matching conditionRule's `allowed`; reading a set with no rule yields the
//     fallback (the inherited default), and WRITING one creates the conditionRule on demand (`makeCR`).
// `get` never mutates (safe to bind onto allowedBase for the "overridden" comparison); only `set` does.
export function sliceBinding<A, CR extends { typeConditions: Lite<TypeConditionSymbol>[]; allowed: A }>(
    wc: WithConditionsLike<A, CR>,
    slice: Slice,
    makeCR: (typeConditions: Lite<TypeConditionSymbol>[], allowed: A) => CR,
): { get: () => A; set: (v: A) => void } {
    if (slice == null)
        return { get: () => wc.fallback, set: v => { wc.fallback = v; } };
    const key = setKey(slice);
    const find = (): CR | undefined => wc.conditionRules.find(cr => setKey(cr.typeConditions) === key);
    return {
        get: () => sliceValue(wc, slice),
        set: v => { const cr = find(); if (cr) cr.allowed = v; else wc.conditionRules.push(makeCR([...slice], v)); },
    };
}

/** Short display for a type-condition symbol Lite (the member after the dot, e.g. "Public"). */
export const shortCondition = (l: Lite<TypeConditionSymbol>): string => {
    const s = l.toString();
    const dot = s.indexOf(".");
    return dot >= 0 ? s.substring(dot + 1) : s;
};
