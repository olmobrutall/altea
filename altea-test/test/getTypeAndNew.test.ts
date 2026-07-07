import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import { TypeEntity } from "@altea/altea/entities/typeEntity";
import { niceName } from "@altea/altea/entities/utils/localization";
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
// Runtime-type access in a query maps to altea idioms:
//   f.GetType()            → f.constructor           (a runtime-type token)
//   typeof(X)              → the class X             (compared with ===)
//   lite.EntityType        → lite.entityType
//   type.ToTypeEntity()    → type.toTypeEntity()     (→ the TypeEntity row)
//   type.NiceName()        → type.niceName()         (localized name; constants for a typed
//                                                      entity / @implementedBy, throws for IBA)
//   type.FullName          → type.name               (the class-name string)
// GetType comparisons lower to the type-id discriminator (a CASE / the IB FK-not-null / the
// IBA type column); toTypeEntity() references the TypeEntity table by that id. `IsNew` in a
// query is still unsupported (see TestIsNew).

describe("GetTypeAndNewTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // from f in Database.Query<ArtistEntity>() where f.GetType() == typeof(ArtistEntity) select new { f.Name }
    test("TestGetType", async () => {
        const list = await table(ArtistEntity)
            .filter(f => f.constructor === ArtistEntity)
            .map(f => ({ name: f.name }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<ArtistEntity>() where f.GetType().FullName == typeof(ArtistEntity).FullName select new { f.Name }
    test("TestGetTypeFullName", async () => {
        const list = await table(ArtistEntity)
            .filter(f => f.constructor.name === ArtistEntity.name)
            .map(f => ({ name: f.name }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<AlbumEntity>() where f.Author.GetType().FullName == typeof(ArtistEntity).FullName select new { f.Name }
    test("TestGetTypeIBFullName", async () => {
        const list = await table(AlbumEntity)
            .filter(f => f.author.constructor.name === ArtistEntity.name)
            .map(f => ({ name: f.name }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<ArtistEntity>() where f.GetType().NiceName() == typeof(ArtistEntity).NiceName() select new { f.Name }
    test("TestGetTypeNiceName", async () => {
        const list = await table(ArtistEntity)
            .filter(f => f.constructor.niceName() === niceName(ArtistEntity))
            .map(f => ({ name: f.name }))
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<AlbumEntity>() where f.Author.GetType().NiceName() == typeof(ArtistEntity).NiceName() select new { f.Name }
    test("TestGetTypeIBNiceName", async () => {
        const list = await table(AlbumEntity)
            .filter(f => f.author.constructor.niceName() === niceName(ArtistEntity))
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
    test("SelectToTypeEntity", async () => {
        const list = await table(ArtistEntity).map(f => f.constructor.toTypeEntity()).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(t => t instanceof TypeEntity && t.cleanName === "Artist"));
    });

    // from f in Database.Query<ArtistEntity>() select ((Entity)f).GetType().ToTypeEntity()
    // TODO(api): entity upcast in query — altea has no `(Entity)f` cast; the runtime type is the same.
    test("SelectToTypeEntity_UpCast", async () => {
        const list = await table(ArtistEntity).map(f => f.constructor.toTypeEntity()).toArray();
        assert.ok(list.every(t => t.cleanName === "Artist"));
    });

    // from f in Database.Query<ArtistEntity>() select ((Lite<Entity>)f.ToLite()).Entity.GetType().ToTypeEntity()
    test("SelectToTypeEntity_UpCast_Pushed", async () => {
        const list = await table(ArtistEntity).map(f => f.toLite().entity.constructor.toTypeEntity()).toArray();
        assert.ok(list.every(t => t.cleanName === "Artist"));
    });

    // from f in Database.Query<ArtistEntity>() where f.ToLite().EntityType.ToTypeEntity().Is(typeof(ArtistEntity).ToTypeEntity()) select f
    test("SelectToTypeLite", async () => {
        // Signum's `f.ToLite().EntityType.ToTypeEntity().Is(...)`; the altea idiom is a
        // runtime-type equality — `Lite.entityType` is the type expression, `===` the compare.
        const list = await table(ArtistEntity)
            .filter(f => f.toLite().entityType === ArtistEntity)
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<ArtistEntity>() where f.GetType().ToTypeEntity().Is(typeof(ArtistEntity).ToTypeEntity()) select f
    test("WhereToTypeEntity", async () => {
        const list = await table(ArtistEntity)
            .filter(f => f.constructor === ArtistEntity)
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<BandEntity>() select f.LastAward!.GetType().ToTypeEntity()
    test("SelectToTypeEntityIB", async () => {
        const list = await table(BandEntity).map(f => f.lastAward!.constructor.toTypeEntity()).toArray();
        assert.ok(list.length > 0);
        // Each non-null award's type is Grammy or AmericanMusicAward (null when the band has none).
        assert.ok(list.every(t => t == null || t.cleanName === "GrammyAward" || t.cleanName === "AmericanMusicAward"));
    });

    // from f in Database.Query<BandEntity>() where f.LastAward!.GetType().ToTypeEntity().Is(typeof(GrammyAwardEntity).ToTypeEntity()) select f
    test("WhereToTypeEntityIB", async () => {
        const list = await table(BandEntity)
            .filter(f => f.lastAward!.constructor === GrammyAwardEntity)
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<BandEntity>() group f by f.LastAward!.GetType().ToTypeEntity() into g select new { g.Key, Count = g.Count() }
    test("WhereToTypeEntityIBGroupBy", async () => {
        const list = await table(BandEntity)
            .groupBy(f => f.lastAward!.constructor.toTypeEntity())
            .map(g => ({ key: g.key, count: g.elements.length }))
            .toArray();
        assert.ok(list.length > 0);
        // The grouping key is a TypeEntity (or null for bands with no last award).
        assert.ok(list.every(g => g.key == null || g.key instanceof TypeEntity));
    });

    // from f in Database.Query<NoteWithDateEntity>() select f.Target.GetType().ToTypeEntity()
    test("SelectToTypeEntityIBA", async () => {
        const list = await table(NoteWithDateEntity).map(f => f.target.constructor.toTypeEntity()).toArray();
        assert.ok(list.length > 0);
        // @implementedByAll: the type comes from the stored type-id column, materialised as TypeEntity.
        assert.ok(list.every(t => t == null || t instanceof TypeEntity));
    });

    // from f in Database.Query<NoteWithDateEntity>() where f.Target.GetType().ToTypeEntity().Is(typeof(ArtistEntity).ToTypeEntity()) select f
    test("WhereToTypeEntityIBA", async () => {
        const list = await table(NoteWithDateEntity)
            .filter(f => f.target.constructor === ArtistEntity)
            .toArray();
        assert.ok(list.length > 0);
    });

    // from f in Database.Query<NoteWithDateEntity>() group f by f.Target.GetType().ToTypeEntity() into g select new { g.Key, Count = g.Count() }
    test("WhereToTypeEntityIBAGroupBy", async () => {
        const list = await table(NoteWithDateEntity)
            .groupBy(f => f.target.constructor.toTypeEntity())
            .map(g => ({ key: g.key, count: g.elements.length }))
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(g => g.key == null || g.key instanceof TypeEntity));
    });
});
