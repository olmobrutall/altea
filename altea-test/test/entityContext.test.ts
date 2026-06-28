import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, startAndLoad } from "./setup";
import { AlbumEntity } from "../entities/music";

// Port of Signum.Test/LinqProvider/EntityContextTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Count(pred) → await .count(pred)
//   a.Songs              → a.songs             a.Id         → (a.id as number)
//   a.Songs.FirstOrDefault() → a.songs.firstOrNull()
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Every method here uses EntityContext.EntityId(...) / EntityContext.MListRowId(...),
// translator helpers that surface the row's primary key / MList row id inside a
// query. altea has no equivalent yet, so all tests are written in their most
// natural form, marked `{ skip: true }`, with the body fully commented out and
// flagged with a `// TODO(api): …` comment. (Skipped bodies stay commented so
// the un-modelled `EntityContext` symbol never has to compile.)

describe("EntityContextTest", { skip: !hasDb }, () => {
    before(async () => { await startAndLoad(); });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Label) == a.Id);
    // TODO(api): EntityContext.EntityId (row primary-key helper) in a query
    test("EntityIdMember", { skip: true }, async () => {
        // const authors = await table(AlbumEntity)
        //     .count(a => EntityContext.entityId(a.label) == (a.id as number));
        // assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.BonusTrack!.Name) == a.Id);
    // TODO(api): EntityContext.EntityId (row primary-key helper) in a query
    test("EntityIdEmbeddedMember", { skip: true }, async () => {
        // const authors = await table(AlbumEntity)
        //     .count(a => EntityContext.entityId(a.bonusTrack!.name) == (a.id as number));
        // assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Songs.FirstOrDefault()) == a.Id);
    // TODO(api): EntityContext.EntityId (row primary-key helper) in a query
    test("EntiyIdMList", { skip: true }, async () => {
        // const authors = await table(AlbumEntity)
        //     .count(a => EntityContext.entityId(a.songs.firstOrNull()) == (a.id as number));
        // assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.EntityId(a.Songs.FirstOrDefault()!.Name) == a.Id);
    // TODO(api): EntityContext.EntityId (row primary-key helper) in a query
    test("EntityIdMListMember", { skip: true }, async () => {
        // const authors = await table(AlbumEntity)
        //     .count(a => EntityContext.entityId(a.songs.firstOrNull()!.name) == (a.id as number));
        // assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.MListRowId(a.Songs.FirstOrDefault()) == a.Id);
    // TODO(api): EntityContext.MListRowId (MList row-id helper) in a query
    test("RowIdMList", { skip: true }, async () => {
        // const authors = await table(AlbumEntity)
        //     .count(a => EntityContext.mListRowId(a.songs.firstOrNull()) == (a.id as number));
        // assert.ok(authors >= 0);
    });

    // Database.Query<AlbumEntity>().Count(a => EntityContext.MListRowId(a.Songs.FirstOrDefault()!.Name) == a.Id);
    // TODO(api): EntityContext.MListRowId (MList row-id helper) in a query
    test("RowIdMListMember", { skip: true }, async () => {
        // const authors = await table(AlbumEntity)
        //     .count(a => EntityContext.mListRowId(a.songs.firstOrNull()!.name) == (a.id as number));
        // assert.ok(authors >= 0);
    });
});
