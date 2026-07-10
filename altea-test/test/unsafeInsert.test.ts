import { before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String methods (startsWith etc.), SQL-mappable
import { hasDb, start, txTest } from "./setup";
import {
    ArtistEntity, AlbumEntity, LabelEntity, CountryEntity,
    AlbumEntity_Songs, MyTempView,
} from "../entities/music";
import { Administrator } from "@altea/altea/logic/Administrator";

// Port of Signum.Test/LinqProvider/UnsafeInsertTest.cs (set-based bulk INSERT,
// i.e. INSERT ... SELECT — materialise new rows directly from a query).
//
// altea's bulk-INSERT API (Signum's `Query<S>().UnsafeInsert(s => new Target { ... })`):
//   table(S)[.filter(...)][.map(...)][.distinct()].executeInsert(Target, s => setterLiteral)
//     - the setter object literal is a quoted projection from each source row to the target's
//       columns; normally-readonly system columns (concurrency `ticks`, identity `id`) may be
//       set explicitly (Signum's SetReadonly / DisableIdentity).  → returns inserted row count.
//   Identity form: pre-project with `.map(...)` then `executeInsert(Target, a => a)`.
// altea models MLists as part-entity tables, so Signum's `UnsafeInsertMList(...)` is just
// executeInsert over the part-entity table (e.g. AlbumEntity_Songs). executeInsert whose target
// is a temp-table view is UnsafeInsertView.
//
// Runs inside txTest (Transaction.noCommit): the INSERT happens and the body sees it, then it is
// rolled back. Live execution is gated on ALTEA_TEST_DB; without it the suite is skipped.

describe("UnsafeInsertTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().UnsafeInsert(a => new AlbumEntity { Author=a.Author, BonusTrack=a.BonusTrack, Label=a.Label, Name=a.Name+"copy", State=a.State, Year=a.Year }.SetReadonly(_ => _.Ticks, a.Ticks));
    txTest("InsertSimple", async () => {
        const before = await table(AlbumEntity).count();
        const value = await table(AlbumEntity).executeInsert(AlbumEntity, a => ({
            author: a.author, bonusTrack: a.bonusTrack, label: a.label,
            name: a.name + "copy", state: a.state, year: a.year, ticks: a.ticks,
        }));
        assert.ok(value > 0);
        assert.equal(await table(AlbumEntity).count(), before + value);
    });

    // Database.Query<AlbumEntity>().Select(a => new AlbumEntity { ... }.SetReadonly(_ => _.Ticks, a.Ticks)).UnsafeInsert(a => a);
    txTest("InsertSimpleParameter", async () => {
        const before = await table(AlbumEntity).count();
        const value = await table(AlbumEntity)
            .map(a => ({ author: a.author, bonusTrack: a.bonusTrack, label: a.label,
                name: a.name + "copy", state: a.state, year: a.year, ticks: a.ticks }))
            .executeInsert(AlbumEntity, a => a);
        assert.ok(value > 0);
        assert.equal(await table(AlbumEntity).count(), before + value);
    });

    // using (Administrator.DisableIdentity<AlbumEntity>()) Database.Query<AlbumEntity>().UnsafeInsert(a => new AlbumEntity { ... }.SetReadonly(_ => _.Ticks, a.Ticks).SetReadonly(_ => _.Id, (int)a.Id + 100));
    txTest("InsertSimpleId", async () => {
        const before = await table(AlbumEntity).count();
        const value = await table(AlbumEntity).executeInsert(AlbumEntity, a => ({
            author: a.author, bonusTrack: a.bonusTrack, label: a.label,
            name: a.name + "copy", state: a.state, year: a.year,
            ticks: a.ticks, id: (a.id as number) + 100,
        }));
        assert.ok(value > 0);
        assert.equal(await table(AlbumEntity).count(), before + value);
    });

    // Database.MListQuery((AlbumEntity a) => a.Songs).UnsafeInsertMList((AlbumEntity a) => a.Songs, mle => new MListElement<AlbumEntity, SongEmbedded> { Parent=mle.Parent, Element=mle.Element, RowOrder=mle.RowOrder });
    // Divergence: the MList is the AlbumEntity_Songs part entity, so this is a plain executeInsert.
    txTest("InsertMListSimple", async () => {
        const before = await table(AlbumEntity_Songs).count();
        const value = await table(AlbumEntity_Songs)
            .executeInsert(AlbumEntity_Songs, mle => ({ album: mle.album, name: mle.name, seconds: mle.seconds, index: mle.index, order: mle.order }));
        assert.ok(value > 0);
        assert.equal(await table(AlbumEntity_Songs).count(), before + value);
    });

    // Database.MListQuery((AlbumEntity a) => a.Songs).Select(mle => new MListElement<...> { Parent, Element, RowOrder }).UnsafeInsertMList((AlbumEntity a) => a.Songs, mle => mle);
    txTest("InsertMListParameter", async () => {
        const before = await table(AlbumEntity_Songs).count();
        const value = await table(AlbumEntity_Songs)
            .map(mle => ({ album: mle.album, name: mle.name, seconds: mle.seconds, index: mle.index, order: mle.order }))
            .executeInsert(AlbumEntity_Songs, mle => mle);
        assert.ok(value > 0);
        assert.equal(await table(AlbumEntity_Songs).count(), before + value);
    });

    // using (Administrator.DisableIdentity((AlbumEntity a) => a.Songs)) Database.MListQuery((AlbumEntity a) => a.Songs).UnsafeInsertMList((AlbumEntity a) => a.Songs, mle => new MListElement<...> { Parent, Element, RowId=(int)mle.RowId+1000, RowOrder });
    txTest("InsertMListId", async () => {
        const before = await table(AlbumEntity_Songs).count();
        const value = await table(AlbumEntity_Songs)
            .executeInsert(AlbumEntity_Songs, mle => ({ album: mle.album, name: mle.name, seconds: mle.seconds, index: mle.index, id: (mle.id as number) + 1000, order: mle.order }));
        assert.ok(value > 0);
        assert.equal(await table(AlbumEntity_Songs).count(), before + value);
    });

    // Database.Query<AlbumEntity>().UnsafeInsert(a => new AlbumEntity { ..., Label = Database.Query<LabelEntity>().Single(l => l.Is(a.Label)), ... }.SetReadonly(_ => _.Ticks, a.Ticks));
    // The correlated `.single(...)` is a scalar subquery for the label FK; `.$v` casts its
    // Promise<LabelEntity> to the entity so it fits the setter (the binder passes a nested unique
    // terminal's projector straight through — see QueryBinder.bindMember `$v`).
    txTest("InsertSimpleSingle", async () => {
        const before = await table(AlbumEntity).count();
        const value = await table(AlbumEntity).executeInsert(AlbumEntity, a => ({
            author: a.author, bonusTrack: a.bonusTrack,
            label: table(LabelEntity).single(l => l.is(a.label)).$v,
            name: a.name + "copy", state: a.state, year: a.year, ticks: a.ticks,
        }));
        assert.ok(value > 0);
        assert.equal(await table(AlbumEntity).count(), before + value);
    });

    // Database.Query<LabelEntity>().Select(a => a.Country).Distinct().UnsafeInsert(c => new CountryEntity { Name = "Clone of " + c.Name, Ticks = 0 });
    txTest("InsertDistinct", async () => {
        const before = await table(CountryEntity).count();
        const value = await table(LabelEntity).map(a => a.country).distinct()
            .executeInsert(CountryEntity, c => ({ name: "Clone of " + c.name, ticks: 0 }));
        assert.ok(value > 0);
        assert.equal(await table(CountryEntity).count(), before + value);
    });

    // Administrator.CreateTemporaryTable<MyTempView>(); Database.Query<ArtistEntity>().Where(a => a.Name.StartsWith("M")).UnsafeInsertView(a => new MyTempView { Artist = a.ToLite() });
    txTest("UnsafeInsertMyView", async () => {
        await Administrator.createTemporaryTable(MyTempView);
        // UnsafeInsertView is just an UnsafeInsert whose target is the temp-table view.
        const value = await table(ArtistEntity).filter(a => a.name.startsWith("M"))
            .executeInsert(MyTempView, a => ({ artist: a.toLite() }));
        assert.ok(value >= 0);
    });
});
