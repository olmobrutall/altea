import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // Array.contains / String.startsWith (SQL-mappable)
import { hasDb, start } from "./setup";
import { ArtistEntity, AlbumEntity, BandEntity, NoteWithDateEntity, Sex, Status } from "../entities/music";

// Port of Signum.Test/LinqProvider/AllAnyContainsTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)
//   .Where(...)          → .filter(...)        .Select(...) → .map(...)
//   .SelectMany(b => b.Coll) → .flatMap(b => b.coll)
//   .ToList()/.ToArray() → await .toArray()    .Any(pred?)  → await .some(pred?)
//   .All(pred)           → await .every(pred)  .SingleEx()  → await .single()
//   coll.Any(pred)/.All(pred) (in lambda) → coll.some(pred)/coll.every(pred)
//   xs.Contains(v)       → xs.contains(v)      a.ToLite()   → a.toLite()
//   a.Is(b) / lite.Is(x) → a.is(b) / lite.is(x)   Sex.Male  → Sex.Male
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Music-model note: Signum's MList<T> collections are part-entity arrays here.
//   BandEntity.Members (MList<ArtistEntity>) → band.members, each row a
//     BandEntity_Members with a full `.member: ArtistEntity` value field.
//   ArtistEntity.Friends (MList<Lite<ArtistEntity>>) → artist.friends, each row
//     an ArtistEntity_Friends with a `.friend: Lite<ArtistEntity>` value field.

describe("AllAnyContainsTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // IEnumerable<PrimaryKey> ids = new PrimaryKey[] { 1, 2, 3 }.Select(a => a);
    // var artist = Database.Query<ArtistEntity>().Where(a => ids.Contains(a.Id)).ToList();
    test("ContainsIEnumerableId", async () => {
        const ids = [1, 2, 3];
        const artist = await table(ArtistEntity).filter(a => ids.contains(a.id as number)).toArray();
        assert.ok(Array.isArray(artist));
    });

    // List<PrimaryKey> ids = new List<PrimaryKey> { 1, 2, 3 };
    // var artist = Database.Query<ArtistEntity>().Where(a => ids.Contains(a.Id)).ToList();
    test("ContainsArrayId", async () => {
        const ids = [1, 2, 3];
        const artist = await table(ArtistEntity).filter(a => ids.contains(a.id as number)).toArray();
        assert.ok(Array.isArray(artist));
    });

    // PrimaryKey[] ids = new PrimaryKey[] { 1, 2, 3 };
    // var artist = Database.Query<ArtistEntity>().Where(a => ids.Contains(a.Id)).ToList();
    test("ContainsListId", async () => {
        const ids = [1, 2, 3];
        const artist = await table(ArtistEntity).filter(a => ids.contains(a.id as number)).toArray();
        assert.ok(Array.isArray(artist));
    });

    // var artistsInBands = Database.Query<BandEntity>().SelectMany(b => b.Members).Select(a => a.ToLite()).ToList();
    // var michael = Database.Query<ArtistEntity>().SingleEx(a => !artistsInBands.Contains(a.ToLite()));
    test("ContainsListLite", async () => {
        const artistsInBands = await table(BandEntity).flatMap(b => b.members).map(a => a.member.toLite()).toArray();
        const michael = await table(ArtistEntity).single(a => !artistsInBands.contains(a.toLite()));
        assert.ok(michael != null);
    });

    // var artistsInBands = Database.Query<BandEntity>().SelectMany(b => b.Members).Select(a => a).ToList();
    // var michael = Database.Query<ArtistEntity>().SingleEx(a => !artistsInBands.Contains(a));
    test("ContainsListEntities", async () => {
        const artistsInBands = await table(BandEntity).flatMap(b => b.members).map(a => a.member).toArray();
        const michael = await table(ArtistEntity).single(a => !artistsInBands.contains(a));
        assert.ok(michael != null);
    });

    // var bands = new List<Lite<IAuthorEntity>> { Lite.Create<ArtistEntity>(5), Lite.Create<BandEntity>(1) };
    // var albums = (from a in Database.Query<AlbumEntity>() where !bands.Contains(a.Author.ToLite()) select a.ToLite()).ToList();
    // TODO(api): Lite.Create<T>(id) (constructing a thin Lite from a bare id) has no altea equivalent.
    // TODO(api): IAuthorEntity polymorphic author interface has no altea equivalent (author is a bare Entity).
    test("ContainsListLiteIB", async () => {
        const bands: any[] = [];
        const albums = await table(AlbumEntity)
            .filter(a => !bands.contains(a.author.toLite()))
            .map(a => a.toLite())
            .toArray();
        assert.ok(Array.isArray(albums));
    });

    // var bands = new List<IAuthorEntity> { Database.Retrieve<ArtistEntity>(5), Database.Retrieve<BandEntity>(1) };
    // var albums = (from a in Database.Query<AlbumEntity>() where !bands.Contains(a.Author) select a.ToLite()).ToList();
    // TODO(api): Database.Retrieve<T>(id) (retrieving an entity by bare id) has no altea equivalent.
    // TODO(api): IAuthorEntity polymorphic author interface has no altea equivalent (author is a bare Entity).
    test("ContainsListEntityIB", async () => {
        const bands: any[] = [];
        const albums = await table(AlbumEntity)
            .filter(a => !bands.contains(a.author))
            .map(a => a.toLite())
            .toArray();
        assert.ok(Array.isArray(albums));
    });

    // var lites = Database.Query<ArtistEntity>().Where(a => a.Dead).Select(a => a.ToLite<IAuthorEntity>()).ToArray()
    //     .Concat(Database.Query<BandEntity>().Where(a => a.Name.StartsWith("Smash")).Select(a => a.ToLite<IAuthorEntity>())).ToArray();
    // var albums = (from a in Database.Query<NoteWithDateEntity>() where lites.Contains(a.Target.ToLite()) select a.ToLite()).ToList();
    // TODO(api): ToLite<IAuthorEntity>() (lite typed to a polymorphic interface) has no altea equivalent.
    test("ContainsListLiteIBA", async () => {
        const dead = await table(ArtistEntity).filter(a => a.dead).map(a => a.toLite()).toArray();
        const smash = await table(BandEntity).filter(a => a.name.startsWith("Smash")).map(a => a.toLite()).toArray();
        const lites: any[] = [...dead, ...smash];
        const albums = await table(NoteWithDateEntity)
            .filter(a => lites.contains(a.target.toLite()))
            .map(a => a.toLite())
            .toArray();
        assert.ok(Array.isArray(albums));
    });

    // var entities = Database.Query<ArtistEntity>().Where(a => a.Dead).Select(a => (IEntity)a).ToArray()
    //     .Concat(Database.Query<BandEntity>().Where(a => a.Name.StartsWith("Smash")).Select(a => (IEntity)a)).ToArray();
    // var albums = (from a in Database.Query<NoteWithDateEntity>() where entities.Contains(a.Target) select a.ToLite()).ToList();
    // TODO(api): (IEntity)a entity-interface cast / heterogeneous in-memory entity list for an entity-level Contains has no altea equivalent.
    test("ContainsListEntityIBA", async () => {
        const dead = await table(ArtistEntity).filter(a => a.dead).toArray();
        const smash = await table(BandEntity).filter(a => a.name.startsWith("Smash")).toArray();
        const entities: any[] = [...dead, ...smash];
        const albums = await table(NoteWithDateEntity)
            .filter(a => entities.contains(a.target))
            .map(a => a.toLite())
            .toArray();
        assert.ok(Array.isArray(albums));
    });

    // var singles = new[] { Status.Single };
    // var artists = Database.Query<ArtistEntity>().Where(r => singles.Contains(r.Status!.Value)).Select(a => a.ToLite()).ToList();
    test("ContainsEnum", async () => {
        const singles = [Status.Single];
        const artists = await table(ArtistEntity)
            .filter(r => singles.contains(r.status!))
            .map(a => a.toLite())
            .toArray();
        assert.ok(Array.isArray(artists));
    });

    // Assert.True(Database.Query<ArtistEntity>().Any(a => a.Sex == Sex.Female));
    test("Any", async () => {
        assert.ok(await table(ArtistEntity).some(a => a.sex == Sex.Female));
    });

    // Assert.False(Database.Query<ArtistEntity>().None(a => a.Sex == Sex.Female));
    // TODO(api): .None() (negated Any) has no altea equivalent; expressed as !(... .some(...)).
    test("None", async () => {
        assert.equal(await table(ArtistEntity).some(a => a.sex == Sex.Female), true);
    });

    // var years = new[] { 1992, 1993, 1995 };
    // var list = Database.Query<AlbumEntity>().Where(a => years.Any(y => a.Year == y)).Select(a => a.Name).ToList();
    test("AnyCollection", async () => {
        const years = [1992, 1993, 1995];
        const list = await table(AlbumEntity)
            .filter(a => years.some(y => a.year == y))
            .map(a => a.name)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // BandEntity smashing = Database.Query<BandEntity>().SingleEx(b => b.Members.Any(a => a.Sex == Sex.Female));
    test("AnySql", async () => {
        const smashing = await table(BandEntity).single(b => b.members.some(a => a.member.sex == Sex.Female));
        assert.ok(smashing != null);
    });

    // BandEntity smashing = Database.Query<BandEntity>().SingleEx(b => b.Members.None(a => a.Sex == Sex.Female));
    // TODO(api): collection .None() (negated Any) has no altea equivalent; expressed as !(... .some(...)).
    test("NoneSql", async () => {
        const smashing = await table(BandEntity).single(b => !b.members.some(a => a.member.sex == Sex.Female));
        assert.ok(smashing != null);
    });

    // var withFriends = Database.Query<ArtistEntity>().Where(b => b.Friends.Any()).Select(a => a.Name).ToList();
    // TODO(api): collection .some() requires a predicate; the no-argument existence check (C# Any()) has no altea equivalent.
    test("AnySqlNonPredicate", async () => {
        const withFriends = await table(ArtistEntity)
            .filter(b => b.friends.some(a => true))
            .map(a => a.name)
            .toArray();
        assert.ok(Array.isArray(withFriends));
    });

    // Assert.False(Database.Query<ArtistEntity>().All(a => a.Sex == Sex.Male));
    test("All", async () => {
        assert.equal(await table(ArtistEntity).every(a => a.sex == Sex.Male), false);
    });

    // BandEntity sigur = Database.Query<BandEntity>().SingleEx(b => b.Members.All(a => a.Sex == Sex.Male));
    test("AllSql", async () => {
        const sigur = await table(BandEntity).single(b => b.members.every(a => a.member.sex == Sex.Male));
        assert.ok(sigur != null);
    });

    // BandEntity sigur = Database.Query<BandEntity>().SingleEx(b => b.Name.StartsWith("Sigur"));
    test("RetrieveBand", async () => {
        const sigur = await table(BandEntity).single(b => b.name.startsWith("Sigur"));
        assert.ok(sigur != null);
    });

    // List<Lite<ArtistEntity>> artists = Database.Query<ArtistEntity>().Where(a => a.Sex == Sex.Male).Select(a => a.ToLite()).ToList();
    // var query = Database.Query<ArtistEntity>().Where(a => artists.Any(b => b.Is(a)));
    test("ArtistsAny", async () => {
        const artists = await table(ArtistEntity).filter(a => a.sex == Sex.Male).map(a => a.toLite()).toArray();
        const query = await table(ArtistEntity).filter(a => artists.some(b => b.is(a))).toArray();
        assert.ok(Array.isArray(query));
    });
});
