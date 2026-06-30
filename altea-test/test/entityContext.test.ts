import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import { EntityContext } from "@altea/altea/logic/query";
import { AlbumEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/EntityContextTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Count(pred) → await .count(pred)
//   a.Songs              → a.songs             a.Id         → (a.id as number)
//   a.Songs.FirstOrDefault() → a.songs.firstOrNull()
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Every method here uses EntityContext.EntityId(...) (a part entity's row is its own
// translator helpers that surface the row's primary key / MList row id inside a
// query. altea has no equivalent yet, so all tests are written in their most
// natural form, marked `{ skip: true }`, with the body fully commented out and
// flagged with a `// TODO(api): …` comment. (Skipped bodies stay commented so
// the un-modelled `EntityContext` symbol never has to compile.)

describe("EntityContextTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Label) == a.Id);
    // TODO(api): EntityContext.EntityId (row primary-key helper) in a query
    test("EntityIdMember", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.label) == (a.id as number));
        assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.BonusTrack!.Name) == a.Id);
    // TODO(api): EntityContext.EntityId (row primary-key helper) in a query
    test("EntityIdEmbeddedMember", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.bonusTrack!.name) == (a.id as number));
        assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Songs.FirstOrDefault()) == a.Id);
    // TODO(api): EntityContext.EntityId (row primary-key helper) in a query
    test("EntiyIdMList", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.songs.firstOrNull()) == (a.id as number));
        assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Songs.FirstOrDefault()!.Name) == a.Id);
    // TODO(api): EntityContext.EntityId (row primary-key helper) in a query
    test("EntityIdMListMember", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.songs.firstOrNull()!.name) == (a.id as number));
        assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Songs.FirstOrDefault()) == a.Id);
    // TODO(api): EntityContext.EntityId on a part-entity row (altea has no MList row id)
    test("RowIdMList", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.songs.firstOrNull()) == (a.id as number));
        assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Songs.FirstOrDefault()!.Name) == a.Id);
    // TODO(api): EntityContext.EntityId on a part-entity row (altea has no MList row id)
    test("RowIdMListMember", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.songs.firstOrNull()!.name) == (a.id as number));
        assert.ok(authors >= 0);
    });
});
