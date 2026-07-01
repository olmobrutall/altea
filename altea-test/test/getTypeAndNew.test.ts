import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import {
    ArtistEntity, AlbumEntity, BandEntity, NoteWithDateEntity,
    GrammyAwardEntity,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/GetTypeAndNewTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Select(...) → .map(...)
//   .Where(...)          → .filter(...)        .GroupBy(...) → .groupBy(...)
//   .ToList()/.ToArray() → await .toArray()    new { X = .. } → { x: .. } (camelCase)
//   a.ToLite()           → a.toLite()          x is T        → x instanceof T
//   x.Is(y)              → x.is(y)
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Essentially every method here exercises runtime-type access in a query
// (f.GetType(), typeof(X), ToTypeEntity(), EntityType, NiceName(), IsNew). altea
// has no query API for these, so each is written in its most natural altea form
// (a.constructor for GetType, X for typeof(X)), marked `{ skip: true }`, and
// flagged with a `// TODO(api): …` comment.

describe("GetTypeAndNewTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // from f in Database.Query<ArtistEntity>() where f.GetType() == typeof(ArtistEntity) select new { f.Name }
    // TODO(api): GetType in query
    // TODO(api): typeof(X) comparison in query
    test("TestGetType", async () => {
        const list = await table(ArtistEntity)
            .filter(f => f.constructor === ArtistEntity)
            .map(f => ({ name: f.name }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<ArtistEntity>() where f.GetType().FullName == typeof(ArtistEntity).FullName select new { f.Name }
    // TODO(api): GetType in query
    // TODO(api): typeof(X) comparison in query
    // TODO(api): Type.FullName in query
    test("TestGetTypeFullName", async () => {
        const list = await table(ArtistEntity)
            .filter(f => f.constructor.name === ArtistEntity.name)
            .map(f => ({ name: f.name }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<AlbumEntity>() where f.Author.GetType().FullName == typeof(ArtistEntity).FullName select new { f.Name }
    // TODO(api): GetType in query
    // TODO(api): typeof(X) comparison in query
    // TODO(api): Type.FullName in query
    test("TestGetTypeIBFullName", async () => {
        const list = await table(AlbumEntity)
            .filter(f => f.author.constructor.name === ArtistEntity.name)
            .map(f => ({ name: f.name }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<ArtistEntity>() where f.GetType().NiceName() == typeof(ArtistEntity).NiceName() select new { f.Name }
    // TODO(api): GetType in query
    // TODO(api): typeof(X) comparison in query
    // TODO(api): Type.NiceName() in query
    test("TestGetTypeNiceName", async () => {
        const list = await table(ArtistEntity)
            .filter(f => f.constructor === ArtistEntity)
            .map(f => ({ name: f.name }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<AlbumEntity>() where f.Author.GetType().NiceName() == typeof(ArtistEntity).NiceName() select new { f.Name }
    // TODO(api): GetType in query
    // TODO(api): typeof(X) comparison in query
    // TODO(api): Type.NiceName() in query
    test("TestGetTypeIBNiceName", async () => {
        const list = await table(AlbumEntity)
            .filter(f => f.author.constructor === ArtistEntity)
            .map(f => ({ name: f.name }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<AlbumEntity>() where (f.IsNew ? "New" : "Old") == "Old" select new { f.Name }
    // TODO(api): IsNew flag in query
    test("TestIsNew", async () => {
        const list = await table(AlbumEntity)
            .filter(f => (f.isNew ? "New" : "Old") === "Old")
            .map(f => ({ name: f.name }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<ArtistEntity>() select f.GetType().ToTypeEntity()
    // TODO(api): GetType in query
    // TODO(api): ToTypeEntity() in query
    test("SelectToTypeEntity", async () => {
        const list = await table(ArtistEntity).map(f => f.constructor).toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<ArtistEntity>() select ((Entity)f).GetType().ToTypeEntity()
    // TODO(api): GetType in query
    // TODO(api): ToTypeEntity() in query
    // TODO(api): entity upcast in query
    test("SelectToTypeEntity_UpCast", async () => {
        const list = await table(ArtistEntity).map(f => f.constructor).toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<ArtistEntity>() select ((Lite<Entity>)f.ToLite()).Entity.GetType().ToTypeEntity()
    // TODO(api): GetType in query
    // TODO(api): ToTypeEntity() in query
    // TODO(api): Lite.entity dereference in query
    test("SelectToTypeEntity_UpCast_Pushed", async () => {
        const list = await table(ArtistEntity).map(f => f.toLite().entity.constructor).toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<ArtistEntity>() where f.ToLite().EntityType.ToTypeEntity().Is(typeof(ArtistEntity).ToTypeEntity()) select f
    // TODO(api): Lite.EntityType in query
    // TODO(api): ToTypeEntity() in query
    // TODO(api): typeof(X) comparison in query
    test("SelectToTypeLite", async () => {
        // Signum's `f.ToLite().EntityType.ToTypeEntity().Is(...)`; the altea idiom is a
        // runtime-type equality — `Lite.entityType` is the type expression, `===` the compare.
        const list = await table(ArtistEntity)
            .filter(f => f.toLite().entityType === ArtistEntity)
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<ArtistEntity>() where f.GetType().ToTypeEntity().Is(typeof(ArtistEntity).ToTypeEntity()) select f
    // TODO(api): GetType in query
    // TODO(api): ToTypeEntity() in query
    // TODO(api): typeof(X) comparison in query
    test("WhereToTypeEntity", async () => {
        const list = await table(ArtistEntity)
            .filter(f => f.constructor === ArtistEntity)
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<BandEntity>() select f.LastAward!.GetType().ToTypeEntity()
    // TODO(api): GetType in query
    // TODO(api): ToTypeEntity() in query
    test("SelectToTypeEntityIB", async () => {
        const list = await table(BandEntity).map(f => f.lastAward!.constructor).toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<BandEntity>() where f.LastAward!.GetType().ToTypeEntity().Is(typeof(GrammyAwardEntity).ToTypeEntity()) select f
    // TODO(api): GetType in query
    // TODO(api): ToTypeEntity() in query
    // TODO(api): typeof(X) comparison in query
    test("WhereToTypeEntityIB", async () => {
        const list = await table(BandEntity)
            .filter(f => f.lastAward!.constructor === GrammyAwardEntity)
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<BandEntity>() group f by f.LastAward!.GetType().ToTypeEntity() into g select new { g.Key, Count = g.Count() }
    // TODO(api): GetType in query
    // TODO(api): ToTypeEntity() in query
    test("WhereToTypeEntityIBGroupBy", async () => {
        const list = await table(BandEntity)
            .groupBy(f => f.lastAward!.constructor)
            .map(g => ({ key: g.key, count: g.elements.length }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<NoteWithDateEntity>() select f.Target.GetType().ToTypeEntity()
    // TODO(api): GetType in query
    // TODO(api): ToTypeEntity() in query
    test("SelectToTypeEntityIBA", async () => {
        const list = await table(NoteWithDateEntity).map(f => f.target.constructor).toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<NoteWithDateEntity>() where f.Target.GetType().ToTypeEntity().Is(typeof(ArtistEntity).ToTypeEntity()) select f
    // TODO(api): GetType in query
    // TODO(api): ToTypeEntity() in query
    // TODO(api): typeof(X) comparison in query
    test("WhereToTypeEntityIBA", async () => {
        const list = await table(NoteWithDateEntity)
            .filter(f => f.target.constructor === ArtistEntity)
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<NoteWithDateEntity>() group f by f.Target.GetType().ToTypeEntity() into g select new { g.Key, Count = g.Count() }
    // TODO(api): GetType in query
    // TODO(api): ToTypeEntity() in query
    test("WhereToTypeEntityIBAGroupBy", async () => {
        const list = await table(NoteWithDateEntity)
            .groupBy(f => f.target.constructor)
            .map(g => ({ key: g.key, count: g.elements.length }))
            .toArray();
        assert.ok(list.length > 0);
    });
});
