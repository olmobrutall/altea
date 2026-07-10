import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import { ArtistEntity, AlbumEntity, BandEntity, BandEntity_Members, Sex } from "../entities/music";

// Port of Signum.Test/LinqProvider/SelectManyTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)
//   .SelectMany(b => b.Coll)         → .flatMap(b => b.coll)
//   .Select(...)         → .map(...)            .Where(...) → .filter(...)
//   .ToList()/.ToArray() → await .toArray()     a.ToLite()  → a.toLite()
//   new { X = .. }       → ({ x: .. })          Tuple       → object literal
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Music-model note: Signum's MList<T> collections are part-entity arrays here.
//   BandEntity.Members (MList<ArtistEntity>) → band.members, each row a
//     BandEntity_Members with a full `.member: ArtistEntity` value field.
//   ArtistEntity.Friends (MList<Lite<ArtistEntity>>) → artist.friends, each row
//     an ArtistEntity_Friends with a `.friend: Lite<ArtistEntity>` value field.
//   AlbumEntity.Songs (MList<SongEmbedded>) → album.songs, each an
//     AlbumEntity_Songs with the embedded fields flattened in (e.g. `.name`).

describe("SelectManyTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<BandEntity>().SelectMany(b => b.Members).Select(a => new { Artist = a.ToLite() }).ToList();
    test("SelectMany", async () => {
        const list = await table(BandEntity)
            .flatMap(b => b.members)
            .map(a => ({ artist: a.member.toLite() }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().SelectMany((b, i) => b.Members.Select(m => new { Artist = m.ToLite(), i })).ToList();
    // altea's flatMap takes ONE collection selector; the C# result-selector is folded into
    // the collection map. The `(b, i)` index overload binds `i` to a ROW_NUMBER column.
    test("SelectManyIndex", async () => {
        const list = await table(BandEntity)
            .flatMap((b, i) => b.members.map(m => ({ artist: m.member.toLite(), i })))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().SelectMany(b => b.Members, (b, a) => new { Artist = a.ToLite(), Band = b.ToLite() }).ToList();
    // altea's flatMap takes ONE collection selector; the C# result-selector is expressed by
    // projecting the outer entity inside the collection map (b captured in the inner map).
    test("SelectMany2", async () => {
        const list = await table(BandEntity)
            .flatMap(b => b.members.map(a => ({ artist: a.member.toLite(), band: b.toLite() })))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().SelectMany((b, i) => b.Members.Select(m => new { Artist = m.ToLite(), i }), (b, a) => new { a.Artist, a.i, Band = b.ToLite() }).ToList();
    // Single collection selector: the outer entity (b, with its index i) is projected inside
    // the collection map, folding the C# result-selector into it.
    test("SelectMany2Index", async () => {
        const list = await table(BandEntity)
            .flatMap((b, i) => b.members.map(m => ({ artist: m.member.toLite(), i, band: b.toLite() })))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().SelectMany(b => b.Members.Where(a => a.IsMale)).Select(a => new { Artist = a.ToLite() }).ToList();
    test("SelectManyWhere1", async () => {
        const list = await table(BandEntity)
            .flatMap(b => b.members.filter(a => a.member.sex == Sex.Male))
            .map(a => ({ artist: a.member.toLite() }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().Where(b => b.LastAward != null).SelectMany(b => b.Members.Where(a => a.IsMale)).Select(a => a.ToLite()).ToList();
    test("SelectManyWhere2", async () => {
        const list = await table(BandEntity)
            .filter(b => b.lastAward != null)
            .flatMap(b => b.members.filter(a => a.member.sex == Sex.Male))
            .map(a => a.member.toLite())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().SelectMany(a => a.Songs, (a, s) => s.Name).ToList();
    // Single collection selector: the result-selector `s.Name` becomes the collection map.
    test("SelectManyEmbedded", async () => {
        const list = await table(AlbumEntity)
            .flatMap(a => a.songs.map(s => s.name))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<ArtistEntity>().SelectMany(a => a.Friends).ToList();
    test("SelectManyLazy", async () => {
        const list = await table(ArtistEntity)
            .flatMap(a => a.friends)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().SelectMany(b => b.Members.DefaultIfEmpty()).Select(a => new { Artist = a!.ToLite() }).ToList();
    test("SelectManyDefaultIfEmpty", async () => {
        const list = await table(BandEntity)
            .flatMap(b => b.members.defaultIfEmpty())
            .map(a => ({ artist: a!.member.toLite() }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from a1 in Database.Query<ArtistEntity>() from a in a1.Friends select new { Artist = a1.ToLite(), Friend = a }
    // Projecting over BOTH the outer entity and the collection element works: the outer `a1`
    // is captured inside the collection map, folding the C# result-selector into flatMap.
    test("SelectManyOverload", async () => {
        const list = await table(ArtistEntity)
            .flatMap(a1 => a1.friends.map(a => ({ artist: a1.toLite(), friend: a.friend })))
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(x => x.artist.entityType === ArtistEntity && x.friend != null));
    });

    // from a1 in Database.Query<ArtistEntity>() from a in a1.Friends.DefaultIfEmpty() select new { Artist = a1.ToLite(), Friend = a }
    test("SelectManyDefaultIfEmptyTwo", async () => {
        const list = await table(ArtistEntity)
            .flatMap(a1 => a1.friends.map(a => ({ artist: a1.toLite(), friend: a.friend })).defaultIfEmpty())
            .toArray();
        // DefaultIfEmpty keeps friendless artists (a null row), so the list is longer than the
        // inner-only projection and contains at least one null-friend row.
        assert.ok(list.length > 0);
        assert.ok(list.some(x => x == null || x.friend == null));
    });

    // from a1 in Database.Query<ArtistEntity>() from a in a1.Friends.DefaultIfEmpty() select new { Artist = a1.ToLite(), Friend = a, HasFriend = a != null }
    test("SelectManyDefaultIfEmptyNotNull", async () => {
        const list = await table(ArtistEntity)
            .flatMap(a1 => a1.friends.map(a => ({ artist: a1.toLite(), friend: a.friend, hasFriend: a != null })).defaultIfEmpty())
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.some(x => x == null || !x.hasFriend));
    });

    // from b in Database.Query<BandEntity>() from a in b.Members
    //   select new { MaxAlbum = Database.Query<ArtistEntity>().Where(n => n.Friends.Contains(a.ToLite())).Max(n => (int?)n.Id) }
    // A correlated subquery whose Where uses a friends-collection existence check (contains over
    // the outer flatMap element) and a nullable-int MAX projection all run in altea.
    test("SelectManySingleJoinExpander", async () => {
        const list = await table(BandEntity)
            .flatMap(b => b.members.map(a => ({
                maxAlbum: table(ArtistEntity)
                    .filter(n => n.friends.some(f => f.friend.is(a.member.toLite())))
                    .max(n => (n.id as number | null)),
            })))
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(x => x.maxAlbum === null || typeof x.maxAlbum === "number"));
    });

    // from b in Database.Query<BandEntity>() join mle in Database.MListQuery((BandEntity b) => b.Members) on b equals mle.Parent
    //   select new { MaxAlbum = Database.Query<ArtistEntity>().Where(n => n.Friends.Contains(mle.Element.ToLite())).Max(n => (int?)n.Id) }
    // Database.MListQuery is just `table(BandEntity_Members)`, and the join key is aligned by
    // taking `b.toLite()` so both sides are Lite<BandEntity> (matching `m.band` — SmartEqualizer
    // compares lite==lite). The correlated-subquery contains + nullable-int MAX resolve too.
    test("JoinSingleJoinExpander", async () => {
        const mle = table(BandEntity_Members);
        const list = await table(BandEntity)
            .innerJoin(mle, b => b.toLite(), m => m.band, (b, m) => ({
                maxAlbum: table(ArtistEntity)
                    .filter(n => n.friends.some(f => f.friend.is(m.member)))
                    .max(n => (n.id as number | null)),
            }))
            .toArray();
        assert.ok(Array.isArray(list));
    });
});
