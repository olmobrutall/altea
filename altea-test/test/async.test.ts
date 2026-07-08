import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import { BandEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/AsyncTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)
//   .ToListAsync()/.ToArrayAsync() → await .toArray()
//   .AverageAsync(sel)             → await .avg(sel)
//   .MinAsync(sel)                 → await .min(sel)
//   a.Members.Count                → a.members.length
// altea terminals are ALREADY async (the connector is async-only), so C#'s
// *Async terminals map to the SAME altea await: there is no separate sync/async
// split. ToListAsync/ToArrayAsync therefore port live as `await .toArray()`.
// AverageAsync/MinAsync take a selector that counts a part-entity collection per
// row (a.members.length) — a per-row sub-aggregate over a collection, which altea
// translates to a correlated COUNT subquery. Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.

describe("AsyncTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // var artistsInBands = await Database.Query<BandEntity>().ToListAsync();
    test("ToListAsync", async () => {
        const artistsInBands = await table(BandEntity).toArray();
        assert.ok(Array.isArray(artistsInBands));
    });

    // var artistsInBands = await Database.Query<BandEntity>().ToArrayAsync();
    test("ToArrayAsync", async () => {
        const artistsInBands = await table(BandEntity).toArray();
        assert.ok(Array.isArray(artistsInBands));
    });

    // var artistsInBands = await Database.Query<BandEntity>().AverageAsync(a => a.Members.Count);
    test("AverageAsync", async () => {
        const artistsInBands = await table(BandEntity).avg(a => a.members.length);
        assert.ok(artistsInBands! > 0);
    });

    // var artistsInBands = await Database.Query<BandEntity>().MinAsync(a => a.Members.Count);
    test("MinAsync", async () => {
        const artistsInBands = await table(BandEntity).min(a => a.members.length);
        assert.ok(artistsInBands! >= 0);
    });
});
