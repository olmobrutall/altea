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
// Every method uses EntityContext.entityId(...) — the query-only helper that surfaces
// the primary key of the row a value belongs to. The binder resolves it: a reference
// yields its id, a value/embedded unwraps to its owning entity's id, and an MList (part-
// entity) row yields its own id via a correlated scalar subquery. (altea has no separate
// MList row id — collection rows are ordinary part entities — so the RowId* cases behave
// like the EntityId* ones.)

describe("EntityContextTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Label) == a.Id);
    test("EntityIdMember", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.label) == (a.id as number));
        assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.BonusTrack!.Name) == a.Id);
    test("EntityIdEmbeddedMember", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.bonusTrack!.name) == (a.id as number));
        assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Songs.FirstOrDefault()) == a.Id);
    test("EntiyIdMList", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.songs.firstOrNull()) == (a.id as number));
        assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Songs.FirstOrDefault()!.Name) == a.Id);
    test("EntityIdMListMember", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.songs.firstOrNull()!.name) == (a.id as number));
        assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Songs.FirstOrDefault()) == a.Id);
    test("RowIdMList", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.songs.firstOrNull()) == (a.id as number));
        assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Songs.FirstOrDefault()!.Name) == a.Id);
    test("RowIdMListMember", async () => {
        const authors = await table(AlbumEntity)
            .count(a => EntityContext.entityId(a.songs.firstOrNull()!.name) == (a.id as number));
        assert.ok(authors >= 0);
    });
});
