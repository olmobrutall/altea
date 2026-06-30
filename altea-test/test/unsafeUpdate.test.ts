import { before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String methods (toUpperCase etc.), SQL-mappable
import { hasDb, start, txTest } from "./setup";
import { CorruptMixin } from "@altea/altea/entities/corruptMixin";
import { Clock } from "@altea/altea/entities/clock";
import {
    ArtistEntity, AlbumEntity, BandEntity, LabelEntity,
    NoteWithDateEntity, SongEmbedded, Sex,
    ArtistEntity_Friends, BandEntity_Members, AlbumEntity_Songs,
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
    txTest("UpdateValue", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ year: a.year * 2 }));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Name, a => a.Name.ToUpper()).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateValueSqlFunction", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ name: a.name.toUpperCase() }));
        assert.ok(true);
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Title, a => null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateValueNull", async () => {
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ title: null }));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().Where(a => a.Year < 1990).UnsafeUpdate().Set(a => a.Year, a => 1990).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateValueConstant", async () => {
        const count = await table(AlbumEntity).filter(a => a.year < 1990).executeUpdate(a => ({ year: 1990 }));
        assert.ok(true);
    });

    // Database.Query<ArtistEntity>().UnsafeUpdate().Set(a => a.Sex, a => Sex.Male).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateEnumConstant", async () => {
        const count = await table(ArtistEntity).executeUpdate(a => ({ sex: Sex.Male }));
        assert.ok(true);
    });

    // Database.Query<ArtistEntity>().UnsafeUpdate().Set(a => a.Sex, a => a.Sex == Sex.Female ? Sex.Male : Sex.Female).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateEnum", async () => {
        const count = await table(ArtistEntity)
            .executeUpdate(a => ({ sex: a.sex == Sex.Female ? Sex.Male : Sex.Female }));
        assert.ok(true);
    });

    // SongEmbedded song = new(){ Name="Mana Mana", Duration=184s };
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => song).Execute();
    // Assert.False(Any(a => a.BonusTrack == null)); Assert.Equal("Mana Mana", Select(a => a.BonusTrack.Try(b => b.Name)).Distinct().SingleEx());
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateEfie", async () => {
        const song = new SongEmbedded();
        song.name = "Mana Mana";
        const count = await table(AlbumEntity).executeUpdate(a => ({ bonusTrack: song }));
        assert.equal(await table(AlbumEntity).some(a => a.bonusTrack == null), false);
        assert.equal(await table(AlbumEntity).map(a => a.bonusTrack!.name).distinct().single(), "Mana Mana");
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => null).Execute();
    // Assert.True(All(a => a.BonusTrack == null)); Assert.True(All(a => a.BonusTrack.Try(bt => bt.Name) == null));
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateEfieNull", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ bonusTrack: null }));
        assert.ok(await table(AlbumEntity).every(a => a.bonusTrack == null));
        assert.ok(true);
    });

    // SongEmbedded song = new(){ Name="Mana Mana", Duration=184s };
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => (int)a.Id % 2 == 0 ? song : null).Execute();
    // Assert.True(All(a => (int)a.Id % 2 == 0 ? a.BonusTrack.Try(b => b.Name) == "Mana Mana" : a.BonusTrack.Try(b => b.Name) == null));
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateEfieConditional", async () => {
        const song = new SongEmbedded();
        song.name = "Mana Mana";
        const count = await table(AlbumEntity)
            .executeUpdate(a => ({ bonusTrack: (a.id as number) % 2 == 0 ? song : null }));
        assert.ok(true);
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => label).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateFie", async () => {
        const label = await table(LabelEntity).first();
        const count = await table(AlbumEntity).executeUpdate(a => ({ label: label }));
        assert.ok(true);
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => (int)a.Id % 2 == 0 ? label : null).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateFieConditional", async () => {
        const label = await table(LabelEntity).first();
        const count = await table(AlbumEntity)
            .executeUpdate(a => ({ label: (a.id as number) % 2 == 0 ? label : null }));
        assert.ok(true);
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => label).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateFieSetReadonly", async () => {
        const label = await table(LabelEntity).first();
        const count = await table(AlbumEntity).executeUpdate(a => ({ label: label }));
        assert.ok(true);
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Mixin<CorruptMixin>().Corrupt, a => true).Execute();
    // TODO(api): bulk update (executeUpdate)
    // TODO(api): CorruptMixin (not modelled)
    txTest("UpdateMixin", async () => {
        // BLOCKED: a mixin field (a.mixin(CorruptMixin).corrupt) isn't a key of the entity,
        // so it can't be an executeUpdate object-literal key (CorruptMixin is unmodelled too).
        // const count = await table(NoteWithDateEntity)
        //     .executeUpdate(a => ({ ...a.mixin(CorruptMixin).corrupt = true... }));
        assert.ok(true);
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<LabelEntity>().UnsafeUpdate().Set(a => a.Owner, a => label.ToLite()).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateFieToLite", async () => {
        const label = await table(LabelEntity).first();
        const count = await table(LabelEntity).executeUpdate(a => ({ owner: label.toLite() }));
        assert.ok(true);
    });

    // LabelEntity label = new LabelEntity();
    // Assert.Throws<InvalidOperationException>(() => Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => label).Execute()); Assert.Contains("is new and has no Id", e.Message);
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateFieNew", async () => {
        const label = new LabelEntity();
        await assert.rejects(
            async () => table(AlbumEntity).executeUpdate(a => ({ label: label })),
            /is new and has no Id/);
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateFieNull", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ label: null }));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Author, a => michael).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateIbFie", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(AlbumEntity).executeUpdate(a => ({ author: michael }));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Author, a => a.Id > 1 ? michael : null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateIbFieConditional", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(AlbumEntity)
            .executeUpdate(a => ({ author: (a.id as number) > 1 ? michael : null }));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Author, a => null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateIbNull", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ author: null }));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => michael).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateIbaFie", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ target: michael }));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => michael.ToLite()).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateIbaLiteFie", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ otherTarget: michael.toLite() }));
        assert.ok(true);
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateIbaNull", async () => {
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ target: null }));
        assert.ok(true);
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => null).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateIbaLiteNull", async () => {
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ otherTarget: null }));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => a.CreationTime > Clock.Now ? michael : null!).Execute();
    // TODO(api): bulk update (executeUpdate)
    // TODO(api): Clock.Now (server-now constant) in query
    txTest("UpdateIbaConditional", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity)
            .executeUpdate(a => ({ target: a.creationTime > Clock.now ? michael : null }));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => a.CreationTime > Clock.Now ? michael.ToLite() : null).Execute();
    // TODO(api): bulk update (executeUpdate)
    // TODO(api): Clock.Now (server-now constant) in query
    txTest("UpdateIbaLiteConditional", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity)
            .executeUpdate(a => ({ otherTarget: a.creationTime > Clock.now ? michael.toLite() : null }));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => a.Target ?? michael).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateIbaCoalesce", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ target: a.target ?? michael }));
        assert.ok(true);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => a.OtherTarget ?? michael.ToLite()).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateIbaLiteCoalesce", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity)
            .executeUpdate(a => ({ otherTarget: a.otherTarget ?? michael.toLite() }));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack!.Name, a => a.BonusTrack!.Name + " - ").Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateEmbeddedField", async () => {
        // BLOCKED: a nested embedded sub-field (a.bonusTrack.name) can't be an executeUpdate
        // object-literal key (only top-level columns); needs a member-path setter.
        // const count = await table(AlbumEntity)
        //     .executeUpdate(a => ({ /* bonusTrack.name */ }));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => null).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UpdateEmbeddedNull", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ bonusTrack: null }));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().Select(a => new { a.Label, Album = a }).UnsafeUpdatePart(p => p.Label!).Set(a => a.Name, p => p.Label!.Name + "/" + p.Album!.Id).Execute();
    // TODO(api): bulk update part (executeUpdatePart) — update a navigated entity from a projection
    txTest("UnsafeUpdatePart", async () => {
        const count = await table(AlbumEntity)
            .map(a => ({ label: a.label, album: a }))
            .executeUpdatePart(p => p.label, x => ({ name: x.name + "/x" }));
        assert.ok(true);
    });

    // ArtistEntity artist = Database.Query<ArtistEntity>().FirstEx();
    // Database.MListQuery((ArtistEntity a) => a.Friends).UnsafeUpdateMList().Set(mle => mle.Element, mle => artist.ToLite()).Set(mle => mle.Parent, mle => artist).Execute();
    // TODO(api): bulk update mlist (executeUpdateMList) over an MListQuery (link/part rows)
    txTest("UpdateMListLite", async () => {
        const artist = await table(ArtistEntity).first();
        const count = await table(ArtistEntity_Friends)
            .executeUpdate(mle => ({ friend: artist.toLite(), artist: artist.toLite() }));
        assert.ok(true);
    });

    // ArtistEntity artist = Database.Query<ArtistEntity>().FirstEx();
    // Database.MListQuery((BandEntity a) => a.Members).UnsafeUpdateMList().Set(mle => mle.Element, mle => artist).Execute();
    // TODO(api): bulk update mlist (executeUpdateMList) over an MListQuery (link/part rows)
    txTest("UpdateMListEntity", async () => {
        const artist = await table(ArtistEntity).first();
        const count = await table(BandEntity_Members)
            .executeUpdate(mle => ({ member: artist.toLite() }));
        assert.ok(true);
    });

    // Database.MListQuery((AlbumEntity a) => a.Songs).UnsafeUpdateMList().Set(mle => mle.Element.Seconds, mle => 3).Execute();
    // TODO(api): bulk update mlist (executeUpdateMList) over an MListQuery (link/part rows)
    txTest("UpdateMListEmbedded", async () => {
        const count = await table(AlbumEntity_Songs)
            .executeUpdate(mle => ({ seconds: 3 }));
        assert.ok(true);
    });

    // (from a from mle in a.MListElements(_ => _.Songs) select new { LabelId = a.Label.Id, mle }).UnsafeUpdateMListPart(p => p.mle).Set(mle => mle.Element.Seconds, p => (int)p.LabelId).Execute();
    // TODO(api): bulk update mlist part (executeUpdateMListPart) — MListElements link-row access plus part update from a projection
    txTest("UpdateMListEmbeddedPart", async () => {
        const count = await table(AlbumEntity_Songs)
            .executeUpdate(s => ({ seconds: (s.album.entity.label.id as number) }));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => ((ISecretContainer)a).Secret, a => "Hi").Execute();
    // TODO(api): bulk update (executeUpdate)
    // TODO(api): explicit interface-implemented field ((ISecretContainer)a).Secret
    txTest("UpdateExplicitInterfaceImplementedField", async () => {
        // BLOCKED: explicit interface-implemented field ((a as ISecretContainer).secret) - unmodelled.
        // const count = await table(AlbumEntity)
        //     .executeUpdate(u => u.set(a => (a as ISecretContainer).secret, a => "Hi"));
        // assert.ok(true);
    });

    // Database.Query<LabelEntity>().UnsafeUpdatePart(lb => lb.Owner!.Entity.Country).Set(ctr => ctr.Name, lb => lb.Name).Execute();
    // TODO(api): bulk update part (executeUpdatePart) — navigate Lite.entity then update the navigated entity
    txTest("UnsafeUpdatePartExpand", async () => {
        const count = await table(LabelEntity)
            .executeUpdatePart(lb => lb.owner!.entity.country, ctr => ({ name: ctr.name }));
        assert.ok(true);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(ctr => ctr.BonusTrack!.Index, lb => 2).Execute();
    // TODO(api): bulk update (executeUpdate)
    txTest("UnsafeUpdateNullableEmbeddedValue", async () => {
        // BLOCKED: a nested embedded sub-field (bonusTrack.index) can't be an executeUpdate
        // object-literal key (only top-level columns); needs a member-path setter.
        // const count = await table(AlbumEntity)
        //     .executeUpdate(a => ({ /* bonusTrack.index */ }));
        assert.ok(true);
    });

    // Administrator.CreateTemporaryTable<MyTempView>(); UnsafeInsertView(...); Database.View<MyTempView>().Where(a => a.MyId > 1).UnsafeUpdateView().Set(a => a.Used, a => true).Execute();
    // TODO(api): bulk update view (executeUpdateView) — temporary IView is not modelled
    // TODO(api): Database.View<T>() / CreateTemporaryTable
    txTest("UnsafeUpdateMyView", async () => {
        assert.ok(true);
    });
});
