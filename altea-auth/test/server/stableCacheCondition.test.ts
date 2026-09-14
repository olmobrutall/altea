import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { toInt } from "@altea/altea/data/basics";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { ResetLazy } from "@altea/altea/server/resetLazy";
import { ArrayType, LiteralType } from "@altea/altea/server/runtimeTypes";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import { SampleEntity, SampleTypeCondition } from "../data/sample";

// A type condition whose SQL half reads an application CACHE through `.$v`.
//
// `.$v` is query-only — in memory the accessor always throws — so such a condition cannot be the in-memory
// evaluator as well, which is exactly what `registerCompile` makes it. It is registered with `register` plus
// an ASYNC twin that awaits the same cache, and that twin is what answers for an entity no query reached (a
// fresh instance on the save path has no id to match on). `inTypeCondition` stays synchronous because the
// twin's answer is pre-computed and cached, exactly as a DB-only condition's is.
//
// No database: the twin path never queries, which is the point — registering it is what takes the SQL batch
// out of play for these entities. The SQL half of the same condition is covered by dbTypeCondition.test.ts.
describe("a type condition whose SQL half reads a cache", () => {

    // A cache of ids, declared query-readable (the `runtimeType` is what makes `.$v` over it legal).
    const vipIds = new ResetLazy<PrimaryKey[]>(async () => [toInt(1), toInt(2)],
        () => new ArrayType(LiteralType.number));

    test("registerCompile refuses a predicate that reads .$v", () => {
        assert.throws(
            () => TypeConditionLogic.registerCompile(SampleEntity, SampleTypeCondition.HighValue,
                s => vipIds.value().$v.includes(s.id), true),
            /cannot be registered with registerCompile/);
    });

    test("an async twin answers, and is filled and cached like a DB-only condition", async () => {
        TypeConditionLogic.register(SampleEntity, SampleTypeCondition.HighValue,
            s => vipIds.value().$v.includes(s.id),
            async s => (await vipIds.value()).some(id => String(id) === String(s.id)),
            true);

        // Not synchronously answerable — so the retrieve-time binding / fill is what serves `inTypeCondition`.
        assert.equal(TypeConditionLogic.hasSyncInMemoryCondition(SampleEntity, SampleTypeCondition.HighValue), false);
        assert.equal(TypeConditionLogic.getInMemoryCondition(SampleEntity, SampleTypeCondition.HighValue), undefined);

        const vip = SampleEntity.create({ name: "vip", secret: "s", value: toInt(5) });
        const other = SampleEntity.create({ name: "other", secret: "s", value: toInt(5) });
        vip.id = toInt(1);
        other.id = toInt(9);

        assert.throws(() => TypeConditionLogic.inTypeCondition(vip, SampleTypeCondition.HighValue),
            /fillTypeConditions/);

        // The twin is PREFERRED over this condition's own SQL predicate, so no query runs (there is no
        // database here at all) — and an entity the SQL batch could not reach is still answered.
        await TypeConditionLogic.fillTypeConditions([vip, other], [SampleTypeCondition.HighValue]);

        assert.equal(TypeConditionLogic.inTypeCondition(vip, SampleTypeCondition.HighValue), true);
        assert.equal(TypeConditionLogic.inTypeCondition(other, SampleTypeCondition.HighValue), false);
    });

    // A twin that hands back a promise without being declared `async` would otherwise be TRUTHY at every
    // call — every row silently satisfying the condition. It is named instead.
    test("a promise-returning twin that is not declared async is named", () => {
        TypeConditionLogic.register(SampleEntity, SampleTypeCondition.HighValue,
            s => s.value > 0,
            s => Promise.resolve(s.value > 0) as unknown as boolean,
            true);

        const e = SampleEntity.create({ name: "sneaky", secret: "s", value: toInt(5) });

        assert.throws(() => TypeConditionLogic.inTypeCondition(e, SampleTypeCondition.HighValue),
            /returned a promise but is not declared/);
    });
});
