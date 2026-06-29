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
// altea has no string-join aggregate API yet, so every method is written in its
// most natural altea form, marked `{ skip: true }`, and flagged with a
// `// TODO(api): collection toString aggregate` comment.

describe("ToStringTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Assert.Equal(Query<ArtistEntity>().Select(a => a.Name).ToString(" | "), Query<ArtistEntity>().ToString(a => a.Name, " | "));
    // TODO(api): collection toString aggregate
    test("ToStringMainQuery", { skip: true }, async () => {
        // const a = await table(ArtistEntity).map(a => a.name).toString(" | ");
        // const b = await table(ArtistEntity).toString(a => a.name, " | ");
        // assert.equal(a, b);
    });

    // Assert.Equal(Query<ArtistEntity>().Select(a => a.Name).ToString(" | "), Query<ArtistEntity>().ToString(" | "));
    // TODO(api): collection toString aggregate
    test("ToStringEntity", { skip: true }, async () => {
        // const a = await table(ArtistEntity).map(a => a.name).toString(" | ");
        // const b = await table(ArtistEntity).toString(" | ");
        // assert.equal(a, b);
    });

    // from b orderby b.Name select new { b.Name, MembersToString = b.Members.OrderBy(a => a.Name).ToString(a => a.Name, " | ") }
    //   vs new { b.Name, MembersToString = b.Members.OrderBy(a => a.Name).Select(a => a.Name).ToList().ToString(" | ") }; Assert.True(SequenceEqual)
    // TODO(api): collection toString aggregate
    test("ToStringSubCollection", { skip: true }, async () => {
        // const result1 = await table(BandEntity)
        //     .orderBy(b => b.name)
        //     .map(b => ({ name: b.name, membersToString: b.members.orderBy(a => a.member.entity.name).toString(a => a.member.entity.name, " | ") }))
        //     .toArray();
        // const result2 = await table(BandEntity)
        //     .orderBy(b => b.name)
        //     .map(b => ({ name: b.name, membersToString: b.members.orderBy(a => a.member.entity.name).map(a => a.member.entity.name).toString(" | ") }))
        //     .toArray();
        // assert.deepEqual(result1, result2);
    });

    // from b orderby b.Name select new { b.Name, AlbumnsToString = Query<AlbumEntity>().Where(a => a.Author == b).OrderBy(a => a.Name).ToString(a => a.Name, " | ") }
    //   vs … .Select(a => a.Name).ToList().ToString(" | "); Assert.Equal(result1, result2)
    // TODO(api): collection toString aggregate
    test("ToStringSubQuery", { skip: true }, async () => {
        // const result1 = await table(BandEntity)
        //     .orderBy(b => b.name)
        //     .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => a.name).toString(a => a.name, " | ") }))
        //     .toArray();
        // const result2 = await table(BandEntity)
        //     .orderBy(b => b.name)
        //     .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => a.name).map(a => a.name).toString(" | ") }))
        //     .toArray();
        // assert.deepEqual(result1, result2);
    });

    // from b orderby b.Name select new { b.Name, AlbumnsToString = Query<AlbumEntity>().Where(a => a.Author == b).ToString(a => a.Author.Id.ToString(), " | ") }
    // TODO(api): collection toString aggregate
    test("ToStringSubQueryIdIB", { skip: true }, async () => {
        // const result1 = await table(ArtistEntity)
        //     .orderBy(b => b.name)
        //     .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).toString(a => (a.author.id as number).toString(), " | ") }))
        //     .toArray();
    });

    // from b orderby b.Name select new { b.Name, AlbumnsToString = Query<AlbumEntity>().Where(a => a.Author == b).OrderBy(a => a.Author.Id).ToString(a => a.Author.Id.ToString(), " | ") }
    // TODO(api): collection toString aggregate
    test("ToStringSubQueryIdIBOrdering", { skip: true }, async () => {
        // const result1 = await table(ArtistEntity)
        //     .orderBy(b => b.name)
        //     .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => (a.author.id as number)).toString(a => (a.author.id as number).toString(), " | ") }))
        //     .toArray();
    });

    // from b group b by b.Sex into g select new { g.Key, NamesInOrder = g.OrderBy(a => a.Name).ToString(" | "), NamesInRevereOrder = g.OrderByDescending(a => a.Name).ToString(" | ") }
    // TODO(api): collection toString aggregate
    test("ToStringGroupByOrdering", { skip: true }, async () => {
        // const result1 = await table(ArtistEntity)
        //     .groupBy(b => b.sex)
        //     .map(g => ({
        //         key: g.key,
        //         namesInOrder: g.elements.orderBy(a => a.name).toString(" | "),
        //         namesInRevereOrder: g.elements.orderByDescending(a => a.name).toString(" | "),
        //     }))
        //     .toArray();
    });

    // result1: …ToString(a => a.Id.ToString(), " | "); result2: …Select(a => a.Id).ToString(" | "); result3: toString = list => list.ToString(" | ") over …Select(a => a.Id).ToList(); Assert SequenceEqual(result1,result2) & (result2,result3)
    // TODO(api): collection toString aggregate
    test("ToStringNumbers", { skip: true }, async () => {
        // const result1 = await table(BandEntity)
        //     .orderBy(b => b.name)
        //     .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => a.name).toString(a => (a.id as number).toString(), " | ") }))
        //     .toArray();
        // const result2 = await table(BandEntity)
        //     .orderBy(b => b.name)
        //     .map(b => ({ name: b.name, albumnsToString: table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => a.name).map(a => a.id).toString(" | ") }))
        //     .toArray();
        // const toString = (list: (string | number)[]) => list.toString(" | ");
        // const result3 = await table(BandEntity)
        //     .orderBy(b => b.name)
        //     .map(b => ({ name: b.name, albumnsToString: toString(table(AlbumEntity).filter(a => a.author.is(b)).orderBy(a => a.name).map(a => a.id).toArray()) }))
        //     .toArray();
        // assert.deepEqual(result1, result2);
        // assert.deepEqual(result2, result3);
    });
});
