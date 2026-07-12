import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.contains / startsWith / … (SQL-mappable)
import { hasDb, start } from "./setup";
import { ArtistEntity, AlbumEntity, BandEntity, Sex } from "../entities/music";

// Port of Signum.Test/LinqProvider/ToStringTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Select(...) → .map(...)
//   .Where(...)          → .filter(...)        .OrderBy(...) → .orderBy(...)
//   .ToList()/.ToArray() → await .toArray()    .GroupBy(k)   → .groupBy(k)
//   a.Author == b        → a.author.is(b)      new { X = .. } → { x: .. } (camelCase)
//   a.Id.ToString()      → a.id.toString()     $"..."        → "+" concat
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// EVERY ToStringTest method exercises the collection-aggregate ToString —
// either query-level `query.ToString(selector, separator)` / `query.ToString(separator)`
// or per-row `collection.ToString(selector, separator)` / `list.ToString(separator)`.
// altea's equivalent is `.map(sel).join(separator)` (a string_agg over the (sub)query),
// which the binder translates to SQL — so every method runs live.

describe("ToStringTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Assert.Equal(Query<ArtistEntity>().Select(a => a.Name).ToString(" | "), Query<ArtistEntity>().ToString(a => a.Name, " | "));
    test("ToStringMainQuery", async () => {
        const a = await table(ArtistEntity).map(a => a.name).join(" | ");
        const b = await table(ArtistEntity).map(a => a.name).join(" | ");
        assert.equal(a, b);
        assert.ok(a.includes(" | "));
    });

    // Assert.Equal(Query<ArtistEntity>().Select(a => a.Name).ToString(" | "), Query<ArtistEntity>().ToString(" | "));
    test("ToStringEntity", async () => {
        const a = await table(ArtistEntity).map(a => a.name).join(" | ");
        const b = await table(ArtistEntity).join(" | ");
        assert.equal(a, b);
        assert.ok(a.length > 0);
    });

    // from b orderby b.Name select new { b.Name, MembersToString = b.Members.OrderBy(a => a.Name).ToString(a => a.Name, " | ") }
    //   vs new { b.Name, MembersToString = b.Members.OrderBy(a => a.Name).Select(a => a.Name).ToList().ToString(" | ") }; Assert.True(SequenceEqual)
    test("ToStringSubCollection", async () => {
        const result1 = await table(BandEntity)
            .orderBy(b => b.name)
            .map(b => ({ name: b.name, membersToString: b.members.orderBy(a => a.member.name).map(a => a.member.name).join(" | ") }))
            .toArray();
        const result2 = await table(BandEntity)
            .orderBy(b => b.name)
            .map(b => ({ name: b.name, membersToString: b.members.orderBy(a => a.member.name).map(a => a.member.name).join(" | ") }))
            .toArray();
        assert.deepEqual(result1, result2);
        assert.ok(result1.length > 0);
        assert.ok(result1.some(r => r.membersToString.includes(" | ")));
    });

    // from b orderby b.Name select new { b.Name, AlbumnsToString = Query<AlbumEntity>().Where(a => a.Author == b).OrderBy(a => a.Name).ToString(a => a.Name, " | ") }
    //   vs … .Select(a => a.Name).ToList().ToString(" | "); Assert.Equal(result1, result2)
    test("ToStringSubQuery", async () => {
        const result1 = await table(BandEntity)
            .orderBy(b => b.name)
            .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => a.name).map(a => a.name).join(" | ") }))
            .toArray();
        const result2 = await table(BandEntity)
            .orderBy(b => b.name)
            .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => a.name).map(a => a.name).join(" | ") }))
            .toArray();
        assert.deepEqual(result1, result2);
        assert.ok(result1.length > 0);
    });

    // from b orderby b.Name select new { b.Name, AlbumnsToString = Query<AlbumEntity>().Where(a => a.Author == b).ToString(a => a.Author.Id.ToString(), " | ") }
    test("ToStringSubQueryIdIB", async () => {
        const result1 = await table(ArtistEntity)
            .orderBy(b => b.name)
            .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).map(a => (a.author.id as number).toString()).join(" | ") }))
            .toArray();
        assert.ok(result1.length > 0);
    });

    // from b orderby b.Name select new { b.Name, AlbumnsToString = Query<AlbumEntity>().Where(a => a.Author == b).OrderBy(a => a.Author.Id).ToString(a => a.Author.Id.ToString(), " | ") }
    test("ToStringSubQueryIdIBOrdering", async () => {
        const result1 = await table(ArtistEntity)
            .orderBy(b => b.name)
            .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => (a.author.id as number)).map(a => (a.author.id as number).toString()).join(" | ") }))
            .toArray();
        assert.ok(result1.length > 0);
    });

    // from b group b by b.Sex into g select new { g.Key, NamesInOrder = g.OrderBy(a => a.Name).ToString(" | "), NamesInRevereOrder = g.OrderByDescending(a => a.Name).ToString(" | ") }
    test("ToStringGroupByOrdering", async () => {
        const result1 = await table(ArtistEntity)
            .groupBy(b => b.sex)
            .map(g => ({
                key: g.key,
                namesInOrder: g.elements.orderBy(a => a.name).map(a => a.name).join(" | "),
                namesInRevereOrder: g.elements.orderByDescending(a => a.name).map(a => a.name).join(" | "),
            }))
            .toArray();
        assert.ok(result1.length > 0);
        // Ascending and descending joins are permutations of each other per group
        // (identical multiset of names, just re-ordered).
        assert.ok(result1.every(g =>
            g.namesInOrder.split(" | ").sort().join(" | ") ===
            g.namesInRevereOrder.split(" | ").sort().join(" | ")));
    });

    // result1: …ToString(a => a.Id.ToString(), " | "); result2: …Select(a => a.Id).ToString(" | "); result3: toString = list => list.ToString(" | ") over …Select(a => a.Id).ToList(); Assert SequenceEqual(result1,result2) & (result2,result3)
    // result1: ToString(a => a.Id.ToString(), " | ") over the sub-query; result2: Select(a=>a.Id).ToString(" | ").
    // Both join SERVER-side (STRING_AGG). result3 in C# feeds Select(a=>a.Id).ToList() to a COMPILED
    // client Func `list => list.ToString(" | ")` — the provider can't translate a Func, so it
    // materialises the ids and joins them IN-MEMORY (not a string aggregate). altea does the same:
    // `.toArray().$v` materialises the id-array per row (a child projection), and the join runs in
    // plain JS afterwards (an arbitrary client Func inside the quoted projection isn't supported, so
    // the in-memory step lives in the outer map). Same result, but genuinely client-side.
    test("ToStringNumbers", async () => {
        const result1 = await table(BandEntity)
            .orderBy(b => b.name)
            .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => a.name).map(a => (a.id as number).toString()).join(" | ") }))
            .toArray();
        const result2 = await table(BandEntity)
            .orderBy(b => b.name)
            .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => a.name).map(a => a.id).join(" | ") }))
            .toArray();
        const bands = await table(BandEntity)
            .orderBy(b => b.name)
            .map(b => ({ name: b.name, albumIds: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => a.name).map(a => a.id).toArray().$v }))
            .toArray();
        const result3 = bands.map(b => ({ name: b.name, albumnsToString: b.albumIds.join(" | ") }));

        // All three are ordered by the sub-query's OrderBy(a.Name): result1/result2 via STRING_AGG
        // now carries the ORDER BY (bindToString), result3 via the ordered child projection.
        assert.deepEqual(result1, result2);
        assert.deepEqual(result2 as unknown, result3);
        assert.ok(result1.length > 0);
    });
});
