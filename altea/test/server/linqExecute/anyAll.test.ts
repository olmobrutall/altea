import { test, beforeAll, describe } from "vitest";
import assert from "node:assert/strict";
import { table } from "@altea/altea/server/table";
import "@altea/altea/data/globals"; // Array.contains / String.startsWith (SQL-mappable)
import { hasDb, start } from "../setup";
import { ArtistEntity, AlbumEntity, BandEntity, Sex } from "../../data/music";

// Port of Signum.Test/LinqProvider/AllAnyContainsTest.cs — the Any / None / All half; the rest is in
// contains.test.ts. Signum keeps all twenty in ONE class, and the describe here deliberately keeps that
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

    // Assert.True(Database.Query<ArtistEntity>().Any(a => a.Sex == Sex.Female));
    test("Any", async () => {
        assert.ok(await table(ArtistEntity).some(a => a.sex == Sex.Female));
    });

    // Assert.False(Database.Query<ArtistEntity>().None(a => a.Sex == Sex.Female));
    // altea has no .None(); the negated-Any is the idiomatic !(await ... .some(...)).
    test("None", async () => {
        assert.equal(!(await table(ArtistEntity).some(a => a.sex == Sex.Female)), false);
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
    // altea has no collection .None(); the negated existence check is the idiomatic !coll.some(...).
    test("NoneSql", async () => {
        const smashing = await table(BandEntity).single(b => !b.members.some(a => a.member.sex == Sex.Female));
        assert.ok(smashing != null);
        assert.ok(smashing.members.every(a => a.member.sex != Sex.Female));
    });

    // var withFriends = Database.Query<ArtistEntity>().Where(b => b.Friends.Any()).Select(a => a.Name).ToList();
    // C#'s arg-less Any() (existence) is expressed in altea as .some(a => true) — an always-true predicate.
    test("AnySqlNonPredicate", async () => {
        const withFriends = await table(ArtistEntity)
            .filter(b => b.friends.some(a => true))
            .map(a => a.name)
            .toArray();
        assert.ok(withFriends.length > 0);
        assert.ok(withFriends.every(n => n != null));
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
