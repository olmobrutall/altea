import type { Lite } from "@altea/altea/data/lite";
import type { TypeConditionSymbol } from "../../data/Rules";

// Shared helpers for the Signum-style type-condition "slice" editor used by the property + operation rule
// packs. A rule's allowance is a WithConditionsModel (a fallback + per-condition-set overrides); the editor
// shows ONE slice at a time — either the Fallback or one configured type-condition SET — and binds each
// row to that slice. Picking the slice replaces Signum's per-row condition sub-rows.

/** The selected slice: a type-condition SET, or `undefined` for the Fallback. */
export type Slice = Lite<TypeConditionSymbol>[] | undefined;

const setKey = (tcs: readonly Lite<TypeConditionSymbol>[]): string => tcs.map(l => String(l.id)).sort().join("&");

/** Stable key for a slice (empty string = Fallback) — used as the `<select>` option value. */
export const sliceKey = (s: Slice): string => s == null ? "" : setKey(s);

interface WithConditionsLike<A, CR> { fallback: A; conditionRules: CR[]; }

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
        get: () => find()?.allowed ?? wc.fallback,
        set: v => { const cr = find(); if (cr) cr.allowed = v; else wc.conditionRules.push(makeCR([...slice], v)); },
    };
}

/** Short display for a type-condition symbol Lite (the member after the dot, e.g. "Public"). */
export const shortCondition = (l: Lite<TypeConditionSymbol>): string => {
    const s = l.toString();
    const dot = s.indexOf(".");
    return dot >= 0 ? s.substring(dot + 1) : s;
};
