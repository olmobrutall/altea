import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.startsWith / contains / … (SQL-mappable)
import { hasDb, start } from "./setup";
import {
    ArtistEntity, AlbumEntity, BandEntity, LabelEntity,
    NoteWithDateEntity, AwardNominationEntity, GrammyAwardEntity,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/SelectImplementations.cs (class
// SelectImplementationsTest1). C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Select(...) → .map(...)
//   .Where(...)          → .filter(...)        .SelectMany(...) → .flatMap(...)
//   .ToList()/.ToArray() → await .toArray()    .Count()     → await .count()
//   a.ToLite()           → a.toLite()          new { X = .. } → { x: .. } (camelCase)
//   x is ArtistEntity    → x instanceof ArtistEntity
//   (ArtistEntity)x      → (x as ArtistEntity)
//   lite.Entity          → lite.entity (navigate a Lite<T> via .entity)
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// This file is heavy on polymorphism. Signum interface types (IAuthorEntity) do
// NOT exist in altea — author/target/award are `Entity` (or `Lite<Entity>`) with
// @implementedBy/@implementedByAll. Tests depending on the interface are
// skipped+flagged. CombineUnion/CombineCase have no altea API. GetType, typeof,
// EntityType, Cast/OfType operators, Try(...), and entity casts in queries are
// likewise unmodelled. Those are written in their most natural altea form,
// marked `{ skip: true }`, and flagged with a `// TODO(api): …` comment. Skipped
// tests still compile.

describe("SelectImplementationsTest1", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().Select(a => a.GetType()).ToList();
    // TODO(api): GetType in query (a.constructor)
    test("SelectType", { skip: true }, async () => {
        const list = await table(AlbumEntity).map(a => a.constructor).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<LabelEntity>().Select(a => new { Label = a.ToLite(), a.Owner, OwnerType = a.Owner!.Entity.GetType() }).ToList();
    // TODO(api): GetType in query (a.constructor) — and Lite.entity dereference in projection
    test("SelectTypeNull", { skip: true }, async () => {
        const list = await table(LabelEntity)
            .map(a => ({ label: a.toLite(), owner: a.owner, ownerType: a.owner!.entity.constructor }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().Select(a => a.Author.ToLite()).ToList();
    test("SelectLiteIB", async () => {
        const list = await table(AlbumEntity).map(a => a.author.toLite()).toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => new { ToStr1 = a.Author.ToLite(), ToStr2 = a.Author.ToLite() }); Assert.Equal(2, …LEFT OUTER JOIN); ToList()
    test("SelectLiteIBDouble", async () => {
        const list = await table(AlbumEntity)
            .map(a => ({ toStr1: a.author.toLite(), toStr2: a.author.toLite() }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => a.Author.CombineUnion().ToLite().ToString()!.Length > 0).Select(a => a.Author.CombineUnion().ToLite())
    // TODO(api): combineUnion/Case
    test("SelectLiteIBDoubleWhereUnion", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => a.author.combineUnion().toLite().toString()!.length > 0)
        //     .map(a => a.author.combineUnion().toLite())
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => a.Author.CombineCase().ToLite().ToString()!.Length > 0).Select(a => a.Author.CombineCase().ToLite())
    // TODO(api): combineUnion/Case
    test("SelectLiteIBDoubleWhereSwitch", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => a.author.combineCase().toLite().toString()!.length > 0)
        //     .map(a => a.author.combineCase().toLite())
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().Select(a => new { Type = a.Target.GetType(), Target = a.Target.ToLite() }).ToList();
    // TODO(api): GetType in query (a.constructor)
    test("SelectTypeIBA", { skip: true }, async () => {
        const list = await table(NoteWithDateEntity)
            .map(a => ({ type: a.target.constructor, target: a.target.toLite() }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AwardNominationEntity>().Select(a => a.Award.EntityType).ToList();
    // TODO(api): Lite.EntityType (runtime type of an @implementedBy Lite) in query
    test("SelectTypeLiteIB", { skip: true }, async () => {
        // const list = await table(AwardNominationEntity).map(a => a.award.entityType).toArray();
        // assert.ok(Array.isArray(list));
    });

    // Select(a => a.LastAward == null ? null : a.LastAward.Id.ToString()).ToList();
    // TODO(api): Lite.id of an @implementedByAll reference + enum/id ToString in query
    test("SelectIdLiteIBA", { skip: true }, async () => {
        const list = await table(ArtistEntity)
            .map(a => a.lastAward == null ? null : (a.lastAward.id as string))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => a.LastAward!.Id.ToString() == "3").ToList();
    // TODO(api): Lite.id of an @implementedByAll reference + id ToString in query
    test("WhereIdLiteIB", { skip: true }, async () => {
        const list = await table(ArtistEntity)
            .filter(a => (a.lastAward!.id as string) == "3")
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => a.Friends.Select(a => a.ToString()).Contains(a.LastAward!.Id.ToString())).ToList();
    // TODO(api): Lite.id of an @implementedByAll reference + ToString of a Lite element in subquery
    test("ContainsIdLiteIB", { skip: true }, async () => {
        // const list = await table(ArtistEntity)
        //     .filter(a => a.friends.map(f => f.friend.toString()).contains(a.lastAward!.id as string))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Database.Query<AwardNominationEntity>().Where(a => a.Award.Entity is GrammyAwardEntity).ToList();
    test("SelectEntityWithLiteIb", async () => {
        const list = await table(AwardNominationEntity)
            .filter(a => a.award.entity instanceof GrammyAwardEntity)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => a.Award.Entity.GetType() == typeof(GrammyAwardEntity)).ToList();
    // TODO(api): GetType/typeof comparison in query
    test("SelectEntityWithLiteIbType", { skip: true }, async () => {
        const list = await table(AwardNominationEntity)
            .filter(a => a.award.entity.constructor === GrammyAwardEntity)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Type[] types = { typeof(GrammyAwardEntity) }; Where(a => types.Contains(a.Award.Entity.GetType())).ToList();
    // TODO(api): GetType/typeof comparison in query (types.Contains over runtime type)
    test("SelectEntityWithLiteIbTypeContains", { skip: true }, async () => {
        // const types = [GrammyAwardEntity];
        // const list = await table(AwardNominationEntity)
        //     .filter(a => types.contains(a.award.entity.constructor))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => a.Award.EntityType == typeof(GrammyAwardEntity)).ToList();
    // TODO(api): Lite.EntityType (runtime type of an @implementedBy Lite) and typeof comparison
    test("SelectEntityWithLiteIbRuntimeType", { skip: true }, async () => {
        // const list = await table(AwardNominationEntity)
        //     .filter(a => a.award.entityType === GrammyAwardEntity)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Database.Query<ArtistEntity>().Select(a => a.ToLite()).ToList();
    test("SelectLiteUpcast", async () => {
        const list = await table(ArtistEntity).map(a => a.toLite()).toArray();
        assert.ok(Array.isArray(list));
    });

    // SelectMany(a => a.Friends).Select(a => (Lite<IAuthorEntity>)a).ToList();
    // TODO(api): implementedBy interface (Lite<IAuthorEntity> upcast does not exist in altea)
    test("SelectLiteCastUpcast", { skip: true }, async () => {
        // const list = await table(ArtistEntity)
        //     .flatMap(a => a.friends)
        //     .map(a => a.friend)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // SelectMany(a => a.Friends).Select(a => (Lite<ArtistEntity>)a).ToList();
    test("SelectLiteCastNocast", async () => {
        const list = await table(ArtistEntity)
            .flatMap(a => a.friends)
            .map(a => a.friend)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => (Lite<ArtistEntity>)a.Author.ToLite()).ToList();
    // TODO(api): Lite downcast in query ((x as Lite<ArtistEntity>))
    test("SelectLiteCastDowncast", { skip: true }, async () => {
        const list = await table(AlbumEntity).map(a => a.author.toLite()).toArray();
        assert.ok(Array.isArray(list));
    });

    // SelectAuthorsLite<ArtistEntity, IAuthorEntity>(): Select(a => a.ToLite<LT>())
    // TODO(api): implementedBy interface (generic ToLite<IAuthorEntity> upcast does not exist in altea)
    test("SelectLiteGenericUpcast", { skip: true }, async () => {
        // const list = await table(ArtistEntity).map(a => a.toLite()).toArray();
        // assert.ok(Array.isArray(list));
    });

    // from a let band = (BandEntity)a.Author select new { Artist = band.ToString(), Author = a.Author.CombineUnion().ToString() }
    // TODO(api): combineUnion/Case
    test("SelectLiteIBRedundantUnion", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .map(a => ({ artist: (a.author as BandEntity).toString(), author: a.author.combineUnion().toString() }))
        //     .toArray();
        // assert.equal(await table(AlbumEntity).count(), list.length);
    });

    // from a let band = (BandEntity)a.Author select new { Artist = band.ToString(), Author = a.Author.CombineCase().ToString() }
    // TODO(api): combineUnion/Case
    test("SelectLiteIBRedundantSwitch", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .map(a => ({ artist: (a.author as BandEntity).toString(), author: a.author.combineCase().toString() }))
        //     .toArray();
        // assert.equal(await table(AlbumEntity).count(), list.length);
    });

    // Select(a => a.Author.CombineUnion().ToLite()).Where(a => a.ToString()!.StartsWith("Michael")).ToList();
    // TODO(api): combineUnion/Case
    test("SelectLiteIBWhereUnion", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .map(a => a.author.combineUnion().toLite())
        //     .filter(a => a.toString()!.startsWith("Michael"))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Select(a => a.Author.CombineCase().ToLite()).Where(a => a.ToString()!.StartsWith("Michael")).ToList();
    // TODO(api): combineUnion/Case
    test("SelectLiteIBWhereSwitch", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .map(a => a.author.combineCase().toLite())
        //     .filter(a => a.toString()!.startsWith("Michael"))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().Select(a => a.Target.ToLite()).ToList();  (duplicate name SelectLiteIBA)
    test("SelectLiteIBA", async () => {
        const list = await table(NoteWithDateEntity).map(a => a.target.toLite()).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<ArtistEntity>().ToList();
    test("SelectSimpleEntity", async () => {
        const list3 = await table(ArtistEntity).toArray();
        assert.ok(Array.isArray(list3));
    });

    // Database.Query<AlbumEntity>().ToList();
    test("SelectEntity", async () => {
        const list3 = await table(AlbumEntity).toArray();
        assert.ok(Array.isArray(list3));
    });

    // Database.Query<AlbumEntity>().Select(a => a).ToList();
    test("SelectEntitySelect", async () => {
        const list = await table(AlbumEntity).map(a => a).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().Select(a => a.Author).ToList();
    test("SelectEntityIB", async () => {
        const list = await table(AlbumEntity).map(a => a.author).toArray();
        assert.ok(Array.isArray(list));
    });

    // from a let aut = a.Author select new { aut, a.Author }
    test("SelectEntityIBRedundan", async () => {
        const list = await table(AlbumEntity)
            .map(a => ({ aut: a.author, author: a.author }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().Select(a => a.Target).ToList();
    test("SelectEntityIBA", async () => {
        const list = await table(NoteWithDateEntity).map(a => a.target).toArray();
        assert.ok(Array.isArray(list));
    });

    // from a select ((ArtistEntity)a.Author).Name ?? ((BandEntity)a.Author).Name
    // TODO(api): entity cast in query ((x as ArtistEntity))
    test("SelectCastIB", { skip: true }, async () => {
        const list = await table(AlbumEntity)
            .map(a => (a.author as ArtistEntity).name ?? (a.author as BandEntity).name)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from a select a.Author.CombineUnion().Name
    // TODO(api): combineUnion/Case
    test("SelectCastIBPolymorphicUnion", { skip: true }, async () => {
        // const list = await table(AlbumEntity).map(a => a.author.combineUnion().name).toArray();
        // assert.ok(Array.isArray(list));
    });

    // from a select a.Author.CombineCase().Name
    // TODO(api): combineUnion/Case
    test("SelectCastIBPolymorphicSwitch", { skip: true }, async () => {
        // const list = await table(AlbumEntity).map(a => a.author.combineCase().name).toArray();
        // assert.ok(Array.isArray(list));
    });

    // from a select (int?)a.Award!.Entity.Year
    // TODO(api): Lite.entity dereference of an @implementedBy reference with nullable projection
    test("SelectCastIBPolymorphicForceNullify", { skip: true }, async () => {
        const list = await table(AwardNominationEntity)
            .map(a => (a.award!.entity as GrammyAwardEntity).year)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from a select a.Author.CombineUnion().LastAward.Try(la => la.ToLite())
    // TODO(api): combineUnion/Case
    test("SelectCastIBPolymorphicIBUnion", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .map(a => a.author.combineUnion().lastAward?.toLite())
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // from a select a.Author.CombineCase().LastAward.Try(la => la.ToLite())
    // TODO(api): combineUnion/Case
    test("SelectCastIBPolymorphicIBSwitch", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .map(a => a.author.combineCase().lastAward?.toLite())
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // from n select ((ArtistEntity)n.Target).Name ?? ((AlbumEntity)n.Target).Name ?? ((BandEntity)n.Target).Name
    // TODO(api): entity cast in query ((x as ArtistEntity)) over @implementedByAll target
    test("SelectCastIBA", { skip: true }, async () => {
        const list = await table(NoteWithDateEntity)
            .map(n => (n.target as ArtistEntity).name ?? (n.target as AlbumEntity).name ?? (n.target as BandEntity).name)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // (from n select n.Target).Cast<BandEntity>().ToList();
    // TODO(api): Cast<T>() query operator
    test("SelectCastIBACastOperator", { skip: true }, async () => {
        // const list = await table(NoteWithDateEntity).map(n => n.target).cast(BandEntity).toArray();
        // assert.ok(Array.isArray(list));
    });

    // (from n select n.Target).OfType<BandEntity>().ToList();
    // TODO(api): OfType<T>() query operator
    test("SelectCastIBAOfTypeOperator", { skip: true }, async () => {
        // const list = await table(NoteWithDateEntity).map(n => n.target).ofType(BandEntity).toArray();
        // assert.ok(Array.isArray(list));
    });

    // from a select (a.Author is ArtistEntity ? ((ArtistEntity)a.Author).Name : ((BandEntity)a.Author).Name)
    // TODO(api): entity cast in query ((x as ArtistEntity))
    test("SelectCastIsIB", { skip: true }, async () => {
        const list = await table(AlbumEntity)
            .map(a => a.author instanceof ArtistEntity ? (a.author as ArtistEntity).name : (a.author as BandEntity).name)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from n select n.Target is ArtistEntity ? ((ArtistEntity)n.Target).Name : ((BandEntity)n.Target).Name
    // TODO(api): entity cast in query ((x as ArtistEntity)) over @implementedByAll target
    test("SelectCastIsIBA", { skip: true }, async () => {
        const list = await table(NoteWithDateEntity)
            .map(n => n.target instanceof ArtistEntity ? (n.target as ArtistEntity).name : (n.target as BandEntity).name)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from n select new { Name = … ? ((ArtistEntity)n.Target).Name : ((BandEntity)n.Target).Name, FullName = … ? ((ArtistEntity)n.Target).FullName : ((BandEntity)n.Target).FullName }
    // TODO(api): implementedBy interface (FullName lives on IAuthorEntity, not on the altea Entity)
    // TODO(api): entity cast in query ((x as ArtistEntity))
    test("SelectCastIsIBADouble", { skip: true }, async () => {
        // const list = await table(NoteWithDateEntity)
        //     .map(n => ({
        //         name: n.target instanceof ArtistEntity ? (n.target as ArtistEntity).name : (n.target as BandEntity).name,
        //         fullName: n.target instanceof ArtistEntity ? (n.target as ArtistEntity).fullName : (n.target as BandEntity).fullName,
        //     }))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // from n where (… ? ((ArtistEntity)n.Target).Name : ((BandEntity)n.Target).Name).Length > 0 select … ((ArtistEntity)n.Target).FullName : ((BandEntity)n.Target).FullName
    // TODO(api): implementedBy interface (FullName lives on IAuthorEntity, not on the altea Entity)
    // TODO(api): entity cast in query ((x as ArtistEntity))
    test("SelectCastIsIBADoubleWhere", { skip: true }, async () => {
        // const list = await table(NoteWithDateEntity)
        //     .filter(n => (n.target instanceof ArtistEntity ? (n.target as ArtistEntity).name : (n.target as BandEntity).name).length > 0)
        //     .map(n => n.target instanceof ArtistEntity ? (n.target as ArtistEntity).fullName : (n.target as BandEntity).fullName)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // from n where n.Target.ToLite() is Lite<AlbumEntity> select n.Target.ToLite()
    // TODO(api): `is Lite<T>` runtime-type test on a Lite in query
    test("SelectIsIBLite", { skip: true }, async () => {
        // const list = await table(NoteWithDateEntity)
        //     .filter(n => n.target.toLite() instanceof AlbumEntity)
        //     .map(n => n.target.toLite())
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // from a where a.Author is Lite<BandEntity> select a.Author
    // TODO(api): `is Lite<T>` runtime-type test on an @implementedBy Lite in query
    test("SelectIsIBALite", { skip: true }, async () => {
        // const list = await table(AwardNominationEntity)
        //     .filter(a => a.author instanceof BandEntity)
        //     .map(a => a.author)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // from n select (Lite<AlbumEntity>)n.Target.ToLite()
    // TODO(api): Lite downcast in query ((x as Lite<AlbumEntity>))
    test("SelectCastIBALite", { skip: true }, async () => {
        const list = await table(NoteWithDateEntity).map(n => n.target.toLite()).toArray();
        assert.ok(Array.isArray(list));
    });

    // from a select (Lite<BandEntity>)a.Author
    // TODO(api): Lite downcast in query ((x as Lite<BandEntity>))
    test("SelectCastIBLite", { skip: true }, async () => {
        const list = await table(AwardNominationEntity).map(a => a.author).toArray();
        assert.ok(Array.isArray(list));
    });
});
