import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.contains / Lite.contains / … (SQL-mappable)
import { hasDb, start } from "./setup";
import { ArtistEntity, BandEntity, Sex } from "../entities/music";

// Port of Signum.Test/LinqProvider/InDBTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Where(...) → .filter(...)
//   .Select(...)         → .map(...)           .SingleEx()/.Single() → await .single()
//   .ToList()/.ToArray() → await .toArray()    a.Sex == Sex.Female → a.sex == Sex.Female
//   a.ToLite()           → a.toLite()          a.Friends.Contains(x) → a.friends.contains(x)
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// EVERY test in this file depends on the entity→query bridge `entity.InDB(selector)`
// / `Lite.InDB()` (re-query a single in-memory entity against the database). altea
// has NO API for this yet, so every test is `{ skip: true }`, its body is the most
// natural altea form (commented out where it references the missing bridge), and it
// is flagged `// TODO(api): InDB bridge`. A few tests also touch further gaps
// (AutoExpressionField IsMale, Lite-subquery Contains) and carry extra TODO flags.

describe("InDbTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // private static ArtistEntity GetFemale() => Database.Query<ArtistEntity>().Where(a => a.Sex == Sex.Female).Single();
    const getFemale = () => table(ArtistEntity).filter(a => a.sex == Sex.Female).single();

    // var female = GetFemale();
    // Assert.Equal(Sex.Female, female.InDB().Select(a => a.Sex).Single());
    // Assert.Equal(Sex.Female, female.ToLite().InDB().Select(a => a.Sex).Single());
    // TODO(api): InDB bridge
    test("InDbTestSimple", async () => {
        const female = await getFemale();
        assert.equal(Sex.Female, await female.inDB().map(a => a.sex).single());
        assert.equal(Sex.Female, await female.toLite().inDB().map(a => a.sex).single());
    });

    // var female = GetFemale();
    // var friends = female.InDB().Select(a => a.Friends.ToList()).Single();
    // friends = female.ToLite().InDB().Select(a => a.Friends.ToList()).Single();
    // TODO(api): InDB bridge
    test("InDbTestSimpleList", async () => {
        const female = await getFemale();
        let friends = await female.inDB().map(a => a.friends).single();
        friends = await female.toLite().inDB().map(a => a.friends).single();
    });

    // var female = GetFemale();
    // Assert.Equal(Sex.Female, female.InDB(a => a.Sex));
    // Assert.Equal(Sex.Female, female.ToLite().InDB(a => a.Sex));
    // TODO(api): InDB bridge
    test("InDbTestSelector", async () => {
        const female = await getFemale();
        assert.equal(Sex.Female, await female.inDB(a => a.sex));
        assert.equal(Sex.Female, await female.toLite().inDB(a => a.sex));
    });

    // var female = GetFemale();
    // var friends = female.InDB(a => a.Friends.ToList());
    // friends = female.ToLite().InDB(a => a.Friends.ToList());
    // TODO(api): InDB bridge
    test("InDbTestSelectosList", async () => {
        const female = await getFemale();
        let friends = await female.inDB(a => a.friends);
        friends = await female.toLite().inDB(a => a.friends);
    });

    // var female = GetFemale();
    // var list = Database.Query<ArtistEntity>().Where(a => a.Sex != female.InDB().Select(a2 => a2.Sex).Single()).ToList();
    // Assert.True(list.Count > 0);
    // list = Database.Query<ArtistEntity>().Where(a => a.Sex != female.ToLite().InDB().Select(a2 => a2.Sex).Single()).ToList();
    // Assert.True(list.Count > 0);
    // TODO(api): InDB bridge
    test("InDbQueryTestSimple", async () => {
        const female = await getFemale();
        let list = await table(ArtistEntity)
            .filter(a => a.sex != female.inDB().map(a2 => a2.sex).single().$v)
            .toArray();
        assert.ok(list.length > 0);
        list = await table(ArtistEntity)
            .filter(a => a.sex != female.toLite().inDB().map(a2 => a2.sex).single().$v)
            .toArray();
        assert.ok(list.length > 0);
    });

    // var female = GetFemale();
    // var list = Database.Query<ArtistEntity>().Where(a => female.InDB().Select(a2 => a2.Friends).Single().Contains(a.ToLite())).ToList();
    // Assert.True(list.Count > 0);
    // list = Database.Query<ArtistEntity>().Where(a => female.ToLite().InDB().Select(a2 => a2.Friends).Single().Contains(a.ToLite())).ToList();
    // Assert.True(list.Count > 0);
    // TODO(api): InDB bridge
    // TODO(api): Lite-element Contains over a part-entity collection subquery (a2.friends.contains(a.toLite()))
    test("InDbQueryTestSimpleList", async () => {
        const female = await getFemale();
        let list = await table(ArtistEntity)
            .filter(a => female.inDB().map(a2 => a2.friends).single().$v.some(f => f.friend.is(a.toLite())))
            .toArray();
        assert.ok(list.length > 0);
        list = await table(ArtistEntity)
            .filter(a => female.toLite().inDB().map(a2 => a2.friends).single().$v.some(f => f.friend.is(a.toLite())))
            .toArray();
        assert.ok(list.length > 0);
    });

    // var female = GetFemale();
    // var list = Database.Query<ArtistEntity>().Where(a => a.Sex != female.InDB(a2 => a2.Sex)).ToList();
    // Assert.True(list.Count > 0);
    // list = Database.Query<ArtistEntity>().Where(a => a.Sex != female.ToLite().InDB(a2 => a2.Sex)).ToList();
    // Assert.True(list.Count > 0);
    // TODO(api): InDB bridge
    test("InDbQueryTestSimpleSelector", async () => {
        const female = await getFemale();
        let list = await table(ArtistEntity)
            .filter(a => a.sex != female.inDB(a2 => a2.sex))
            .toArray();
        assert.ok(list.length > 0);
        list = await table(ArtistEntity)
            .filter(a => a.sex != female.toLite().inDB(a2 => a2.sex))
            .toArray();
        assert.ok(list.length > 0);
    });

    // var female = GetFemale();
    // var list = Database.Query<ArtistEntity>().Where(a => female.InDB(a2 => a2.Friends).Contains(a.ToLite())).ToList();
    // Assert.True(list.Count > 0);
    // list = Database.Query<ArtistEntity>().Where(a => female.ToLite().InDB(a2 => a2.Friends).Contains(a.ToLite())).ToList();
    // Assert.True(list.Count > 0);
    // TODO(api): InDB bridge
    // TODO(api): Lite-element Contains over a part-entity collection subquery (friends.contains(a.toLite()))
    test("InDbQueryTestSimpleListSelector", async () => {
        const female = await getFemale();
        let list = await table(ArtistEntity)
            .filter(a => female.inDB(a2 => a2.friends).some(f => f.friend.is(a.toLite())))
            .toArray();
        assert.ok(list.length > 0);
        list = await table(ArtistEntity)
            .filter(a => female.toLite().inDB(a2 => a2.friends).some(f => f.friend.is(a.toLite())))
            .toArray();
        assert.ok(list.length > 0);
    });

    // var artistsInBands = (from b in Database.Query<BandEntity>() from a in b.Members
    //                       select new { MaxAlbum = a.InDB(ar => ar.IsMale) }).ToList();
    // TODO(api): InDB bridge
    // TODO(api): AutoExpressionField/As.Expression property (ArtistEntity.IsMale) in query
    test("SelectManyInDB", async () => {
        const artistsInBands = await table(BandEntity)
            .flatMap(b => b.members)
            .map(a => ({ name: a.member.entity.name, isMale: a.member.entity.inDB(ar => ar.isMale()) }))
            .toArray();
        assert.ok(Array.isArray(artistsInBands));
    });
});
