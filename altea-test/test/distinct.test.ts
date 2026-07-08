import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import { AlbumEntity, ArtistEntity, BandEntity, Sex } from "../entities/music";

// Port of Signum.Test/LinqProvider/DistinctTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)
//   .Select(...)         → .map(...)         .Where(...)    → .filter(...)
//   .SelectMany(...)     → .flatMap(...)      .Distinct()   → .distinct()
//   .ToList()            → await .toArray()   .Count()      → await .count()
//   .Take(n)             → .top(n)            .GroupBy(k)   → .groupBy(k)
//   a.ToLite()           → a.toLite()         new { X = .. } → { x: .. }
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.

describe("DistinctTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().Select(a => a.Label.Name).Distinct().ToList();
    test("DistinctString", async () => {
        const authors = await table(AlbumEntity).map(a => a.label.name).distinct().toArray();
        assert.ok(Array.isArray(authors));
    });

    // Database.Query<ArtistEntity>().Select(a => new { a.Sex, a.Dead }).Distinct().ToList();
    test("DistinctPair", async () => {
        const authors = await table(ArtistEntity).map(a => ({ sex: a.sex, dead: a.dead })).distinct().toArray();
        assert.ok(Array.isArray(authors));
    });

    // Database.Query<AlbumEntity>().Select(a => a.Label).Distinct().ToList();
    test("DistinctFie", async () => {
        const authors = await table(AlbumEntity).map(a => a.label).distinct().toArray();
        assert.ok(Array.isArray(authors));
    });

    // Database.Query<AlbumEntity>().Where(a => a.Year != 0).Select(a => a.Label).Distinct().ToList();
    test("DistinctFieExpanded", async () => {
        const authors = await table(AlbumEntity).filter(a => a.year != 0).map(a => a.label).distinct().toArray();
        assert.ok(Array.isArray(authors));
    });

    // Database.Query<AlbumEntity>().Select(a => a.Author).Distinct().ToList();
    test("DistinctIb", async () => {
        const authors = await table(AlbumEntity).map(a => a.author).distinct().toArray();
        assert.ok(Array.isArray(authors));
    });

    // count1 = ...Select(a => a.Name).Distinct().Select(a => a).Count();
    // count2 = ...Select(a => a.Name).Distinct().ToList().Count();
    // Assert.Equal(count1, count2);
    test("DistinctCount", async () => {
        const count1 = await table(AlbumEntity).map(a => a.name).distinct().map(a => a).count();
        const count2 = (await table(AlbumEntity).map(a => a.name).distinct().toArray()).length;
        assert.equal(count1, count2);
    });

    // Database.Query<BandEntity>().SelectMany(a => a.Members.SelectMany(m => m.Friends).Distinct()).Take(4).ToList();
    test("DistinctTake", async () => {
        const bla = await table(BandEntity)
            .flatMap(a => a.members.map(m => m.member.friends.map(f => f.friend)).distinct())
            .top(4)
            .toArray();
        assert.ok(bla.length > 0);
        assert.ok(bla.length <= 4);
    });

    // from b in Database.Query<BandEntity>()
    // from g in b.Members.GroupBy(a => a.Sex).Select(gr => new { gr.Key, Count = gr.Count() })
    // select new { Band = b.ToLite(), g.Key, g.Count } ).Take(2).ToList();
    test("GroupTake", async () => {
        const bla = await table(BandEntity)
            .flatMap(b => b.members
                .groupBy(a => a.member.sex)
                .map(gr => ({ band: b.toLite(), key: gr.key, count: gr.elements.length })))
            .top(2)
            .toArray();
        assert.ok(bla.length > 0);
        assert.ok(bla.length <= 2);
        assert.ok(bla.every(x => x.count > 0));
    });

    // nullableList = ...Select(a => a == null ? (Sex?)null : a.Sex).Distinct().ToList();
    // notNullableList = ...Select(a => a.Sex).Distinct().ToList();
    // Assert.Equal(nullableList.Count, notNullableList.Count);
    test("DistinctWithCheapNullPropagation", async () => {
        const nullableList = await table(ArtistEntity).map(a => a == null ? null : a.sex).distinct().toArray();
        const notNullableList = await table(ArtistEntity).map(a => a.sex).distinct().toArray();
        assert.equal(nullableList.length, notNullableList.length);
    });
});
