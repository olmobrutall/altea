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
//     BandEntity_Members with a `.member: Lite<ArtistEntity>` value field.
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
            .map(a => ({ artist: a.member }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().SelectMany((b, i) => b.Members.Select(m => new { Artist = m.ToLite(), i })).ToList();
    // TODO(api): flatMap index/result-selector overload — altea flatMap takes ONE collection selector only.
    test("SelectManyIndex", { skip: true }, async () => {
        // const list = await table(BandEntity)
        //     .flatMap((b, i) => b.members.map(m => ({ artist: m.member, i })))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().SelectMany(b => b.Members, (b, a) => new { Artist = a.ToLite(), Band = b.ToLite() }).ToList();
    // TODO(api): flatMap index/result-selector overload — altea flatMap takes ONE collection selector only.
    test("SelectMany2", { skip: true }, async () => {
        // const list = await table(BandEntity)
        //     .flatMap(b => b.members, (b, a) => ({ artist: a.member, band: b.toLite() }))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().SelectMany((b, i) => b.Members.Select(m => new { Artist = m.ToLite(), i }), (b, a) => new { a.Artist, a.i, Band = b.ToLite() }).ToList();
    // TODO(api): flatMap index/result-selector overload — altea flatMap takes ONE collection selector only.
    test("SelectMany2Index", { skip: true }, async () => {
        // const list = await table(BandEntity)
        //     .flatMap((b, i) => b.members.map(m => ({ artist: m.member, i })),
        //              (b, a) => ({ artist: a.artist, i: a.i, band: b.toLite() }))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().SelectMany(b => b.Members.Where(a => a.IsMale)).Select(a => new { Artist = a.ToLite() }).ToList();
    test("SelectManyWhere1", async () => {
        const list = await table(BandEntity)
            .flatMap(b => b.members.filter(a => a.member.entity.sex == Sex.Male))
            .map(a => ({ artist: a.member }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().Where(b => b.LastAward != null).SelectMany(b => b.Members.Where(a => a.IsMale)).Select(a => a.ToLite()).ToList();
    test("SelectManyWhere2", async () => {
        const list = await table(BandEntity)
            .filter(b => b.lastAward != null)
            .flatMap(b => b.members.filter(a => a.member.entity.sex == Sex.Male))
            .map(a => a.member)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().SelectMany(a => a.Songs, (a, s) => s.Name).ToList();
    // TODO(api): flatMap index/result-selector overload — altea flatMap takes ONE collection selector only.
    test("SelectManyEmbedded", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .flatMap(a => a.songs, (a, s) => s.name)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Database.Query<ArtistEntity>().SelectMany(a => a.Friends).ToList();
    test("SelectManyLazy", async () => {
        const list = await table(ArtistEntity)
            .flatMap(a => a.friends)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().SelectMany(b => b.Members.DefaultIfEmpty()).Select(a => new { Artist = a!.ToLite() }).ToList();
    // TODO(api): DefaultIfEmpty (left/outer SelectMany) has no altea equivalent.
    test("SelectManyDefaultIfEmpty", { skip: true }, async () => {
        const list = await table(BandEntity)
            .flatMap(b => b.members.defaultIfEmpty())
            .map(a => ({ artist: a!.member }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from a1 in Database.Query<ArtistEntity>() from a in a1.Friends select new { Artist = a1.ToLite(), Friend = a }
    // TODO(api): query-syntax SelectMany that projects over BOTH the outer and the collection element (flatMap exposes only the collection element, not the outer entity).
    test("SelectManyOverload", { skip: true }, async () => {
        const list = await table(ArtistEntity)
            .flatMap(a1 => a1.friends.map(a => ({ artist: a1.toLite(), friend: a.friend })))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from a1 in Database.Query<ArtistEntity>() from a in a1.Friends.DefaultIfEmpty() select new { Artist = a1.ToLite(), Friend = a }
    // TODO(api): DefaultIfEmpty (left/outer SelectMany) has no altea equivalent.
    // TODO(api): query-syntax SelectMany that projects over BOTH the outer and the collection element (flatMap exposes only the collection element, not the outer entity).
    test("SelectManyDefaultIfEmptyTwo", { skip: true }, async () => {
        const list = await table(ArtistEntity)
            .flatMap(a1 => a1.friends.defaultIfEmpty().map(a => ({ artist: a1.toLite(), friend: a.friend })))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from a1 in Database.Query<ArtistEntity>() from a in a1.Friends.DefaultIfEmpty() select new { Artist = a1.ToLite(), Friend = a, HasFriend = a != null }
    // TODO(api): DefaultIfEmpty (left/outer SelectMany) has no altea equivalent.
    // TODO(api): query-syntax SelectMany that projects over BOTH the outer and the collection element (flatMap exposes only the collection element, not the outer entity).
    test("SelectManyDefaultIfEmptyNotNull", { skip: true }, async () => {
        const list = await table(ArtistEntity)
            .flatMap(a1 => a1.friends.defaultIfEmpty().map(a => ({ artist: a1.toLite(), friend: a.friend, hasFriend: a != null })))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from b in Database.Query<BandEntity>() from a in b.Members
    //   select new { MaxAlbum = Database.Query<ArtistEntity>().Where(n => n.Friends.Contains(a.ToLite())).Max(n => (int?)n.Id) }
    // TODO(api): query-syntax SelectMany that projects over BOTH the outer and the collection element (flatMap exposes only the collection element, not the outer entity).
    // TODO(api): collection.contains over a subquery (n.friends.contains(lite)) inside a correlated subquery.
    // TODO(api): entity cast / nullable-int projection ((int?)n.id).
    test("SelectManySingleJoinExpander", { skip: true }, async () => {
        const list = await table(BandEntity)
            .flatMap(b => b.members.map(a => ({
                maxAlbum: table(ArtistEntity)
                    .filter(n => n.friends.some(f => f.friend.is(a.member)))
                    .max(n => (n.id as number | null)),
            })))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from b in Database.Query<BandEntity>() join mle in Database.MListQuery((BandEntity b) => b.Members) on b equals mle.Parent
    //   select new { MaxAlbum = Database.Query<ArtistEntity>().Where(n => n.Friends.Contains(mle.Element.ToLite())).Max(n => (int?)n.Id) }
    // TODO(api): Database.MListQuery (querying MList link rows directly as a standalone source).
    // TODO(api): collection.contains over a subquery (n.friends.contains(lite)) inside a correlated subquery.
    // TODO(api): entity cast / nullable-int projection ((int?)n.id).
    // TODO(api): join key mismatch — `b => b` yields BandEntity but `m => m.band` yields Lite<BandEntity>; navigating the lite to the full entity inside a join key is a gap.
    test("JoinSingleJoinExpander", { skip: true }, async () => {
        // const mle = table(BandEntity_Members);
        // const list = await table(BandEntity)
        //     .join(mle, b => b, m => m.band, (b, m) => ({
        //         maxAlbum: table(ArtistEntity)
        //             .filter(n => n.friends.some(f => f.friend.is(m.member)))
        //             .max(n => (n.id as number | null)),
        //     }))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });
});
