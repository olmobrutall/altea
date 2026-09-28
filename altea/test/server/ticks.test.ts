import "@altea/altea/server/context.node";
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { Temporal } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { clockTicks } from "@altea/altea/server/save";
import { denormalizeBigInt } from "@altea/altea/server/normalizeScalar";
import { ConstantExpression } from "@altea/altea/server/linq/expressions";
import { LiteralType } from "@altea/altea/server/runtimeTypes";

// The concurrency stamp is a bigint: in legacy mode it is Signum's `Clock.Now.Ticks`, a .NET tick count past
// 2^53, so it must be generated, read back and bound without rounding.
describe("version stamp", () => {

    test("clockTicks is .NET DateTime.Ticks of the clock's wall time", () => {
        using _ = Clock.overrideNow(Temporal.PlainDateTime.from("2000-01-01T00:00:00"));
        assert.equal(clockTicks(), 630822816000000000n);   // new DateTime(2000, 1, 1).Ticks
    });

    test("a Signum-sized value reads back exactly", () => {
        assert.equal(denormalizeBigInt("639259539010097581"), 639259539010097581n);
        assert.equal(denormalizeBigInt(639259539010097581n), 639259539010097581n);
        assert.equal(denormalizeBigInt(42), 42n);
        assert.equal(denormalizeBigInt(null), null);
    });

    test("a bigint constant is typed bigint (bound as CAST(… AS bigint))", () =>
        assert.equal(new ConstantExpression(639259539010097581n).type, LiteralType.bigint));
});
