import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { hasDb, start } from "./setup";
import {
    ArtistEntity, AlbumEntity, BandEntity,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/UnsafeDeleteTest.cs (set-based bulk DELETE).
//
// altea has NO bulk-op API yet: there is no `executeDelete` on Query<T>. The
// whole tier is deferred. Therefore EVERY test below is `{ skip: true }`, with
// its intended altea body commented out and a
// `// TODO(api): bulk delete (executeDelete)` flag. They are still ported (in
// the original C# order, with the C# one-liner above each) so the intended API
// surface is recorded for designing the operation.
//
// Bulk-DELETE API shape observed in C#:
//   Database.Query<T>().UnsafeDelete()                 → table(T).executeDelete()
//   Database.Query<T>().Where(pred).UnsafeDelete()     → table(T).filter(pred).executeDelete()
//     - terminal; returns the deleted row count (number).
//   Variants:
//     UnsafeDeleteChunks(n)  → delete in batches of n (executeDeleteChunks(n)).
//     UnsafeDeleteMList()    → delete link/part rows from an MListQuery (executeDeleteMList).
//     UnsafeDeleteView()     → delete rows of a temporary IView (executeDeleteView).
//   (DeleteManual is NOT a bulk op — it retrieves Lites then Database.DeleteList,
//    i.e. per-row entity deletes; recorded for completeness.)
//
// Live execution is gated on ALTEA_TEST_DB; without it the suite is skipped.

describe("UnsafeDeleteTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // int count = Database.Query<AlbumEntity>().UnsafeDelete();
    // TODO(api): bulk delete (executeDelete)
    test("DeleteAll", { skip: true }, async () => {
        // const count = await table(AlbumEntity).executeDelete();
        assert.ok(true);
    });

    // int count = Database.Query<AlbumEntity>().Where(a => a.Year < 1990).UnsafeDelete();
    // TODO(api): bulk delete (executeDelete)
    test("Delete", { skip: true }, async () => {
        // const count = await table(AlbumEntity).filter(a => a.year < 1990).executeDelete();
        assert.ok(true);
    });

    // int count = Database.Query<AlbumEntity>().UnsafeDeleteChunks(2);
    // TODO(api): bulk delete (executeDeleteChunks) — chunked/batched delete
    test("DeleteChunks", { skip: true }, async () => {
        // const count = await table(AlbumEntity).executeDeleteChunks(2);
        assert.ok(true);
    });

    // int count = Database.Query<AlbumEntity>().Where(a => ((ArtistEntity)a.Author).Dead).UnsafeDelete();
    // TODO(api): bulk delete (executeDelete)
    // TODO(api): entity cast in query ((x as ArtistEntity)) — joins to the cast subtable
    test("DeleteJoin", { skip: true }, async () => {
        // const count = await table(AlbumEntity).filter(a => (a.author as ArtistEntity).dead).executeDelete();
        assert.ok(true);
    });

    // int count = Database.MListQuery((ArtistEntity a) => a.Friends).UnsafeDeleteMList();
    // TODO(api): bulk delete mlist (executeDeleteMList) over an MListQuery (link/part rows)
    test("DeleteMListLite", { skip: true }, async () => {
        // const count = await table(ArtistEntity).flatMap(a => a.friends).executeDeleteMList();
        assert.ok(true);
    });

    // int count = Database.MListQuery((BandEntity a) => a.Members).UnsafeDeleteMList();
    // TODO(api): bulk delete mlist (executeDeleteMList) over an MListQuery (link/part rows)
    test("DeleteMListEntity", { skip: true }, async () => {
        // const count = await table(BandEntity).flatMap(a => a.members).executeDeleteMList();
        assert.ok(true);
    });

    // int count = Database.MListQuery((AlbumEntity a) => a.Songs).UnsafeDeleteMList();
    // TODO(api): bulk delete mlist (executeDeleteMList) over an MListQuery (link/part rows)
    test("DeleteMListEmbedded", { skip: true }, async () => {
        // const count = await table(AlbumEntity).flatMap(a => a.songs).executeDeleteMList();
        assert.ok(true);
    });

    // var list = Database.Query<AlbumEntity>().Where(a => ((ArtistEntity)a.Author).Dead).Select(a => a.ToLite()).ToList(); Database.DeleteList(list);
    // TODO(api): per-row delete of a Lite list (Database.DeleteList) — not a bulk set-based op
    // TODO(api): entity cast in query ((x as ArtistEntity))
    test("DeleteManual", { skip: true }, async () => {
        // const list = await table(AlbumEntity).filter(a => (a.author as ArtistEntity).dead).map(a => a.toLite()).toArray();
        // await deleteList(list);
        assert.ok(true);
    });

    // Administrator.CreateTemporaryTable<MyTempView>(); UnsafeInsertView(...); Database.View<MyTempView>().Where(a => a.MyId > 1).UnsafeDeleteView();
    // TODO(api): bulk delete view (executeDeleteView) — temporary IView is not modelled
    // TODO(api): Database.View<T>() / CreateTemporaryTable
    test("UnsafeDeleteMyView", { skip: true }, async () => {
        assert.ok(true);
    });
});
