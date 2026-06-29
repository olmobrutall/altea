import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.contains (SQL-mappable)
import { hasDb, start } from "./setup";
import { ArtistEntity, AlbumEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/TakeSkipTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)              .Take(n)/.Skip(n) → .top(n)/.skip(n)
//   .Where(...)          → .filter(...)          .Select(...)      → .map(...)
//   .OrderBy(...)        → .orderBy(...)         .ThenBy(...)      → .thenBy(...)
//   .ToList()/.ToArray() → await .toArray()      .Any()            → await .some()
//   .Count()             → await .count()        .Max(sel)         → await .max(sel)
//   new { X = .. }       → { x: .. }             a.ToLite()        → a.toLite()
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.

describe("TakeSkipTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // var takeArtist = Database.Query<ArtistEntity>().Take(2).ToList();
    test("Take", async () => {
        const takeArtist = await table(ArtistEntity).top(2).toArray();
        assert.equal(takeArtist.length, 2);
    });

    // var takeArtist = Database.Query<ArtistEntity>().OrderBy(a => a.Name).Take(2).ToList();
    test("TakeOrder", async () => {
        const takeArtist = await table(ArtistEntity).orderBy(a => a.name).top(2).toArray();
        assert.equal(takeArtist.length, 2);
    });

    // var takeAlbum = Database.Query<AlbumEntity>().Select(a => new { a.Name, TwoSongs = a.Songs.Take(2) }).ToList();
    test("TakeSql", async () => {
        const takeAlbum = await table(AlbumEntity)
            .map(a => ({ name: a.name, twoSongs: a.songs.top(2) }))
            .toArray();
        assert.ok(takeAlbum.every(a => a.twoSongs.length <= 2));
    });

    // var skipArtist = Database.Query<ArtistEntity>().Skip(2).ToList();
    test("Skip", async () => {
        const skipArtist = await table(ArtistEntity).skip(2).toArray();
        assert.ok(Array.isArray(skipArtist));
    });

    // var allAggregates = Database.Query<ArtistEntity>().GroupBy(a => new { }).Select(gr => new { Count = gr.Count(), MaxId = gr.Max(a=>a.Id) }).Skip(2).ToList();
    // TODO(api): aggregate over group elements (gr.Count() / gr.Max(...)) — no aggregation API on grouping.elements yet
    // TODO(api): aggregate over group elements (spread + PrimaryKey-as-number)
    test("SkipAllAggregates", async () => {
        // const allAggregates = await table(ArtistEntity)
        //     .groupBy(a => ({}))
        //     .map(gr => ({ count: gr.elements.length, maxId: Math.max(...gr.elements.map(a => a.id)) }))
        //     .skip(2)
        //     .toArray();
        // assert.ok(Array.isArray(allAggregates));
    });

    // var allAggregates = Database.Query<ArtistEntity>().GroupBy(a => new { }).Select(gr => new { Count = gr.Count(), MaxId = gr.Max(a => a.Id) }).OrderBy(a => a.Count).OrderAlsoByKeys().ToList();
    // TODO(api): aggregate over group elements (gr.Count() / gr.Max(...)) — no aggregation API on grouping.elements yet
    // TODO(api): OrderAlsoByKeys — no equivalent in Query<T>
    test("AllAggregatesOrderByAndByKeys", async () => {
        // const allAggregates = await table(ArtistEntity)
        //     .groupBy(a => ({}))
        //     .map(gr => ({ count: gr.elements.length, maxId: Math.max(...gr.elements.map(a => a.id)) }))
        //     .orderBy(a => a.count)
        //     .toArray();
        // assert.ok(Array.isArray(allAggregates));
    });

    // var allAggregates = Database.Query<ArtistEntity>().GroupBy(a => new { }).Select(gr => new { Count = gr.Count(), MaxId = gr.Max(a => a.Id) }).OrderBy(a=>a.Count).Skip(2).ToList();
    // TODO(api): aggregate over group elements (gr.Count() / gr.Max(...)) — no aggregation API on grouping.elements yet
    test("SkipAllAggregatesOrderBy", async () => {
        // const allAggregates = await table(ArtistEntity)
        //     .groupBy(a => ({}))
        //     .map(gr => ({ count: gr.elements.length, maxId: Math.max(...gr.elements.map(a => a.id)) }))
        //     .orderBy(a => a.count)
        //     .skip(2)
        //     .toArray();
        // assert.ok(Array.isArray(allAggregates));
    });

    // var count = Database.Query<ArtistEntity>().GroupBy(a => new { }).Select(gr => new { Count = gr.Count(), MaxId = gr.Max(a => a.Id) }).OrderBy(a => a.Count).Count();
    // TODO(api): aggregate over group elements (gr.Count() / gr.Max(...)) — no aggregation API on grouping.elements yet
    test("AllAggregatesCount", async () => {
        // const count = await table(ArtistEntity)
        //     .groupBy(a => ({}))
        //     .map(gr => ({ count: gr.elements.length, maxId: Math.max(...gr.elements.map(a => a.id)) }))
        //     .orderBy(a => a.count)
        //     .count();
        // assert.equal(count, 1);
    });

    // var skipArtist = Database.Query<ArtistEntity>().OrderBy(a => a.Name).Skip(2).ToList();
    test("SkipOrder", async () => {
        const skipArtist = await table(ArtistEntity).orderBy(a => a.name).skip(2).toArray();
        assert.ok(Array.isArray(skipArtist));
    });

    // var takeAlbum = Database.Query<AlbumEntity>().Select(a => new { a.Name, TwoSongs = a.Songs.Skip(2) }).ToList();
    test("SkipSql", async () => {
        const takeAlbum = await table(AlbumEntity)
            .map(a => ({ name: a.name, twoSongs: a.songs.skip(2) }))
            .toArray();
        assert.ok(Array.isArray(takeAlbum));
    });

    // var skipArtist = Database.Query<ArtistEntity>().Skip(2).Take(1).ToList();
    test("SkipTake", async () => {
        const skipArtist = await table(ArtistEntity).skip(2).top(1).toArray();
        assert.ok(Array.isArray(skipArtist));
    });

    // var skipArtist = Database.Query<ArtistEntity>().OrderBy(a => a.Name).Skip(2).Take(1).ToList();
    test("SkipTakeOrder", async () => {
        const skipArtist = await table(ArtistEntity).orderBy(a => a.name).skip(2).top(1).toArray();
        assert.ok(Array.isArray(skipArtist));
    });

    // var result = Database.Query<AlbumEntity>().Where(dr => dr.Songs.OrderByDescending(a => a.Seconds).Take(1).Where(a => a.Name.Contains("Zero")).Any()).Select(a => a.ToLite()).ToList();
    // TODO(api): collection .some() terminal requires a predicate arg (no zero-arg overload)
    test("InnerTake", async () => {
        // const result = await table(AlbumEntity)
        //     .filter(dr => dr.songs.orderByDescending(a => a.seconds).top(1).filter(a => a.name.contains("Zero")).some())
        //     .map(a => a.toLite())
        //     .toArray();
        // assert.equal(result.length, 0);
    });

    // TestPaginate(Database.Query<ArtistEntity>().OrderBy(a => a.Sex).Select(a => a.Name));
    // TODO(api): subquery membership variance (Query<string> not assignable to Query<Entity>)
    test("OrderByCommonSelectPaginate", async () => {
        // await testPaginate(table(ArtistEntity).orderBy(a => a.sex).map(a => a.name));
    });

    // TestPaginate(Database.Query<ArtistEntity>().OrderBy(a => a.Name).Select(a => a.Name));
    // TODO(api): subquery membership variance (Query<string> not assignable to Query<Entity>)
    test("OrderBySelectPaginate", async () => {
        // await testPaginate(table(ArtistEntity).orderBy(a => a.name).map(a => a.name));
    });

    // TestPaginate(Database.Query<ArtistEntity>().OrderByDescending(a => a.Name).Select(a => a.Name));
    // TODO(api): subquery membership variance (Query<string> not assignable to Query<Entity>)
    test("OrderByDescendingSelectPaginate", async () => {
        // await testPaginate(table(ArtistEntity).orderByDescending(a => a.name).map(a => a.name));
    });

    // TestPaginate(Database.Query<ArtistEntity>().OrderBy(a => a.Name).ThenBy(a => a.Id).Select(a => a.Name));
    // TODO(api): subquery membership variance (Query<string> not assignable to Query<Entity>)
    test("OrderByThenBySelectPaginate", async () => {
        // await testPaginate(table(ArtistEntity).orderBy(a => a.name).thenBy(a => a.id).map(a => a.name));
    });

    // TestPaginate(Database.Query<ArtistEntity>().Select(a => a.Name).OrderBy(a => a));
    // TODO(api): subquery membership variance (OrderedQuery<string> not assignable to Query<Entity>)
    test("SelectOrderByPaginate", async () => {
        // await testPaginate(table(ArtistEntity).map(a => a.name).orderBy(a => a));
    });

    // TestPaginate(Database.Query<ArtistEntity>().Select(a => a.Name).OrderByDescending(a => a));
    // TODO(api): subquery membership variance (OrderedQuery<string> not assignable to Query<Entity>)
    test("SelectOrderByDescendingPaginate", async () => {
        // await testPaginate(table(ArtistEntity).map(a => a.name).orderByDescending(a => a));
    });

    // private void TestPaginate<T>(IQueryable<T> query) {
    //     var list = query.OrderAlsoByKeys().ToList();
    //     int pageSize = 2;
    //     var list2 = 0.To(((list.Count / pageSize) + 1)).SelectMany(page =>
    //         query.OrderAlsoByKeys().Skip(pageSize * page).Take(pageSize).ToList()).ToList();
    //     Assert.Equal(list, list2);
    // }
    // TODO(api): OrderAlsoByKeys — no equivalent in Query<T> (needed for stable pagination)
    async function testPaginate<T>(query: ReturnType<typeof table>): Promise<void> {
        const list = await (query as any).toArray() as T[];

        const pageSize = 2;

        const list2: T[] = [];
        for (let page = 0; page < (Math.floor(list.length / pageSize) + 1); page++) {
            const chunk = await (query as any).skip(pageSize * page).top(pageSize).toArray() as T[];
            list2.push(...chunk);
        }

        assert.deepEqual(list, list2);
    }
});
