import { describe, test, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { table } from "@altea/altea/server/table";
import { toInt } from "@altea/altea/data/basics";
import "@altea/altea/data/globals";
import "@altea/altea-auth/server/TypeConditionLogic";
import { SampleEntity, SamplePanelEntity, SampleTypeCondition } from "../data/sample";
import { start, hasDb } from "./setup";

// Signum's `entity.InCondition(typeCondition)`: a condition written in terms of ANOTHER type's condition.
// Inside a query the call expands to the condition registered for the receiver's type; in memory it is
// TypeConditionLogic.inTypeCondition.
describe.skipIf(hasDb ? false : "set ALTEA_AUTH_TEST_DB (and run gen) to enable")("entity.inCondition", () => {

    beforeAll(() => start());

    async function seed(): Promise<void> {
        await SampleEntity.create({
            name: "inc-secret", secret: "s", confidential: true, value: toInt(3),
            panels: [SamplePanelEntity.create({ title: "inc-a", secret: "s", widgets: [] })],
        }).save();
        await SampleEntity.create({
            name: "inc-open", secret: "s", confidential: false, value: toInt(0),
            panels: [SamplePanelEntity.create({ title: "inc-b", secret: "s", widgets: [] })],
        }).save();
    }

    test("on the receiver itself — a compiled and a DB-only condition", async () => {
        await Transaction.noCommit(async () => {
            await seed();

            const confidential = table(SampleEntity)
                .filter(s => s.name.startsWith("inc-") && s.inCondition(SampleTypeCondition.Confidential))
                .map(s => s.name);
            assert.match(confidential.queryTextForDebug(), /confidential/i);
            assert.deepEqual(await confidential.toArray(), ["inc-secret"]);

            const highValue = table(SampleEntity)
                .filter(s => s.name.startsWith("inc-") && s.inCondition(SampleTypeCondition.HighValue))
                .map(s => s.name);
            assert.deepEqual(await highValue.toArray(), ["inc-secret"]);
        });
    });

    test("through a navigation — the condition of the type reached", async () => {
        await Transaction.noCommit(async () => {
            await seed();

            const titles = await table(SampleEntity)
                .filter(s => s.name.startsWith("inc-"))
                .flatMap(s => s.panels)
                .filter(p => p.sample.entity.inCondition(SampleTypeCondition.Public))
                .map(p => p.title)
                .toArray();
            assert.deepEqual(titles, ["inc-b"]);
        });
    });

    test("in memory it is the condition's answer for the instance", () => {
        const secret = SampleEntity.create({ name: "x", secret: "s", confidential: true, value: toInt(0) });
        assert.equal(secret.inCondition(SampleTypeCondition.Confidential), true);
        assert.equal(secret.inCondition(SampleTypeCondition.Public), false);
    });
});
