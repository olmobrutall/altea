import "@altea/altea/server/context.node";
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck, checkFieldsAsync } from "@altea/altea/data/validation";
import { ValidationMessage, validate } from "@altea/altea/data/validators";
import { Entity } from "@altea/altea/data/entity";
import { entity, mixin } from "@altea/altea/data/decorators";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { CorruptMixin, Corruption } from "@altea/altea/data/corruptMixin";
import { Temporal } from "@altea/altea/data/basics";

// Signum's CorruptMixin + Corruption: a corrupt entity is checked tolerantly — a rule written
// `if (Corruption.strict())` stands down — and stops being corrupt once a save finds it valid. The shape is
// ReNew's UserTraining, whose start date is required only when strict.

@entity("Main", "Transactional")
@mixin(() => [CorruptMixin])
@validate<TrainingSample>((t, fi) => fi.name === "startDate" && Corruption.strict() && t.startDate == null
    ? ValidationMessage._0IsNotSet.niceToString(fi.niceToString()) : null)
class TrainingSample extends Entity {
    startDate: Temporal.PlainDate | null = null;
}

const errorsOf = (e: Entity) => entityIntegrityCheck(e, "Saving")?.errors ?? {};

describe("Corruption", () => {

    test("strict unless inside an allow scope", () => {
        assert.equal(Corruption.strict(), true);
        Corruption.allowScope(() => {
            assert.equal(Corruption.strict(), false);
            Corruption.denyScope(() => assert.equal(Corruption.strict(), true));
        });
    });

    test("a corrupt entity is checked tolerantly", () => {
        assert.ok(getTypeInfo(TrainingSample) != null);
        const t = TrainingSample.create({});
        assert.deepEqual(Object.keys(errorsOf(t)), ["startDate"]);

        (t as unknown as CorruptMixin).corrupt = true;
        assert.deepEqual(errorsOf(t), {});
    });

    test("a save clears the flag once the entity passes strictly", async () => {
        const saved: string[] = [];
        Corruption.onSaveCorrupted.push(() => saved.push("still corrupt"));
        Corruption.onCorruptionRemoved.push(() => saved.push("repaired"));

        const t = TrainingSample.create({});
        t.isNew = false;
        (t as unknown as CorruptMixin).corrupt = true;
        const strict = async () => (await checkFieldsAsync(t, "Saving"))?.errors;

        await Corruption.preSaving(t, strict);
        assert.equal((t as unknown as CorruptMixin).corrupt, true);

        t.startDate = Temporal.PlainDate.from("2024-07-01");
        await Corruption.preSaving(t, strict);
        assert.equal((t as unknown as CorruptMixin).corrupt, false);
        assert.deepEqual(saved, ["still corrupt", "repaired"]);
    });
});
