import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { CallExpression, ConstantExpression, type MethodExpander } from "@altea/altea/server/linq/expressions";
import { LiteralType } from "@altea/altea/server/runtimeTypes";

// Regression: a call rebuilt by a visitor (`updateCall`) keeps its @methodExpander. Losing it turned a
// nested `inCondition` — one condition expanding into another, whose receiver is replaced by the outer
// one's — into a call the nominator cannot translate.
describe("CallExpression.updateCall", () => {
    test("keeps the method expander", () => {
        const expander: MethodExpander = () => new ConstantExpression(true, LiteralType.boolean);
        const call = new CallExpression(new ConstantExpression(() => true), [new ConstantExpression(1, LiteralType.number)], LiteralType.boolean);
        call.methodExpander = expander;

        const updated = call.updateCall(call.func, [new ConstantExpression(2, LiteralType.number)]);
        assert.notEqual(updated, call);
        assert.equal(updated.methodExpander, expander);
    });
});
