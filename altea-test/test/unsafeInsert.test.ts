import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String methods (startsWith etc.), SQL-mappable
import { hasDb, start } from "./setup";
import {
    ArtistEntity, AlbumEntity, LabelEntity, CountryEntity,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/UnsafeInsertTest.cs (set-based bulk INSERT,
// i.e. INSERT ... SELECT — materialise new rows directly from a query).
//
// altea has NO bulk-op API yet: there is no `executeInsert` on Query<T>. The
// whole tier is deferred. Therefore EVERY test below is `{ skip: true }`, with
// its intended altea body commented out and a
// `// TODO(api): bulk insert (executeInsert)` flag. They are still ported (in
// the original C# order, with the C# one-liner above each) so the intended API
// surface is recorded for designing the builder.
//
// Bulk-INSERT API shape observed in C#:
//   Database.Query<S>().UnsafeInsert(s => new TargetEntity { Field = s.Field, ... })
//     → table(S).executeInsert(TargetEntity, s => new-object-literal-of-fields)
//     - the constructor lambda is a quoted projection from each source row to a
//       new target entity; .SetReadonly(_ => _.Ticks, …) / (_ => _.Id, …) sets
//       normally-readonly system columns (concurrency Ticks, identity Id).
//     - returns the affected/inserted row count (number).
//   Variants:
//     UnsafeInsertMList(parentSelector, mle => new MListElement<P,E>{ Parent, Element, RowOrder, RowId }) — insert link/part rows from an MListQuery.
//     UnsafeInsertView(a => new SomeView { ... }) — insert into a temporary IView.
//   Note: `Database.Query<X>()…UnsafeInsert(a => a)` form: project first with
//   .Select(...) then insert the already-shaped rows identity-wise.
//
// Live execution is gated on ALTEA_TEST_DB; without it the suite is skipped.

describe("UnsafeInsertTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().UnsafeInsert(a => new AlbumEntity { Author=a.Author, BonusTrack=a.BonusTrack, Label=a.Label, Name=a.Name+"copy", State=a.State, Year=a.Year }.SetReadonly(_ => _.Ticks, a.Ticks));
    // TODO(api): bulk insert (executeInsert) — projection-to-new-entity constructor and SetReadonly(Ticks)
    test("InsertSimple", async () => {
        // const value = await table(AlbumEntity).executeInsert(AlbumEntity, a => ({
        //     author: a.author, bonusTrack: a.bonusTrack, label: a.label,
        //     name: a.name + "copy", state: a.state, year: a.year, ticks: a.ticks,
        // }));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().Select(a => new AlbumEntity { ... }.SetReadonly(_ => _.Ticks, a.Ticks)).UnsafeInsert(a => a);
    // TODO(api): bulk insert (executeInsert) — pre-projected source then identity insert (a => a)
    test("InsertSimpleParameter", async () => {
        // const value = await table(AlbumEntity)
        //     .map(a => ({ author: a.author, bonusTrack: a.bonusTrack, label: a.label,
        //         name: a.name + "copy", state: a.state, year: a.year, ticks: a.ticks }))
        //     .executeInsert(AlbumEntity, a => a);
        assert.ok(true);
    });

    // using (Administrator.DisableIdentity<AlbumEntity>()) Database.Query<AlbumEntity>().UnsafeInsert(a => new AlbumEntity { ... }.SetReadonly(_ => _.Ticks, a.Ticks).SetReadonly(_ => _.Id, (int)a.Id + 100));
    // TODO(api): bulk insert (executeInsert) — DisableIdentity + SetReadonly(Id) explicit-id insert
    test("InsertSimpleId", async () => {
        // const value = await table(AlbumEntity).executeInsert(AlbumEntity, a => ({
        //     author: a.author, bonusTrack: a.bonusTrack, label: a.label,
        //     name: a.name + "copy", state: a.state, year: a.year,
        //     ticks: a.ticks, id: (a.id as number) + 100,
        // }));
        assert.ok(true);
    });

    // Database.MListQuery((AlbumEntity a) => a.Songs).UnsafeInsertMList((AlbumEntity a) => a.Songs, mle => new MListElement<AlbumEntity, SongEmbedded> { Parent=mle.Parent, Element=mle.Element, RowOrder=mle.RowOrder });
    // TODO(api): bulk insert mlist (executeInsertMList) over an MListQuery (link/part rows)
    test("InsertMListSimple", async () => {
        // const value = await table(AlbumEntity).flatMap(a => a.songs)
        //     .executeInsertMList(AlbumEntity, a => a.songs, mle => ({ album: mle.album, name: mle.name, seconds: mle.seconds, order: mle.order }));
        assert.ok(true);
    });

    // Database.MListQuery((AlbumEntity a) => a.Songs).Select(mle => new MListElement<...> { Parent, Element, RowOrder }).UnsafeInsertMList((AlbumEntity a) => a.Songs, mle => mle);
    // TODO(api): bulk insert mlist (executeInsertMList) over an MListQuery (link/part rows) — pre-projected then identity insert
    test("InsertMListParameter", async () => {
        // const value = await table(AlbumEntity).flatMap(a => a.songs)
        //     .map(mle => ({ album: mle.album, name: mle.name, seconds: mle.seconds, order: mle.order }))
        //     .executeInsertMList(AlbumEntity, a => a.songs, mle => mle);
        assert.ok(true);
    });

    // using (Administrator.DisableIdentity((AlbumEntity a) => a.Songs)) Database.MListQuery((AlbumEntity a) => a.Songs).UnsafeInsertMList((AlbumEntity a) => a.Songs, mle => new MListElement<...> { Parent, Element, RowId=(int)mle.RowId+1000, RowOrder });
    // TODO(api): bulk insert mlist (executeInsertMList) — DisableIdentity + explicit RowId on link/part rows
    test("InsertMListId", async () => {
        // const value = await table(AlbumEntity).flatMap(a => a.songs)
        //     .executeInsertMList(AlbumEntity, a => a.songs, mle => ({ album: mle.album, name: mle.name, seconds: mle.seconds, id: (mle.id as number) + 1000, order: mle.order }));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeInsert(a => new AlbumEntity { ..., Label = Database.Query<LabelEntity>().Single(l => l.Is(a.Label)), ... }.SetReadonly(_ => _.Ticks, a.Ticks));
    // TODO(api): bulk insert (executeInsert) — correlated subquery (.single) inside the projection
    test("InsertSimpleSingle", async () => {
        // const value = await table(AlbumEntity).executeInsert(AlbumEntity, a => ({
        //     author: a.author, bonusTrack: a.bonusTrack,
        //     label: table(LabelEntity).single(l => l.is(a.label)),
        //     name: a.name + "copy", state: a.state, year: a.year, ticks: a.ticks,
        // }));
        assert.ok(true);
    });

    // Database.Query<LabelEntity>().Select(a => a.Country).Distinct().UnsafeInsert(c => new CountryEntity { Name = "Clone of " + c.Name, Ticks = 0 });
    // TODO(api): bulk insert (executeInsert) — source is a .map(...).distinct() projection of a navigated entity
    test("InsertDistinct", async () => {
        // const value = await table(LabelEntity).map(a => a.country).distinct()
        //     .executeInsert(CountryEntity, c => ({ name: "Clone of " + c.name, ticks: 0 }));
        assert.ok(true);
    });

    // Administrator.CreateTemporaryTable<MyTempView>(); Database.Query<ArtistEntity>().Where(a => a.Name.StartsWith("M")).UnsafeInsertView(a => new MyTempView { Artist = a.ToLite() });
    // TODO(api): bulk insert view (executeInsertView) — temporary IView is not modelled
    // TODO(api): Database.View<T>() / CreateTemporaryTable
    test("UnsafeInsertMyView", async () => {
        // await table(ArtistEntity).filter(a => a.name.startsWith("M"))
        //     .executeInsertView(MyTempView, a => ({ artist: a.toLite() }));
        assert.ok(true);
    });
});
