import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.startsWith / contains / … (SQL-mappable)
import { hasDb, start } from "./setup";
import { ArtistEntity, AlbumEntity, Sex } from "../entities/music";

// Port of Signum.Test/LinqProvider/OrderByTest.cs. C# → altea idiom:
//   Database.Query<T>()        → table(T)
//   .OrderBy / .OrderByDescending → .orderBy / .orderByDescending
//   .ThenBy / .ThenByDescending → .thenBy / .thenByDescending
//   .Select(...) → .map(...)    .Where(...) → .filter(...)
//   .SelectMany(...) → .flatMap(...)
//   .Take(n) → .top(n)          .Distinct() → .distinct()
//   .ToList()/.ToArray() → await .toArray()
//   .FirstEx() → await .first()  .Last() → await .last()
//   .LastOrDefault() → await .lastOrNull()
//   .Count()/.Sum()/.Any()/.All() → await .count()/.sum()/.some()/.every()
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.

describe("OrderByTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().Select(a => a.Name).OrderBy(n => n).ToList();
    test("OrderByString", async () => {
        const songsAlbum = await table(AlbumEntity).map(a => a.name).orderBy(n => n).toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<AlbumEntity>().OrderByDescending(a => a.Year).ToList();
    test("OrderByIntDescending", async () => {
        const songsAlbum = await table(AlbumEntity).orderByDescending(a => a.year).toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<AlbumEntity>().OrderBy(a => a.Author.GetType()).ToList();
    test("OrderByGetType", async () => {
        const songsAlbum = await table(AlbumEntity).orderBy(a => a.author.constructor).toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<ArtistEntity>().OrderBy(a => a.Dead).FirstEx();
    test("OrderByFirst", async () => {
        const songsAlbum = await table(ArtistEntity).orderBy(a => a.dead).first();
        assert.ok(songsAlbum != null);
    });

    // Database.Query<ArtistEntity>().OrderBy(a => a.Dead).Reverse().Select(a => a.Name);
    // TODO(api): Query.reverse
    test("OrderByReverse", async () => {
        const artists = await table(ArtistEntity).orderBy(a => a.dead).reverse().map(a => a.name).toArray();
        assert.ok(Array.isArray(artists));
    });

    // var michael = Database.Query<ArtistEntity>().OrderBy(a => a.Dead).Last();
    test("OrderByLast", async () => {
        const michael = await table(ArtistEntity).orderBy(a => a.dead).last();
        assert.ok(michael.name.contains("Michael"));
    });

    // var michael = Database.Query<ArtistEntity>().OrderBy(a => a.Dead).Last(a => a.Name.Length > 1);
    test("OrderByLastPredicate", async () => {
        const michael = await table(ArtistEntity).orderBy(a => a.dead).last(a => a.name.length > 1);
        assert.ok(michael.name.contains("Michael"));
    });

    // var michael = Database.Query<ArtistEntity>().OrderBy(a => a.Dead).LastOrDefault()!;
    test("OrderByLastOrDefault", async () => {
        const michael = (await table(ArtistEntity).orderBy(a => a.dead).lastOrNull())!;
        assert.ok(michael.name.contains("Michael"));
    });

    // var michael = Database.Query<ArtistEntity>().OrderBy(a => a.Dead).LastOrDefault(a => a.Name.Length > 1)!;
    test("OrderByLastOrDefaultPredicate", async () => {
        const michael = (await table(ArtistEntity).orderBy(a => a.dead).lastOrNull(a => a.name.length > 1))!;
        assert.ok(michael.name.contains("Michael"));
    });

    // Database.Query<ArtistEntity>().OrderByDescending(a => a.Dead).ThenBy(a => a.Name).Reverse().Last();
    // TODO(api): Query.reverse
    test("OrderByThenByReverseLast", async () => {
        const michael = await table(ArtistEntity).orderByDescending(a => a.dead).thenBy(a => a.name).reverse().last();
        assert.ok(michael != null);
    });

    // Database.Query<ArtistEntity>().OrderByDescending(a => a.Dead).Take(2).Reverse().FirstEx(); //reverse ignored
    // TODO(api): Query.reverse
    test("OrderByTakeReverse", async () => {
        const michael = await table(ArtistEntity).orderByDescending(a => a.dead).top(2).reverse().first();
        assert.ok(michael != null);
    });

    // Database.Query<ArtistEntity>().OrderByDescending(a => a.Dead).Take(2).OrderBy(a => a.Name).FirstEx();
    test("OrderByTakeOrderBy", async () => {
        const michael = await table(ArtistEntity).orderByDescending(a => a.dead).top(2).orderBy(a => a.name).first();
        assert.ok(michael != null);
    });

    // Database.Query<ArtistEntity>().OrderBy(a => a.Dead).Take(3);
    test("OrderByTop", async () => {
        const songsAlbum = await table(ArtistEntity).orderBy(a => a.dead).top(3).toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<ArtistEntity>().OrderBy(a => a.Dead).Where(a => a.Id != 0).ToList();
    // TODO(api): Entity.id in query
    test("OrderByNotLast", async () => {
        const songsAlbum = await table(ArtistEntity).orderBy(a => a.dead).filter(a => a.id != 0).toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<ArtistEntity>().OrderBy(a => a.Dead).Distinct().ToList();
    test("OrderByDistinct", async () => {
        const songsAlbum = await table(ArtistEntity).orderBy(a => a.dead).distinct().toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<ArtistEntity>().OrderBy(a => a.Dead)
    //     .GroupBy(a => a.Sex, (s, gr) => new { Sex = s, Count = gr.Count() }).ToList();
    // TODO(api): groupBy result-selector (altea groupBy yields { key, elements }, no (key, group) => result form)
    test("OrderByGroupBy", async () => {
        const songsAlbum = await table(ArtistEntity).orderBy(a => a.dead)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, count: g.elements.length }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<AlbumEntity>().SelectMany(a => a.Songs.OrderBy(a => a.Index))
    //     .GroupBy(s => s.Name, (a, songs) => songs.Sum(a => a.Seconds ?? 0)).ToList();
    // altea has no result-selector groupBy overload; its groupings are { key, elements }, so
    // C#'s `GroupBy(key, (k, g) => …)` is `groupBy(key).map(g => f(g.key, g.elements))`.
    test("RemoveOrderByGroupBy", async () => {
        const list = await table(AlbumEntity)
            .flatMap(a => a.songs.orderBy(a => a.index))
            .groupBy(s => s.name)
            .map(g => g.elements.sum(a => a.seconds ?? 0))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().SelectMany(a => a.Songs.OrderBy(a => a.Index))
    //     .GroupBy(s => new object(), (a, songs) => songs.Sum(a => a.Seconds ?? 0)).ToList();
    test("RemoveOrderByGroupByTrivial", async () => {
        const list = await table(AlbumEntity)
            .flatMap(a => a.songs.orderBy(a => a.index))
            .groupBy(s => ({}))
            .map(g => g.elements.sum(a => a.seconds ?? 0))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // `reduce` (the JS Array method) has no SQL translation — a natural instinct when a dev
    // wants to fold a group's members, but the query engine can't lower it. It must fail with
    // an educational message pointing to the real SQL aggregates (sum/min/max/count/average),
    // not the cryptic "Missing @lambdaTypeForParam 'reduce'".
    test("ReduceInQueryEducatesToUseAggregate", async () => {
        await assert.rejects(
            async () => table(AlbumEntity)
                .flatMap(a => a.songs)
                .groupBy(s => s.name)
                .map(g => g.elements.reduce((acc, a) => acc + (a.seconds ?? 0), 0))
                .toArray(),
            /sum, min, max, count, or average/);
    });

    // OrderByIgnore: a series of queries where the ORDER BY must be elided.
    //   AsserNoQueryWith("ORDER") (logger inspection) has no altea equivalent → drop the
    //   assertion harness and just build+execute each query.
    test("OrderByIgnore", async () => {
        // Database.Query<AlbumEntity>().Where(a => a.Songs.OrderBy(s => s.Name).Count() > 1).Select(a => a.Id).ToList();
        // TODO(api): Entity.id in query
        const a = await table(AlbumEntity).filter(a => a.songs.orderBy(s => s.name).length > 1).map(a => a.id).toArray();

        // Database.Query<AlbumEntity>().Where(a => a.Songs.OrderBy(s => s.Name).Sum(s => s.Name.Length) > 1).Select(a => a.Id).ToList();
        // TODO(api): Entity.id in query
        const b = await table(AlbumEntity).filter(a => a.songs.orderBy(s => s.name).sum(s => s.name.length) > 1).map(a => a.id).toArray();

        // Database.Query<AlbumEntity>().Where(a => a.Songs.OrderBy(s => s.Name).Any(s => s.Name.StartsWith("a"))).Select(a => a.Id).ToList();
        // TODO(api): Entity.id in query
        const c = await table(AlbumEntity).filter(a => a.songs.orderBy(s => s.name).some(s => s.name.startsWith("a"))).map(a => a.id).toArray();

        // Database.Query<AlbumEntity>().Where(a => a.Songs.OrderBy(s => s.Name).All(s => s.Name.StartsWith("a"))).Select(a => a.Id).ToList();
        // TODO(api): Entity.id in query
        const d = await table(AlbumEntity).filter(a => a.songs.orderBy(s => s.name).every(s => s.name.startsWith("a"))).map(a => a.id).toArray();

        // Database.Query<AlbumEntity>().Where(a => a.Songs.OrderBy(s => s.Name).Contains(null!)).Select(a => a.Id).ToList();
        // TODO(api): Entity.id in query + collection Contains in lambda

        // Database.Query<AlbumEntity>().OrderBy(a => a.Name).Count();
        const f = await table(AlbumEntity).orderBy(a => a.name).count();
        assert.ok(typeof f === "number");

        // Database.Query<AlbumEntity>().OrderBy(a => a.Name).Sum(s => s.Name.Length);
        const g = await table(AlbumEntity).orderBy(a => a.name).sum(s => s.name.length);
        assert.ok(g != null);

        // Database.Query<AlbumEntity>().OrderBy(a => a.Name).Any(s => s.Name.StartsWith("a"));
        const h = await table(AlbumEntity).orderBy(a => a.name).some(s => s.name.startsWith("a"));
        assert.ok(typeof h === "boolean");

        // Database.Query<AlbumEntity>().OrderBy(a => a.Name).All(s => s.Name.StartsWith("a"));
        const i = await table(AlbumEntity).orderBy(a => a.name).every(s => s.name.startsWith("a"));
        assert.ok(typeof i === "boolean");

        // Database.Query<AlbumEntity>().OrderBy(a => a.Name).Contains(null!);
        // TODO(api): Query.contains terminal
    });
});
