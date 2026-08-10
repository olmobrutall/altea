import { TypeConditionSymbol, TypeAllowed, TypeAllowedBasic, typeAllowedDB, typeAllowedUI } from "../data/Rules";

// Port of Signum's immutable runtime types WithConditions<A> / ConditionRule<A> (Rules/RulePackModels.cs).
// A role's access to a type is not a single value but a `WithConditions<TypeAllowed>`: a `fallback` plus
// an ORDERED list of condition rules, each a SET of TypeConditionSymbols (AND-ed) → an allowed value.
// Evaluation is LAST-MATCH-WINS (iterate rules in reverse). These are value types (structural equality
// over the condition sets), used for the cross-role merge cache and the in-memory instance evaluator.
//
// altea divergences: Signum's Min*/Max* are C# extension methods keyed on TypeAllowed's DB/UI split — here
// they are free functions at the bottom. Signum interns instances (ConcurrentDictionary); altea skips the
// intern cache (equals/hash are still defined for the merge cache). `A` is a numeric enum, compared with
// `===` (its runtime value is the number), so no per-A equality is needed.

function hashCombine(hash: number, value: number): number {
    return (Math.imul(hash, 31) + value) | 0;
}
function hashString(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return h;
}

// Signum's ConditionRule<A> (a readonly struct with a FrozenSet<TypeConditionSymbol>). The symbol set is
// stored deduped + sorted by key so two rules with the same symbols in any order compare/hash equal.
export class ConditionRule<A> {
    readonly typeConditions: readonly TypeConditionSymbol[];
    readonly hash: number;

    constructor(typeConditions: Iterable<TypeConditionSymbol>, readonly allowed: A) {
        const byKey = new Map<string, TypeConditionSymbol>();
        for (const tc of typeConditions) byKey.set(tc.key, tc);
        this.typeConditions = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        let h = 17;
        for (const c of this.typeConditions) h = hashCombine(h, hashString(c.key));
        this.hash = hashCombine(h, allowed as unknown as number);
    }

    setEquals(other: ConditionRule<A>): boolean {
        if (this.typeConditions.length !== other.typeConditions.length) return false;
        const keys = new Set(other.typeConditions.map(c => c.key));
        return this.typeConditions.every(c => keys.has(c.key));
    }
    equals(other: ConditionRule<A>): boolean {
        return this.allowed === other.allowed && this.setEquals(other);
    }
    toString(): string {
        return this.typeConditions.map(a => a.key.split(".").pop() ?? a.key).join(" & ") + " => " + String(this.allowed);
    }
}

export class WithConditions<A> {
    readonly hash: number;

    constructor(readonly fallback: A, readonly conditionRules: readonly ConditionRule<A>[]) {
        let h = 17;
        for (const r of conditionRules) h = hashCombine(h, r.hash);
        this.hash = hashCombine(h, fallback as unknown as number);
    }

    static simple<A>(value: A): WithConditions<A> {
        return new WithConditions<A>(value, []);
    }

    equals(other: WithConditions<A>): boolean {
        if (this.fallback !== other.fallback) return false;
        if (this.conditionRules.length !== other.conditionRules.length) return false;
        return this.conditionRules.every((r, i) => r.equals(other.conditionRules[i]));
    }

    mapWithConditions<T>(func: (a: A) => T): WithConditions<T> {
        return new WithConditions<T>(func(this.fallback), this.conditionRules.map(cr => new ConditionRule<T>(cr.typeConditions, func(cr.allowed))));
    }

    toString(): string {
        return this.conditionRules.length === 0
            ? String(this.fallback)
            : `${String(this.fallback)} | ${this.conditionRules.map(r => r.toString()).join(" | ")}`;
    }
}

// ---- Min/Max bounds (Signum's TypeAllowAndConditionsExtensions) --------------------------------------
// The cheap short-circuit bounds the instance evaluator uses: scan the fallback + ALL condition rules
// (ignoring which conditions apply) and take the numeric min/max of the requested (DB or UI) level.

export function maxUI(taac: WithConditions<TypeAllowed>): TypeAllowedBasic {
    return Math.max(typeAllowedUI(taac.fallback), ...taac.conditionRules.map(a => typeAllowedUI(a.allowed))) as TypeAllowedBasic;
}
export function minUI(taac: WithConditions<TypeAllowed>): TypeAllowedBasic {
    return Math.min(typeAllowedUI(taac.fallback), ...taac.conditionRules.map(a => typeAllowedUI(a.allowed))) as TypeAllowedBasic;
}
export function maxDB(taac: WithConditions<TypeAllowed>): TypeAllowedBasic {
    return Math.max(typeAllowedDB(taac.fallback), ...taac.conditionRules.map(a => typeAllowedDB(a.allowed))) as TypeAllowedBasic;
}
export function minDB(taac: WithConditions<TypeAllowed>): TypeAllowedBasic {
    return Math.min(typeAllowedDB(taac.fallback), ...taac.conditionRules.map(a => typeAllowedDB(a.allowed))) as TypeAllowedBasic;
}
export function maxBound(taac: WithConditions<TypeAllowed>, userInterface: boolean): TypeAllowedBasic {
    return userInterface ? maxUI(taac) : maxDB(taac);
}
export function minBound(taac: WithConditions<TypeAllowed>, userInterface: boolean): TypeAllowedBasic {
    return userInterface ? minUI(taac) : minDB(taac);
}
