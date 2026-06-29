import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String methods (toUpperCase etc.), SQL-mappable
import { hasDb, start } from "./setup";
import {
    ArtistEntity, AlbumEntity, BandEntity, LabelEntity,
    NoteWithDateEntity, SongEmbedded,
    Sex,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/UnsafeUpdateTest.cs (set-based bulk UPDATE).
//
// altea has NO bulk-op API yet: there is no `executeUpdate` (nor Set/Execute
// builder) on Query<T>. The whole tier is deferred. Therefore EVERY test below
// is `{ skip: true }`, with its intended altea body commented out and a
// `// TODO(api): bulk update (executeUpdate)` flag. They are still ported (in
// the original C# order, with the C# one-liner above each) so the intended API
// surface is recorded for designing the builder.
//
// Bulk-UPDATE API shape observed in C#:
//   Database.Query<T>().UnsafeUpdate().Set(a => a.Field, a => valueExpr).Execute()
//     → table(T).executeUpdate(u => u.set(a => a.field, a => valueExpr)) — or a
//       fluent .executeUpdate().set(...).set(...).execute() builder.
//   - .Where(...) before .UnsafeUpdate() filters the rows to update.
//   - .Set takes (memberSelector, valueSelector); both are quoted lambdas over
//     the row; multiple .Set calls chain.
//   - .Execute() returns the affected row count (number).
//   - Variants: UnsafeUpdatePart(selector) (update a *navigated* entity via a
//     projection), UnsafeUpdateMList()/UnsafeUpdateMListPart() (update link/part
//     rows from an MListQuery), UnsafeUpdateView() (update a temp IView).
//
// Live execution is gated on ALTEA_TEST_DB; without it the suite is skipped.

describe("UnsafeUpdateTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Year, a => a.Year * 2).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateValue", { skip: true }, async () => {
        // const count = await table(AlbumEntity).executeUpdate(u => u.set(a => a.year, a => a.year * 2));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Name, a => a.Name.ToUpper()).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateValueSqlFunction", { skip: true }, async () => {
        // const count = await table(AlbumEntity).executeUpdate(u => u.set(a => a.name, a => a.name.toUpperCase()));
        assert.ok(true);
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Title, a => null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateValueNull", { skip: true }, async () => {
        // const count = await table(NoteWithDateEntity).executeUpdate(u => u.set(a => a.title, a => null));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().Where(a => a.Year < 1990).UnsafeUpdate().Set(a => a.Year, a => 1990).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateValueConstant", { skip: true }, async () => {
        // const count = await table(AlbumEntity).filter(a => a.year < 1990).executeUpdate(u => u.set(a => a.year, a => 1990));
        assert.ok(true);
    });

    // Database.Query<ArtistEntity>().UnsafeUpdate().Set(a => a.Sex, a => Sex.Male).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateEnumConstant", { skip: true }, async () => {
        // const count = await table(ArtistEntity).executeUpdate(u => u.set(a => a.sex, a => Sex.Male));
        assert.ok(true);
    });

    // Database.Query<ArtistEntity>().UnsafeUpdate().Set(a => a.Sex, a => a.Sex == Sex.Female ? Sex.Male : Sex.Female).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateEnum", { skip: true }, async () => {
        // const count = await table(ArtistEntity)
        //     .executeUpdate(u => u.set(a => a.sex, a => a.sex == Sex.Female ? Sex.Male : Sex.Female));
        assert.ok(true);
    });

    // SongEmbedded song = new(){ Name="Mana Mana", Duration=184s };
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => song).Execute();
    // Assert.False(Any(a => a.BonusTrack == null)); Assert.Equal("Mana Mana", Select(a => a.BonusTrack.Try(b => b.Name)).Distinct().SingleEx());
    // TODO(api): bulk update (executeUpdate)
    test("UpdateEfie", { skip: true }, async () => {
        // const song = new SongEmbedded();
        // song.name = "Mana Mana";
        // const count = await table(AlbumEntity).executeUpdate(u => u.set(a => a.bonusTrack, a => song));
        // assert.equal(await table(AlbumEntity).some(a => a.bonusTrack == null), false);
        // assert.equal(await table(AlbumEntity).map(a => a.bonusTrack.name).distinct().single(), "Mana Mana");
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => null).Execute();
    // Assert.True(All(a => a.BonusTrack == null)); Assert.True(All(a => a.BonusTrack.Try(bt => bt.Name) == null));
    // TODO(api): bulk update (executeUpdate)
    test("UpdateEfieNull", { skip: true }, async () => {
        // const count = await table(AlbumEntity).executeUpdate(u => u.set(a => a.bonusTrack, a => null));
        // assert.ok(await table(AlbumEntity).every(a => a.bonusTrack == null));
        assert.ok(true);
    });

    // SongEmbedded song = new(){ Name="Mana Mana", Duration=184s };
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => (int)a.Id % 2 == 0 ? song : null).Execute();
    // Assert.True(All(a => (int)a.Id % 2 == 0 ? a.BonusTrack.Try(b => b.Name) == "Mana Mana" : a.BonusTrack.Try(b => b.Name) == null));
    // TODO(api): bulk update (executeUpdate)
    test("UpdateEfieConditional", { skip: true }, async () => {
        // const song = new SongEmbedded();
        // song.name = "Mana Mana";
        // const count = await table(AlbumEntity)
        //     .executeUpdate(u => u.set(a => a.bonusTrack, a => (a.id as number) % 2 == 0 ? song : null));
        assert.ok(true);
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => label).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateFie", { skip: true }, async () => {
        // const label = await table(LabelEntity).first();
        // const count = await table(AlbumEntity).executeUpdate(u => u.set(a => a.label, a => label));
        assert.ok(true);
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => (int)a.Id % 2 == 0 ? label : null).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateFieConditional", { skip: true }, async () => {
        // const label = await table(LabelEntity).first();
        // const count = await table(AlbumEntity)
        //     .executeUpdate(u => u.set(a => a.label, a => (a.id as number) % 2 == 0 ? label : null));
        assert.ok(true);
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => label).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateFieSetReadonly", { skip: true }, async () => {
        // const label = await table(LabelEntity).first();
        // const count = await table(AlbumEntity).executeUpdate(u => u.set(a => a.label, a => label));
        assert.ok(true);
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Mixin<CorruptMixin>().Corrupt, a => true).Execute();
    // TODO(api): bulk update (executeUpdate)
    // TODO(api): CorruptMixin (not modelled)
    test("UpdateMixin", { skip: true }, async () => {
        // const count = await table(NoteWithDateEntity)
        //     .executeUpdate(u => u.set(a => a.mixin(CorruptMixin).corrupt, a => true));
        assert.ok(true);
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<LabelEntity>().UnsafeUpdate().Set(a => a.Owner, a => label.ToLite()).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateFieToLite", { skip: true }, async () => {
        // const label = await table(LabelEntity).first();
        // const count = await table(LabelEntity).executeUpdate(u => u.set(a => a.owner, a => label.toLite()));
        assert.ok(true);
    });

    // LabelEntity label = new LabelEntity();
    // Assert.Throws<InvalidOperationException>(() => Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => label).Execute()); Assert.Contains("is new and has no Id", e.Message);
    // TODO(api): bulk update (executeUpdate)
    test("UpdateFieNew", { skip: true }, async () => {
        // const label = new LabelEntity();
        // await assert.rejects(
        //     async () => table(AlbumEntity).executeUpdate(u => u.set(a => a.label, a => label)),
        //     /is new and has no Id/);
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateFieNull", { skip: true }, async () => {
        // const count = await table(AlbumEntity).executeUpdate(u => u.set(a => a.label, a => null));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Author, a => michael).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateIbFie", { skip: true }, async () => {
        // const michael = await table(ArtistEntity).single(a => a.dead);
        // const count = await table(AlbumEntity).executeUpdate(u => u.set(a => a.author, a => michael));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Author, a => a.Id > 1 ? michael : null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateIbFieConditional", { skip: true }, async () => {
        // const michael = await table(ArtistEntity).single(a => a.dead);
        // const count = await table(AlbumEntity)
        //     .executeUpdate(u => u.set(a => a.author, a => (a.id as number) > 1 ? michael : null));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Author, a => null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateIbNull", { skip: true }, async () => {
        // const count = await table(AlbumEntity).executeUpdate(u => u.set(a => a.author, a => null));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => michael).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateIbaFie", { skip: true }, async () => {
        // const michael = await table(ArtistEntity).single(a => a.dead);
        // const count = await table(NoteWithDateEntity).executeUpdate(u => u.set(a => a.target, a => michael));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => michael.ToLite()).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateIbaLiteFie", { skip: true }, async () => {
        // const michael = await table(ArtistEntity).single(a => a.dead);
        // const count = await table(NoteWithDateEntity).executeUpdate(u => u.set(a => a.otherTarget, a => michael.toLite()));
        assert.ok(true);
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateIbaNull", { skip: true }, async () => {
        // const count = await table(NoteWithDateEntity).executeUpdate(u => u.set(a => a.target, a => null));
        assert.ok(true);
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => null).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateIbaLiteNull", { skip: true }, async () => {
        // const count = await table(NoteWithDateEntity).executeUpdate(u => u.set(a => a.otherTarget, a => null));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => a.CreationTime > Clock.Now ? michael : null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    // TODO(api): Clock.Now (server-now constant) in query
    test("UpdateIbaConditional", { skip: true }, async () => {
        // const michael = await table(ArtistEntity).single(a => a.dead);
        // const count = await table(NoteWithDateEntity)
        //     .executeUpdate(u => u.set(a => a.target, a => a.creationTime > Clock.now ? michael : null));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => a.CreationTime > Clock.Now ? michael.ToLite() : null).Execute();
    // TODO(api): bulk update (executeUpdate)
    // TODO(api): Clock.Now (server-now constant) in query
    test("UpdateIbaLiteConditional", { skip: true }, async () => {
        // const michael = await table(ArtistEntity).single(a => a.dead);
        // const count = await table(NoteWithDateEntity)
        //     .executeUpdate(u => u.set(a => a.otherTarget, a => a.creationTime > Clock.now ? michael.toLite() : null));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => a.Target ?? michael).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateIbaCoalesce", { skip: true }, async () => {
        // const michael = await table(ArtistEntity).single(a => a.dead);
        // const count = await table(NoteWithDateEntity).executeUpdate(u => u.set(a => a.target, a => a.target ?? michael));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => a.OtherTarget ?? michael.ToLite()).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateIbaLiteCoalesce", { skip: true }, async () => {
        // const michael = await table(ArtistEntity).single(a => a.dead);
        // const count = await table(NoteWithDateEntity)
        //     .executeUpdate(u => u.set(a => a.otherTarget, a => a.otherTarget ?? michael.toLite()));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack!.Name, a => a.BonusTrack!.Name + " - ").Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateEmbeddedField", { skip: true }, async () => {
        // const count = await table(AlbumEntity)
        //     .executeUpdate(u => u.set(a => a.bonusTrack!.name, a => a.bonusTrack!.name + " - "));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => null).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UpdateEmbeddedNull", { skip: true }, async () => {
        // const count = await table(AlbumEntity).executeUpdate(u => u.set(a => a.bonusTrack, a => null));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().Select(a => new { a.Label, Album = a }).UnsafeUpdatePart(p => p.Label!).Set(a => a.Name, p => p.Label!.Name + "/" + p.Album!.Id).Execute();
    // TODO(api): bulk update part (executeUpdatePart) — update a navigated entity from a projection
    test("UnsafeUpdatePart", { skip: true }, async () => {
        // const count = await table(AlbumEntity)
        //     .map(a => ({ label: a.label, album: a }))
        //     .executeUpdatePart(p => p.label, u => u.set(x => x.name, p => p.label.name + "/" + (p.album.id as string)));
        assert.ok(true);
    });

    // ArtistEntity artist = Database.Query<ArtistEntity>().FirstEx();
    // Database.MListQuery((ArtistEntity a) => a.Friends).UnsafeUpdateMList().Set(mle => mle.Element, mle => artist.ToLite()).Set(mle => mle.Parent, mle => artist).Execute();
    // TODO(api): bulk update mlist (executeUpdateMList) over an MListQuery (link/part rows)
    test("UpdateMListLite", { skip: true }, async () => {
        // const artist = await table(ArtistEntity).first();
        // const count = await table(ArtistEntity).flatMap(a => a.friends)
        //     .executeUpdateMList(u => u.set(mle => mle.friend, mle => artist.toLite()).set(mle => mle.artist, mle => artist.toLite()));
        assert.ok(true);
    });

    // ArtistEntity artist = Database.Query<ArtistEntity>().FirstEx();
    // Database.MListQuery((BandEntity a) => a.Members).UnsafeUpdateMList().Set(mle => mle.Element, mle => artist).Execute();
    // TODO(api): bulk update mlist (executeUpdateMList) over an MListQuery (link/part rows)
    test("UpdateMListEntity", { skip: true }, async () => {
        // const artist = await table(ArtistEntity).first();
        // const count = await table(BandEntity).flatMap(a => a.members)
        //     .executeUpdateMList(u => u.set(mle => mle.member, mle => artist.toLite()));
        assert.ok(true);
    });

    // Database.MListQuery((AlbumEntity a) => a.Songs).UnsafeUpdateMList().Set(mle => mle.Element.Seconds, mle => 3).Execute();
    // TODO(api): bulk update mlist (executeUpdateMList) over an MListQuery (link/part rows)
    test("UpdateMListEmbedded", { skip: true }, async () => {
        // const count = await table(AlbumEntity).flatMap(a => a.songs)
        //     .executeUpdateMList(u => u.set(mle => mle.seconds, mle => 3));
        assert.ok(true);
    });

    // (from a from mle in a.MListElements(_ => _.Songs) select new { LabelId = a.Label.Id, mle }).UnsafeUpdateMListPart(p => p.mle).Set(mle => mle.Element.Seconds, p => (int)p.LabelId).Execute();
    // TODO(api): bulk update mlist part (executeUpdateMListPart) — MListElements link-row access plus part update from a projection
    test("UpdateMListEmbeddedPart", { skip: true }, async () => {
        // const count = await table(AlbumEntity)
        //     .flatMap(a => a.songs.map(mle => ({ labelId: a.label.id, mle })))
        //     .executeUpdateMListPart(p => p.mle, u => u.set(mle => mle.seconds, p => (p.labelId as number)));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => ((ISecretContainer)a).Secret, a => "Hi").Execute();
    // TODO(api): bulk update (executeUpdate)
    // TODO(api): explicit interface-implemented field ((ISecretContainer)a).Secret
    test("UpdateExplicitInterfaceImplementedField", { skip: true }, async () => {
        // const count = await table(AlbumEntity)
        //     .executeUpdate(u => u.set(a => (a as ISecretContainer).secret, a => "Hi"));
        assert.ok(true);
    });

    // Database.Query<LabelEntity>().UnsafeUpdatePart(lb => lb.Owner!.Entity.Country).Set(ctr => ctr.Name, lb => lb.Name).Execute();
    // TODO(api): bulk update part (executeUpdatePart) — navigate Lite.entity then update the navigated entity
    test("UnsafeUpdatePartExpand", { skip: true }, async () => {
        // const count = await table(LabelEntity)
        //     .executeUpdatePart(lb => lb.owner!.entity.country, u => u.set(ctr => ctr.name, lb => lb.name));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(ctr => ctr.BonusTrack!.Index, lb => 2).Execute();
    // TODO(api): bulk update (executeUpdate)
    test("UnsafeUpdateNullableEmbeddedValue", { skip: true }, async () => {
        // const count = await table(AlbumEntity)
        //     .executeUpdate(u => u.set(ctr => ctr.bonusTrack!.index, lb => 2));
        assert.ok(true);
    });

    // Administrator.CreateTemporaryTable<MyTempView>(); UnsafeInsertView(...); Database.View<MyTempView>().Where(a => a.MyId > 1).UnsafeUpdateView().Set(a => a.Used, a => true).Execute();
    // TODO(api): bulk update view (executeUpdateView) — temporary IView is not modelled
    // TODO(api): Database.View<T>() / CreateTemporaryTable
    test("UnsafeUpdateMyView", { skip: true }, async () => {
        assert.ok(true);
    });
});
