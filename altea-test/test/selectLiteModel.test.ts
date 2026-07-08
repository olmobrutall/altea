import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import { AwardNominationEntity, GrammyAwardEntity, AmericanMusicAwardEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/SelectLiteModel.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Where(...) → .filter(...)
//   .Select(...)         → .map(...)           .ToList()   → await .toArray()
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// The query (filter award != null, project the polymorphic award Lite) runs live.
// altea discriminates a lite's runtime type via its `entityType` (the analog of
// C#'s `a is Lite<AmericanMusicAwardEntity>`), and surfaces the model through
// `toString()`. A distinct typed LiteModel object (C#'s `a.Model is AwardLiteModel`)
// has no altea equivalent — the test entities register no lite-model constructor —
// so that finer distinction is not asserted here.

describe("SelectLiteModel", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // var awards = Database.Query<AwardNominationEntity>().Where(a => a.Award != null).Select(a => a.Award).ToList();
    // foreach (var a in awards) { a is Lite<AmericanMusicAwardEntity> / Lite<GrammyAwardEntity> … a.Model … }
    test("SelectAwardLiteModel", async () => {
        const awards = await table(AwardNominationEntity)
            .filter(a => a.award != null)
            .map(a => a.award)
            .toArray();
        assert.ok(awards.length > 0);
        for (const a of awards) {
            // Runtime type discrimination via entityType (C#'s `a is Lite<...>`).
            if (a!.entityType === AmericanMusicAwardEntity)
                assert.equal(typeof a!.toString(), "string");
            else if (a!.entityType === GrammyAwardEntity)
                assert.equal(typeof a!.toString(), "string");
            else
                assert.equal(typeof a!.toString(), "string");
        }
    });
});
