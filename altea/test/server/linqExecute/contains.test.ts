import { test, beforeAll, describe } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import { retrieve } from "@altea/altea/server/Database";
import "@altea/altea/data/globals"; // Array.contains / String.startsWith (SQL-mappable)
import { hasDb, start } from "../setup";
import { ArtistEntity, AlbumEntity, BandEntity, NoteWithDateEntity, Status } from "../../data/music";

// Port of Signum.Test/LinqProvider/AllAnyContainsTest.cs — the Contains half; the rest is in
// anyAll.test.ts. Signum keeps all twenty in ONE class, and the describe here deliberately keeps that
// class's name in BOTH files: setup.ts's SQL_DUMP writes `<describe>.<test>.<pg|ss>.sql`, and those files
// are cross-checked against the C# suite's own dump, which names them AllAnyContainsTest.*. Renaming the
// describe to match the file would silently break that 1:1 correspondence.
// C# → altea idiom:
//   Database.Query<T>()  → table(T)
//   .Where(...)          → .filter(...)        .Select(...) → .map(...)
//   .SelectMany(b => b.Coll) → .flatMap(b => b.coll)
//   .ToList()/.ToArray() → await .toArray()    .Any(pred?)  → await .some(pred?)
//   .All(pred)           → await .every(pred)  .SingleEx()  → await .single()
//   coll.Any(pred)/.All(pred) (in lambda) → coll.some(pred)/coll.every(pred)
//   xs.Contains(v)       → xs.includes(v)      a.ToLite()   → a.toLite()
//   a.Is(b) / lite.Is(x) → a.is(b) / lite.is(x)   Sex.Male  → Sex.Male
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Music-model note: Signum's MList<T> collections are part-entity arrays here.
//   BandEntity.Members (MList<ArtistEntity>) → band.members, each row a
//     BandEntity_Member with a full `.member: ArtistEntity` value field.
//   ArtistEntity.Friends (MList<Lite<ArtistEntity>>) → artist.friends, each row
//     an ArtistEntity_Friend with a `.friend: Lite<ArtistEntity>` value field.

describe.skipIf(!hasDb)("AllAnyContainsTest", () => {
    beforeAll(async () => { await start(); });

    // IEnumerable<PrimaryKey> ids = new PrimaryKey[] { 1, 2, 3 }.Select(a => a);
    // var artist = Database.Query<ArtistEntity>().Where(a => ids.Contains(a.Id)).ToList();
    test("ContainsIEnumerableId", async () => {
        const ids = [1, 2, 3];
        const artist = await table(ArtistEntity).filter(a => ids.includes(a.id as number)).toArray();
        assert.ok(Array.isArray(artist));
    });

    // List<PrimaryKey> ids = new List<PrimaryKey> { 1, 2, 3 };
    // var artist = Database.Query<ArtistEntity>().Where(a => ids.Contains(a.Id)).ToList();
    test("ContainsArrayId", async () => {
        const ids = [1, 2, 3];
        const artist = await table(ArtistEntity).filter(a => ids.includes(a.id as number)).toArray();
        assert.ok(Array.isArray(artist));
    });

    // PrimaryKey[] ids = new PrimaryKey[] { 1, 2, 3 };
    // var artist = Database.Query<ArtistEntity>().Where(a => ids.Contains(a.Id)).ToList();
    test("ContainsListId", async () => {
        const ids = [1, 2, 3];
        const artist = await table(ArtistEntity).filter(a => ids.includes(a.id as number)).toArray();
        assert.ok(Array.isArray(artist));
    });

    // var artistsInBands = Database.Query<BandEntity>().SelectMany(b => b.Members).Select(a => a.ToLite()).ToList();
    // var michael = Database.Query<ArtistEntity>().SingleEx(a => !artistsInBands.Contains(a.ToLite()));
    test("ContainsListLite", async () => {
        const artistsInBands = await table(BandEntity).flatMap(b => b.members).map(a => a.member.toLite()).toArray();
        const michael = await table(ArtistEntity).single(a => !artistsInBands.includes(a.toLite()));
        assert.ok(michael != null);
    });

    // var artistsInBands = Database.Query<BandEntity>().SelectMany(b => b.Members).Select(a => a).ToList();
    // var michael = Database.Query<ArtistEntity>().SingleEx(a => !artistsInBands.Contains(a));
    test("ContainsListEntities", async () => {
        const artistsInBands = await table(BandEntity).flatMap(b => b.members).map(a => a.member).toArray();
        const michael = await table(ArtistEntity).single(a => !artistsInBands.includes(a));
        assert.ok(michael != null);
    });

    // var bands = new List<Lite<IAuthorEntity>> { Lite.Create<ArtistEntity>(5), Lite.Create<BandEntity>(1) };
    // var albums = (from a in Database.Query<AlbumEntity>() where !bands.Contains(a.Author.ToLite()) select a.ToLite()).ToList();
    // Not ported: Lite.Create<T>(id) (thin Lite from a bare id) and the IAuthorEntity polymorphic
    // author interface — altea's author is a bare Entity. With an empty exclusion list the
    // in-memory-list Contains still exercises (matches nothing), so every album is returned.
    test("ContainsListLiteIB", async () => {
        const bands: any[] = [];
        const albums = await table(AlbumEntity)
            .filter(a => !bands.includes(a.author.toLite()))
            .map(a => a.toLite())
            .toArray();
        const total = await table(AlbumEntity).count();
        assert.equal(albums.length, total);
        assert.ok(albums.every(l => l.entityType === AlbumEntity));
    });

    // var bands = new List<IAuthorEntity> { Database.Retrieve<ArtistEntity>(5), Database.Retrieve<BandEntity>(1) };
    // var albums = (from a in Database.Query<AlbumEntity>() where !bands.Contains(a.Author) select a.ToLite()).ToList();
    // `bands` is a heterogeneous in-memory entity list (an artist + a band), fetched by id
    // via Database.Retrieve (altea's `retrieve`). Ids are read from the DB first so the test
    // doesn't depend on loader ordering.
    test("ContainsListEntityIB", async () => {
        const artist = await table(ArtistEntity).orderBy(a => a.name).first();
        const band = await table(BandEntity).orderBy(a => a.name).first();
        const bands: any[] = [await retrieve(ArtistEntity, artist.id), await retrieve(BandEntity, band.id)];
        const albums = await table(AlbumEntity)
            .filter(a => !bands.includes(a.author))
            .map(a => a.toLite())
            .toArray();
        assert.ok(Array.isArray(albums));
    });

    // var lites = Database.Query<ArtistEntity>().Where(a => a.Dead).Select(a => a.ToLite<IAuthorEntity>()).ToArray()
    //     .Concat(Database.Query<BandEntity>().Where(a => a.Name.StartsWith("Smash")).Select(a => a.ToLite<IAuthorEntity>())).ToArray();
    // var albums = (from a in Database.Query<NoteWithDateEntity>() where lites.Contains(a.Target.ToLite()) select a.ToLite()).ToList();
    // Not ported: ToLite<IAuthorEntity>() (a lite typed to a polymorphic interface). The lites are
    // built as bare (Artist/Band) lites into an untyped list — the heterogeneous in-memory-list
    // Contains against a polymorphic Target still runs.
    test("ContainsListLiteIBA", async () => {
        const dead = await table(ArtistEntity).filter(a => a.dead).map(a => a.toLite()).toArray();
        const smash = await table(BandEntity).filter(a => a.name.startsWith("Smash")).map(a => a.toLite()).toArray();
        const lites: any[] = [...dead, ...smash];
        const albums = await table(NoteWithDateEntity)
            .filter(a => lites.includes(a.target.toLite()))
            .map(a => a.toLite())
            .toArray();
        assert.ok(albums.every(l => l.entityType === NoteWithDateEntity));
    });

    // var entities = Database.Query<ArtistEntity>().Where(a => a.Dead).Select(a => (IEntity)a).ToArray()
    //     .Concat(Database.Query<BandEntity>().Where(a => a.Name.StartsWith("Smash")).Select(a => (IEntity)a)).ToArray();
    // var albums = (from a in Database.Query<NoteWithDateEntity>() where entities.Contains(a.Target) select a.ToLite()).ToList();
    // Not ported: the (IEntity)a entity-interface cast. The heterogeneous in-memory entity list
    // (an artist + a band) is built untyped and the entity-level Contains against the polymorphic
    // Target still runs.
    test("ContainsListEntityIBA", async () => {
        const dead = await table(ArtistEntity).filter(a => a.dead).toArray();
        const smash = await table(BandEntity).filter(a => a.name.startsWith("Smash")).toArray();
        const entities: any[] = [...dead, ...smash];
        const albums = await table(NoteWithDateEntity)
            .filter(a => entities.includes(a.target))
            .map(a => a.toLite())
            .toArray();
        assert.ok(albums.every(l => l.entityType === NoteWithDateEntity));
    });

    // var singles = new[] { Status.Single };
    // var artists = Database.Query<ArtistEntity>().Where(r => singles.Contains(r.Status!.Value)).Select(a => a.ToLite()).ToList();
    test("ContainsEnum", async () => {
        const singles = [Status.Single];
        const artists = await table(ArtistEntity)
            .filter(r => singles.includes(r.status!))
            .map(a => a.toLite())
            .toArray();
        assert.ok(Array.isArray(artists));
    });
});
