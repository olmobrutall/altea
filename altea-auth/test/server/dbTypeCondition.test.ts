import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { table } from "@altea/altea/server/table";
import { toInt } from "@altea/altea/data/basics";
import { TypeConditionLogic } from "@altea/altea-auth/server/TypeConditionLogic";
import { SampleEntity, SampleTypeCondition } from "../data/sample";
import { start, hasDb } from "./setup";

// Phase 4: DB-eval type conditions. SampleTypeCondition.HighValue is registered WITHOUT an in-memory
// predicate, so `inTypeCondition` can only answer after `fillTypeConditions` evaluates its `@quoted`
// predicate (`s.value > 0`) in SQL and caches the boolean per entity (Signum's _typeConditions).
describe("DB-eval type conditions (fillTypeConditions)", { skip: hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable" }, () => {

    before(() => start());

    test("a DB-only condition throws until filled, then reads the SQL-evaluated boolean per entity", async () => {
        await Transaction.noCommit(async () => {
            const hi = SampleEntity.create({ name: "hi-value", secret: "s", value: toInt(5) });
            const lo = SampleEntity.create({ name: "lo-value", secret: "s", value: toInt(0) });
            await hi.save();
            await lo.save();

            // Not yet filled → no in-memory predicate → throws.
            assert.throws(() => TypeConditionLogic.inTypeCondition(hi, SampleTypeCondition.HighValue), /fillTypeConditions/);

            await TypeConditionLogic.fillTypeConditions([hi, lo]);

            assert.equal(TypeConditionLogic.inTypeCondition(hi, SampleTypeCondition.HighValue), true, "value 5 > 0");
            assert.equal(TypeConditionLogic.inTypeCondition(lo, SampleTypeCondition.HighValue), false, "value 0 is not > 0");
            // The in-memory conditions still evaluate live (no fill needed).
            assert.equal(TypeConditionLogic.inTypeCondition(lo, SampleTypeCondition.Public), true, "confidential=false ⇒ Public");
        });
    });

    // Signum's _typeConditions RegisterBinding: retrieving an entity through the ORM folds each DB-only
    // condition into the SELECT and caches the boolean per row — so `inTypeCondition` works with NO explicit
    // `fillTypeConditions` call (0 extra queries). This is the additional-binding path.
    test("a retrieved entity is filled by the additional binding (no explicit fill)", async () => {
        await Transaction.noCommit(async () => {
            await SampleEntity.create({ name: "retr-hi", secret: "s", value: toInt(7) }).save();
            await SampleEntity.create({ name: "retr-lo", secret: "s", value: toInt(0) }).save();

            // Fresh retrieve → a new Retriever/identity map, so these are freshly-materialised instances the
            // additional binding stamped during projection (NOT the saved ones, whose cache the no-role save
            // path never fills).
            const rows = await table(SampleEntity).filter(s => s.name == "retr-hi" || s.name == "retr-lo").toArray() as SampleEntity[];
            const hi = rows.find(r => r.name === "retr-hi")!;
            const lo = rows.find(r => r.name === "retr-lo")!;

            assert.ok(TypeConditionLogic.typeConditionsOf(hi) != null, "cache populated on retrieve, no explicit fill");
            assert.equal(TypeConditionLogic.inTypeCondition(hi, SampleTypeCondition.HighValue), true, "value 7 > 0");
            assert.equal(TypeConditionLogic.inTypeCondition(lo, SampleTypeCondition.HighValue), false, "value 0 not > 0");
        });
    });
});
