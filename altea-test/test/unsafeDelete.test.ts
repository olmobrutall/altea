import { before, describe } from "node:test";
import assert from "node:assert/strict";
import { table, view } from "@altea/altea/logic/table";
import { hasDb, start, txTest } from "./setup";
import {
    ArtistEntity, AlbumEntity, BandEntity,
    ArtistEntity_Friends, BandEntity_Members, AlbumEntity_Songs,
    MyTempView2,
} from "../entities/music";
import { deleteList } from "@altea/altea/logic/Database";
import { Administrator } from "@altea/altea/logic/Administrator";
import { toInt } from "@altea/altea/entities/basics";

// Port of Signum.Test/LinqProvider/UnsafeDeleteTest.cs (set-based bulk DELETE).
//
// altea's bulk-DELETE API (Signum's `Query<T>().[Where(pred).]UnsafeDelete()`):
//   table(T)[.filter(pred)].executeDelete()            → affected row count (terminal).
//   table(T).executeDeleteChunks(n)                    → delete in batches of n rows.
// altea models MLists as part-entity tables, so Signum's `MListQuery(...).UnsafeDeleteMList()`
// is just `executeDelete` over the part-entity table (e.g. ArtistEntity_Friends) — no separate
// API. executeDelete over a `view(...)` is UnsafeDeleteView (the target is the temp table).
//
// Runs inside txTest (Transaction.noCommit): the DELETE happens and the body sees it, then it is
// rolled back. Live execution is gated on ALTEA_TEST_DB; without it the suite is skipped.

describe("UnsafeDeleteTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // int count = Database.Query<AlbumEntity>().UnsafeDelete();
    txTest("DeleteAll", async () => {
        const count = await table(AlbumEntity).executeDelete();
        assert.ok(count > 0);
        assert.equal(await table(AlbumEntity).count(), 0);
    });

    // int count = Database.Query<AlbumEntity>().Where(a => a.Year < 1990).UnsafeDelete();
    txTest("Delete", async () => {
        const count = await table(AlbumEntity).filter(a => a.year < 1990).executeDelete();
        assert.ok(count >= 0);
        assert.equal(await table(AlbumEntity).count(a => a.year < 1990), 0);
    });

    // int count = Database.Query<AlbumEntity>().UnsafeDeleteChunks(2);
    txTest("DeleteChunks", async () => {
        const count = await table(AlbumEntity).executeDeleteChunks(2);
        assert.ok(count > 0);
        assert.equal(await table(AlbumEntity).count(), 0);
    });

    // int count = Database.Query<AlbumEntity>().Where(a => ((ArtistEntity)a.Author).Dead).UnsafeDelete();
    txTest("DeleteJoin", async () => {
        const count = await table(AlbumEntity).filter(a => (a.author as ArtistEntity).dead).executeDelete();
        assert.ok(count >= 0);
    });

    // int count = Database.MListQuery((ArtistEntity a) => a.Friends).UnsafeDeleteMList();
    // Divergence: altea models the MList as the ArtistEntity_Friends part entity, so this is a
    // plain executeDelete over that table — no MListQuery / UnsafeDeleteMList API needed.
    txTest("DeleteMListLite", async () => {
        const count = await table(ArtistEntity_Friends).executeDelete();
        assert.ok(count >= 0);
        assert.equal(await table(ArtistEntity_Friends).count(), 0);
    });

    // int count = Database.MListQuery((BandEntity a) => a.Members).UnsafeDeleteMList();
    txTest("DeleteMListEntity", async () => {
        const count = await table(BandEntity_Members).executeDelete();
        assert.ok(count >= 0);
        assert.equal(await table(BandEntity_Members).count(), 0);
    });

    // int count = Database.MListQuery((AlbumEntity a) => a.Songs).UnsafeDeleteMList();
    txTest("DeleteMListEmbedded", async () => {
        const count = await table(AlbumEntity_Songs).executeDelete();
        assert.ok(count >= 0);
        assert.equal(await table(AlbumEntity_Songs).count(), 0);
    });

    // var list = Database.Query<AlbumEntity>().Where(a => ((ArtistEntity)a.Author).Dead).Select(a => a.ToLite()).ToList(); Database.DeleteList(list);
    // Divergence: not a bulk set-based op — retrieves the Lite list, then per-row entity deletes.
    txTest("DeleteManual", async () => {
        const list = await table(AlbumEntity).filter(a => (a.author as ArtistEntity).dead).map(a => a.toLite()).toArray();
        await deleteList(list);
        assert.equal(await table(AlbumEntity).count(a => (a.author as ArtistEntity).dead), 0);
    });

    // Administrator.CreateTemporaryTable<MyTempView>(); UnsafeInsertView(...); Database.View<MyTempView>().Where(a => a.MyId > 1).UnsafeDeleteView();
    // altea: executeDelete over the view is UnsafeDeleteView (the target is the temp table);
    // the delete correlates by MyTempView2's @viewPrimaryKey (myId). Runs on one pinned connection.
    txTest("UnsafeDeleteMyView", async () => {
        await Administrator.createTemporaryTable(MyTempView2);
        await table(ArtistEntity).executeInsert(MyTempView2, a => ({ myId: toInt(a.id as number), used: false }));

        const count = await view(MyTempView2).filter(a => a.myId > 1).executeDelete();
        assert.ok(count >= 0);
        assert.equal(await view(MyTempView2).count(a => a.myId > 1), 0);
    });
});
