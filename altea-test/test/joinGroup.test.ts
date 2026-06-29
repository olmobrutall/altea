import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.contains / startsWith / … (SQL-mappable)
import { hasDb, start } from "./setup";
import { ArtistEntity, AlbumEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/JoinGroupTest.cs. C# → altea idiom:
//   Database.Query<T>()           → table(T)
//   .Where(...)                   → .filter(...)        .Select(...) → .map(...)
//   .SelectMany(...)              → .flatMap(...)        .ToList()    → await .toArray()
//   from a join b on a.K equals b.K select res
//                                 → table(A).join(table(B), a => a.k, b => b.k, (a, b) => res)
//   new { a.Name, X = … }         → ({ name: a.name, x: … }) (camelCase)
//   a == b.Author / a equals b.Author (entity key) → a.is(b.author)
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Outer joins have NO altea API yet. Signum expresses left/right/full outer joins
// with `.DefaultIfEmpty()` on one or both sides, and GroupJoin (`join … into g`)
// for the grouped variants. altea's only join primitive is `.join(other, key,
// otherKey, result)` (inner join). Tests using DefaultIfEmpty / GroupJoin are
// written in their most natural altea form, marked `{ skip: true }`, and flagged
// `// TODO(api): groupJoin/defaultIfEmpty`. The temp-view test additionally needs
// Database.View / temporary tables / UnsafeInsertView.

describe("JoinGroupTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // from a in Query<AlbumEntity>() join b in Query<AlbumEntity>().SelectMany(a => a.Songs) on a.Name equals b.Name select new { a.Name, Label = a.Label.Name }
    test("Join", async () => {
        const songsAlbum = await table(AlbumEntity)
            .join(
                table(AlbumEntity).flatMap(a => a.songs),
                a => a.name,
                b => b.name,
                (a, b) => ({ name: a.name, label: a.label.name }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>() join b in Query<AlbumEntity>() on a equals b.Author select new { Artist = a.Name, Album = b.Name }
    test("JoinEntity", async () => {
        const songsAlbum = await table(ArtistEntity)
            .join(
                table(AlbumEntity),
                a => a,
                b => b.author,
                (a, b) => ({ artist: a.name, album: b.name }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // from a1 join a2 on a1.Label equals a2.Label join a3 on a2.Label equals a3.Label select new { Name1 = a1.Name, Name2 = a2.Name, Name3 = a3.Name }
    test("JoinEntityTwice", async () => {
        const albums = await table(AlbumEntity)
            .join(
                table(AlbumEntity),
                a1 => a1.label,
                a2 => a2.label,
                (a1, a2) => ({ name1: a1.name, name2: a2.name }))
            .join(
                table(AlbumEntity),
                p => p.name2,
                a3 => a3.label.name,
                (p, a3) => ({ name1: p.name1, name2: p.name2, name3: a3.name }))
            .toArray();
        assert.ok(Array.isArray(albums));
    });

    // Query<AlbumEntity>().Join(Query<AlbumEntity>(), a => a.Year, a => a.Year, (a1, a2) => a1.Label.Name + " " + a2.Label.Name)
    test("JoinerExpansions", async () => {
        const labels = await table(AlbumEntity)
            .join(
                table(AlbumEntity),
                a => a.year,
                a => a.year,
                (a1, a2) => a1.label.name + " " + a2.label.name)
            .toArray();
        assert.ok(Array.isArray(labels));
    });

    // from a in Query<ArtistEntity>().DefaultIfEmpty() join b in Query<AlbumEntity>() on a equals b.Author select new { Artist = a.Name, Album = b.Name }
    // TODO(api): groupJoin/defaultIfEmpty
    test("LeftOuterJoinEntity", { skip: true }, async () => {
        // const songsAlbum = await table(ArtistEntity).defaultIfEmpty()
        //     .join(
        //         table(AlbumEntity),
        //         a => a,
        //         b => b.author,
        //         (a, b) => ({ artist: a.name, album: b.name }))
        //     .toArray();
        // assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>().DefaultIfEmpty() join b in Query<AlbumEntity>() on a equals b.Author select new { Artist = a.Name, Album = b.Name, HasArtist = a != null }
    // TODO(api): groupJoin/defaultIfEmpty
    test("LeftOuterJoinEntityNotNull", { skip: true }, async () => {
        // const songsAlbum = await table(ArtistEntity).defaultIfEmpty()
        //     .join(
        //         table(AlbumEntity),
        //         a => a,
        //         b => b.author,
        //         (a, b) => ({ artist: a.name, album: b.name, hasArtist: a != null }))
        //     .toArray();
        // assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>() join b in Query<AlbumEntity>().DefaultIfEmpty() on a equals b.Author select new { Artist = a.Name, Album = b.Name }
    // TODO(api): groupJoin/defaultIfEmpty
    test("RightOuterJoinEntity", { skip: true }, async () => {
        // const songsAlbum = await table(ArtistEntity)
        //     .join(
        //         table(AlbumEntity).defaultIfEmpty(),
        //         a => a,
        //         b => b.author,
        //         (a, b) => ({ artist: a.name, album: b.name }))
        //     .toArray();
        // assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>() join b in Query<AlbumEntity>().DefaultIfEmpty() on a equals b.Author select new { Artist = a.Name, Album = b.Name, HasArtist = b != null }
    // TODO(api): groupJoin/defaultIfEmpty
    test("RightOuterJoinEntityNotNull", { skip: true }, async () => {
        // const songsAlbum = await table(ArtistEntity)
        //     .join(
        //         table(AlbumEntity).defaultIfEmpty(),
        //         a => a,
        //         b => b.author,
        //         (a, b) => ({ artist: a.name, album: b.name, hasArtist: b != null }))
        //     .toArray();
        // assert.ok(Array.isArray(songsAlbum));
    });

    // from b in Query<AlbumEntity>().Where(b => b.Year == 1993).DefaultIfEmpty() join a in Query<ArtistEntity>().DefaultIfEmpty() on b.Author equals a where b == null select new { Artist = a.Name, Album = b.Name }; Assert.True(list.Any())
    // TODO(api): groupJoin/defaultIfEmpty
    test("FullOuterJoinWithFilter", { skip: true }, async () => {
        // const list = await table(AlbumEntity).filter(b => b.year == 1993).defaultIfEmpty()
        //     .join(
        //         table(ArtistEntity).defaultIfEmpty(),
        //         b => b.author,
        //         a => a,
        //         (b, a) => ({ b, a }))
        //     .filter(p => p.b == null)
        //     .map(p => ({ artist: p.a.name, album: p.b.name }))
        //     .toArray();
        // assert.ok(list.length > 0);
    });

    // from a in Query<ArtistEntity>().DefaultIfEmpty() join b in Query<AlbumEntity>().DefaultIfEmpty() on a equals b.Author select new { Artist = a.Name, Album = b.Name }
    // TODO(api): groupJoin/defaultIfEmpty
    test("FullOuterJoinEntity", { skip: true }, async () => {
        // const songsAlbum = await table(ArtistEntity).defaultIfEmpty()
        //     .join(
        //         table(AlbumEntity).defaultIfEmpty(),
        //         a => a,
        //         b => b.author,
        //         (a, b) => ({ artist: a.name, album: b.name }))
        //     .toArray();
        // assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>().DefaultIfEmpty() join b in Query<AlbumEntity>().DefaultIfEmpty() on a equals b.Author select new { Artist = a.Name, Album = b.Name, HasArtist = a != null, HasAlbum = b != null }
    // TODO(api): groupJoin/defaultIfEmpty
    test("FullOuterJoinEntityNotNull", { skip: true }, async () => {
        // const songsAlbum = await table(ArtistEntity).defaultIfEmpty()
        //     .join(
        //         table(AlbumEntity).defaultIfEmpty(),
        //         a => a,
        //         b => b.author,
        //         (a, b) => ({ artist: a.name, album: b.name, hasArtist: a != null, hasAlbum: b != null }))
        //     .toArray();
        // assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>() join b in Query<AlbumEntity>() on a equals b.Author into g select new { a.Name, Albums = (int?)g.Count() }
    // TODO(api): groupJoin/defaultIfEmpty
    test("JoinGroup", { skip: true }, async () => {
        // const songsAlbum = await table(ArtistEntity)
        //     .groupJoin(
        //         table(AlbumEntity),
        //         a => a,
        //         b => b.author,
        //         (a, g) => ({ name: a.name, albums: g.count() }))
        //     .toArray();
        // assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>() join b in Query<AlbumEntity>().DefaultIfEmpty() on a equals b.Author into g select new { a.Name, Albums = (int?)g.Count() }
    // TODO(api): groupJoin/defaultIfEmpty
    test("LeftOuterJoinGroup", { skip: true }, async () => {
        // const songsAlbum = await table(ArtistEntity)
        //     .groupJoin(
        //         table(AlbumEntity).defaultIfEmpty(),
        //         a => a,
        //         b => b.author,
        //         (a, g) => ({ name: a.name, albums: g.count() }))
        //     .toArray();
        // assert.ok(Array.isArray(songsAlbum));
    });

    // using (tr) { CreateTemporaryTable<MyTempView>(); Query<ArtistEntity>().Where(a => a.Name.StartsWith("M")).UnsafeInsertView(a => new MyTempView { Artist = a.ToLite() });
    //   from a join b in View<MyTempView>() on a.ToLite() equals b.Artist into g select a.ToLite(); Assert.True(all StartsWith("M")); Assert.Equal(View count, Where(StartsWith "M") count); tr.Commit(); }
    // TODO(api): groupJoin/defaultIfEmpty
    // TODO(api): Database.View<T>() / temporary tables / UnsafeInsertView
    test("LeftOuterMyView", { skip: true }, async () => {
        // const artists = await table(ArtistEntity)
        //     .groupJoin(
        //         view(MyTempView),
        //         a => a.toLite(),
        //         b => b.artist,
        //         (a, g) => a.toLite())
        //     .toArray();
        // assert.ok(artists.every(a => a.toString().startsWith("M")));
    });
});
