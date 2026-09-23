import { describe, test } from "vitest";
import assert from "node:assert/strict";
import type { TypeConditionSymbol } from "@altea/altea-auth/data/Rules";
import { WithConditions, ConditionRule, adjustShape } from "@altea/altea-auth/server/WithConditions";

// Signum's AdjustShape: a property allowance re-expressed in its TYPE's condition sets. Two allowances are
// only comparable in the same shape — saving a property pack compares each edited value with its inherited
// base, and a base padded with the type's sets never equalled an edited value whose rows equal to the
// fallback had been pruned, so every property of a conditioned type was stored as overridden.

const sym = (key: string): TypeConditionSymbol => ({ key }) as TypeConditionSymbol;
const A = sym("Cond.A"), B = sym("Cond.B");
const wc = (fallback: number, rules: [TypeConditionSymbol[], number][] = []): WithConditions<number> =>
    new WithConditions<number>(fallback, rules.map(([tcs, v]) => new ConditionRule<number>(tcs, v)));

describe("adjustShape", () => {

    test("pads a plain value with the shape's sets, each at the fallback", () => {
        const shaped = adjustShape(wc(1), wc(2, [[[A], 2]]));
        assert.ok(shaped.equals(wc(1, [[[A], 1]])));
    });

    test("so an untouched value equals a base padded with the type's sets", () => {
        const shape = wc(1, [[[A], 1]]);
        assert.ok(!wc(1).equals(shape), "compared as they come, they differ — the bug");
        assert.ok(adjustShape(wc(1), shape).equals(adjustShape(shape, shape)));
    });

    test("a rule for a subset of the shape's set gives it its value; the last such rule wins", () => {
        const shape = wc(0, [[[A, B], 0]]);
        const shaped = adjustShape(wc(0, [[[A], 1], [[B], 2]]), shape);
        assert.ok(shaped.equals(wc(0, [[[A, B], 2]])));
    });

    test("a value already in the shape is returned as is", () => {
        const v = wc(1, [[[A], 2]]);
        assert.equal(adjustShape(v, wc(0, [[[A], 0]])), v);
    });
});
