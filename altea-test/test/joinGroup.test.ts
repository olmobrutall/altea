import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.contains / startsWith / … (SQL-mappable)
import { hasDb, start, txTest } from "./setup";
import { view } from "@altea/altea/logic/table";
import { ArtistEntity, AlbumEntity, MyTempView } from "../entities/music";
import { Administrator } from "@altea/altea/logic/Administrator";

// Port of Signum.Test/LinqProvider/JoinGroupTest.cs. C# → altea idiom:
//   Database.Query<T>()           → table(T)
//   .Where(...)                   → .filter(...)        .Select(...) → .map(...)
//   .SelectMany(...)              → .flatMap(...)        .ToList()    → await .toArray()
//   from a join b on a.K equals b.K select res
//                                 → table(A).innerJoin(table(B), a => a.k, b => b.k, (a, b) => res)
//   new { a.Name, X = … }         → ({ name: a.name, x: … }) (camelCase)
//   a == b.Author / a equals b.Author (entity key) → a.is(b.author)
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Outer joins use the explicit relational operators innerJoin / leftJoin / rightJoin
// / fullJoin (altea has no `.DefaultIfEmpty()` marker). altea names the join by which
// side is row-preserving (SQL convention): leftJoin keeps the outer (receiver),
// rightJoin the inner. Signum names by which source carries DefaultIfEmpty, so its
// "LeftOuter…" (DefaultIfEmpty on the outer source, inner preserved) maps to altea's
// `rightJoin`, and vice-versa — the test NAMES are kept from the C# port even where
// the altea operator reads the other way. altea has no `groupJoin` (Signum's `into g`);
// the C# JoinGroup / LeftOuterJoinGroup tests, which only exercised it, are dropped, and
// LeftOuterMyView (a temp-view read-back) uses a `leftJoin` instead. The temp-view test
// additionally needs Database.View / temporary tables / UnsafeInsertView.

describe("JoinGroupTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // from a in Query<AlbumEntity>() join b in Query<AlbumEntity>().SelectMany(a => a.Songs) on a.Name equals b.Name select new { a.Name, Label = a.Label.Name }
    test("Join", async () => {
        const songsAlbum = await table(AlbumEntity)
            .innerJoin(
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
            .innerJoin(
                table(AlbumEntity),
                a => a,
                b => b!.author,
                (a, b) => ({ artist: a!.name, album: b!.name }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // from a1 join a2 on a1.Label equals a2.Label join a3 on a2.Label equals a3.Label select new { Name1 = a1.Name, Name2 = a2.Name, Name3 = a3.Name }
    test("JoinEntityTwice", async () => {
        const albums = await table(AlbumEntity)
            .innerJoin(
                table(AlbumEntity),
                a1 => a1.label,
                a2 => a2.label,
                (a1, a2) => ({ name1: a1.name, name2: a2.name }))
            .innerJoin(
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
            .innerJoin(
                table(AlbumEntity),
                a => a.year,
                a => a.year,
                (a1, a2) => a1.label.name + " " + a2.label.name)
            .toArray();
        assert.ok(Array.isArray(labels));
    });

    // from a in Query<ArtistEntity>().DefaultIfEmpty() join b in Query<AlbumEntity>() on a equals b.Author select new { Artist = a.Name, Album = b.Name }
    // C#'s `A.DefaultIfEmpty()` outer source (inner preserved) → altea's `rightJoin`.
    test("LeftOuterJoinEntity", async () => {
        const songsAlbum = await table(ArtistEntity)
            .rightJoin(
                table(AlbumEntity),
                a => a,
                b => b.author,
                (a, b) => ({ artist: a!.name, album: b!.name }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>().DefaultIfEmpty() join b in Query<AlbumEntity>() on a equals b.Author select new { Artist = a.Name, Album = b.Name, HasArtist = a != null }
    test("LeftOuterJoinEntityNotNull", async () => {
        const songsAlbum = await table(ArtistEntity)
            .rightJoin(
                table(AlbumEntity),
                a => a,
                b => b.author,
                (a, b) => ({ artist: a!.name, album: b!.name, hasArtist: a != null }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>() join b in Query<AlbumEntity>().DefaultIfEmpty() on a equals b.Author select new { Artist = a.Name, Album = b.Name }
    test("RightOuterJoinEntity", async () => {
        const songsAlbum = await table(ArtistEntity)
            .leftJoin(
                table(AlbumEntity),
                a => a,
                b => b.author,
                (a, b) => ({ artist: a!.name, album: b!.name }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>() join b in Query<AlbumEntity>().DefaultIfEmpty() on a equals b.Author select new { Artist = a.Name, Album = b.Name, HasArtist = b != null }
    test("RightOuterJoinEntityNotNull", async () => {
        const songsAlbum = await table(ArtistEntity)
            .leftJoin(
                table(AlbumEntity),
                a => a,
                b => b.author,
                (a, b) => ({ artist: a!.name, album: b!.name, hasArtist: b != null }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // from b in Query<AlbumEntity>().Where(b => b.Year == 1993).DefaultIfEmpty() join a in Query<ArtistEntity>().DefaultIfEmpty() on b.Author equals a select new { Artist = a?.Name, Album = b?.Name }
    test("FullOuterJoinWithFilter", async () => {
        const list = await table(AlbumEntity).filter(b => b.year == 1993)
            .fullJoin(
                table(ArtistEntity),
                b => b!.author,
                a => a,
                (b, a) => ({ artist: a == null ? null : a.name, album: b == null ? null : b.name }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from a in Query<ArtistEntity>().DefaultIfEmpty() join b in Query<AlbumEntity>().DefaultIfEmpty() on a equals b.Author select new { Artist = a.Name, Album = b.Name }
    test("FullOuterJoinEntity", async () => {
        const songsAlbum = await table(ArtistEntity)
            .fullJoin(
                table(AlbumEntity),
                a => a,
                b => b!.author,
                (a, b) => ({ artist: a!.name, album: b!.name }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // from a in Query<ArtistEntity>().DefaultIfEmpty() join b in Query<AlbumEntity>().DefaultIfEmpty() on a equals b.Author select new { Artist = a.Name, Album = b.Name, HasArtist = a != null, HasAlbum = b != null }
    test("FullOuterJoinEntityNotNull", async () => {
        const songsAlbum = await table(ArtistEntity)
            .fullJoin(
                table(AlbumEntity),
                a => a,
                b => b!.author,
                (a, b) => ({ artist: a!.name, album: b!.name, hasArtist: a != null, hasAlbum: b != null }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // using (tr) { CreateTemporaryTable<MyTempView>(); Query<ArtistEntity>().Where(a => a.Name.StartsWith("M")).UnsafeInsertView(a => new MyTempView { Artist = a.ToLite() });
    //   from b in View<MyTempView>() join a in Query<ArtistEntity>() on b.Artist equals a.ToLite() select a.ToLite();
    //   Assert.True(all StartsWith("M")); Assert.Equal(View count, Where(StartsWith "M") count); tr.Commit(); }
    // The temp table + UnsafeInsertView populate the view (only "M" artists), then the join
    // reads it back. The C# uses a groupJoin (`into g`), but altea has no groupJoin; the
    // equivalent here keeps the view as the row-preserving (outer) side of a `leftJoin` to the
    // artists — every view row matches its artist, so the result is exactly the "M" artists.
    // Runs inside a Transaction (txTest) so the CREATE, INSERT and SELECT share one pinned
    // connection — a SQL Server temp table is connection-scoped.
    txTest("LeftOuterMyView", async () => {
        await Administrator.createTemporaryTable(MyTempView);
        await table(ArtistEntity).filter(a => a.name.startsWith("M"))
            .executeInsert(MyTempView, a => ({ artist: a.toLite() }));

        const artists = await view(MyTempView)
            .leftJoin(
                table(ArtistEntity),
                b => b.artist,
                a => a.toLite(),
                (b, a) => a!.toLite())
            .toArray();
        assert.ok(artists.every(a => a.toString().startsWith("M")));
        assert.equal(await view(MyTempView).count(), await table(ArtistEntity).filter(a => a.name.startsWith("M")).count());
    });
});
