import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { ConditionalExpression, ConstantExpression } from "@altea/altea/server/linq/expressions";
import { LiteralType } from "@altea/altea/server/runtimeTypes";

// What a ternary is WORTH, when one of its branches is `null`.
//
// `null` is a real RuntimeType here (`LiteralType.null`), so the obvious `whenTrue.type || whenFalse.type`
// took it: `x == null ? null : <number>` typed the whole conditional as `null`. Nothing reported that
// directly — `ExpressionContainer.register` refused the expression much later with "its tail method is
// neither @quoted nor @resultType (a forgotten @quoted?)", which names something the author did not do
// wrong. Three of the log tables' `Duration` helpers were written null-first and had to be spelled
// value-first before they would register at all.
//
// A null branch only says the value may be ABSENT; the other branch says what it is.
describe("ConditionalExpression type", () => {

    const nul = new ConstantExpression(null);
    const num = new ConstantExpression(1);
    const str = new ConstantExpression("x");
    const cond = new ConstantExpression(true);

    test("a NULL-first ternary takes the value branch's type", () => {
        assert.equal(new ConditionalExpression(cond, nul, num).type, LiteralType.number);
    });

    test("a value-first ternary is unchanged", () => {
        assert.equal(new ConditionalExpression(cond, num, nul).type, LiteralType.number);
    });

    test("neither branch null — the true branch still wins, as before", () => {
        assert.equal(new ConditionalExpression(cond, str, num).type, LiteralType.string);
    });

    test("both branches null — still null, so a genuinely untyped expression is still refused", () => {
        assert.equal(new ConditionalExpression(cond, nul, nul).type, LiteralType.null);
    });
});
