import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, startAndLoad } from "./setup";
import { AwardNominationEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/SelectLiteModel.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Where(...) → .filter(...)
//   .Select(...)         → .map(...)           .ToList()   → await .toArray()
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// The query itself (filter award != null, project the award Lite) is portable,
// but the test's assertions inspect each Lite's `.Model` (LiteModel) and use
// runtime type patterns (`a is Lite<AmericanMusicAwardEntity>`). altea models
// neither a Lite `.model` projection nor `Lite<T>` type discrimination yet, so
// the whole test is written in its most natural form, marked `{ skip: true }`,
// with the assertion block commented out and flagged with `// TODO(api): …`.

describe("SelectLiteModel", { skip: !hasDb }, () => {
    before(async () => { await startAndLoad(); });

    // var awards = Database.Query<AwardNominationEntity>().Where(a => a.Award != null).Select(a => a.Award).ToList();
    // foreach (var a in awards) { a.Model is AwardLiteModel / string … }
    // TODO(api): Lite .model (LiteModel) projection / inspection
    // TODO(api): Lite<T> runtime type discrimination (a is Lite<AmericanMusicAwardEntity>)
    test("SelectAwardLiteModel", { skip: true }, async () => {
        const awards = await table(AwardNominationEntity)
            .filter(a => a.award != null)
            .map(a => a.award)
            .toArray();
        assert.ok(Array.isArray(awards));
        // for (const a of awards) {
        //     if (a.entity instanceof AmericanMusicAwardEntity)
        //         assert.ok(a.model instanceof AwardLiteModel); // Override for type
        //     else if (a.entity instanceof GrammyAwardEntity)
        //         assert.ok(a.model instanceof AwardLiteModel); // Property Attribute
        //     else
        //         assert.ok(typeof a.model === "string"); // Globally
        // }
    });
});
