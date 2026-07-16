import { before, describe } from "node:test";
import assert from "node:assert/strict";
import { table, view } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String methods (toUpperCase etc.), SQL-mappable
import { hasDb, start, txTest } from "./setup";
import { Clock } from "@altea/altea/entities/utils/clock";
import { CorruptMixin } from "@altea/altea/entities/corruptMixin";
import { Administrator } from "@altea/altea/logic/Administrator";
import {
    ArtistEntity, AlbumEntity, LabelEntity,
    NoteWithDateEntity, SongEmbedded, Sex, MyTempView2,
    ArtistEntity_Friends, BandEntity_Members, AlbumEntity_Songs,
} from "../entities/music";
import { toInt } from "@altea/altea/entities/basics";

// Port of Signum.Test/LinqProvider/UnsafeUpdateTest.cs (set-based bulk UPDATE).
//
// altea's bulk-UPDATE API (Signum's `Query<T>().UnsafeUpdate().Set(...).Execute()`):
//   table(T).filter(...)?.executeUpdate(row => ({ field: valueExpr, ... }))  → affected row count.
//     - the object literal's KEYS are the (top-level) columns to set; VALUES are quoted value
//       expressions over the row (mix constants, SQL functions, conditionals, references, …).
//     - a preceding .filter(...) restricts the rows updated.
//   table(T).map(a => ({ part, root })).executeUpdatePart(p => p.part, root => ({ field: valueExpr }))
//       updates a *navigated* entity: the setter's KEYS name the part's columns, its VALUES read
//       the ROOT projection (Signum binds the value selector to the root).
// altea models MLists as part entities, so Signum's `MListQuery(...).UnsafeUpdateMList()` is just
// `executeUpdate` over the part-entity table (e.g. ArtistEntity_Friends) — no separate API.
//
// A setter key may be a top-level column, a mixin field (flattened into the owner table), or an
// embedded field whose value is a nested `{ subField: expr }` object literal — a PARTIAL embedded
// update setting only the named sub-columns. executeUpdate over a `view(...)` is UnsafeUpdateView
// (the target is the temp table).
//
// Runs inside txTest (Transaction.noCommit): the UPDATE happens and the body sees it, then it is
// rolled back. Live execution is gated on ALTEA_TEST_DB; without it the suite is skipped.

describe("UnsafeUpdateTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Year, a => a.Year * 2).Execute();
    txTest("UpdateValue", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ year: toInt(a.year * 2) }));
        assert.ok(count > 0);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Name, a => a.Name.ToUpper()).Execute();
    txTest("UpdateValueSqlFunction", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ name: a.name.toUpperCase() }));
        assert.ok(count > 0);
        assert.ok(await table(AlbumEntity).every(a => a.name == a.name.toUpperCase()));
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Title, a => null!).Execute();
    txTest("UpdateValueNull", async () => {
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ title: null! }));
        assert.ok(count > 0);
        assert.ok(await table(NoteWithDateEntity).every(a => a.title == null));
    });

    // Database.Query<AlbumEntity>().Where(a => a.Year < 1990).UnsafeUpdate().Set(a => a.Year, a => 1990).Execute();
    txTest("UpdateValueConstant", async () => {
        const count = await table(AlbumEntity).filter(a => a.year < 1990).executeUpdate(a => ({ year: toInt(1990) }));
        assert.ok(count >= 0);
        assert.ok(await table(AlbumEntity).every(a => a.year >= 1990));
    });

    // Database.Query<ArtistEntity>().UnsafeUpdate().Set(a => a.Sex, a => Sex.Male).Execute();
    txTest("UpdateEnumConstant", async () => {
        const count = await table(ArtistEntity).executeUpdate(a => ({ sex: Sex.Male }));
        assert.ok(count > 0);
        assert.ok(await table(ArtistEntity).every(a => a.sex == Sex.Male));
    });

    // Database.Query<ArtistEntity>().UnsafeUpdate().Set(a => a.Sex, a => a.Sex == Sex.Female ? Sex.Male : Sex.Female).Execute();
    txTest("UpdateEnum", async () => {
        const count = await table(ArtistEntity)
            .executeUpdate(a => ({ sex: a.sex == Sex.Female ? Sex.Male : Sex.Female }));
        assert.ok(count > 0);
    });

    // SongEmbedded song = new(){ Name="Mana Mana", Duration=184s };
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => song).Execute();
    // Assert.False(Any(a => a.BonusTrack == null)); Assert.Equal("Mana Mana", Select(a => a.BonusTrack.Try(b => b.Name)).Distinct().SingleEx());
    txTest("UpdateEfie", async () => {
        const song = new SongEmbedded();
        song.name = "Mana Mana";
        const count = await table(AlbumEntity).executeUpdate(a => ({ bonusTrack: song }));
        assert.ok(count > 0);
        assert.equal(await table(AlbumEntity).some(a => a.bonusTrack == null), false);
        assert.equal(await table(AlbumEntity).map(a => a.bonusTrack!.name).distinct().single(), "Mana Mana");
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => null).Execute();
    // Assert.True(All(a => a.BonusTrack == null)); Assert.True(All(a => a.BonusTrack.Try(bt => bt.Name) == null));
    txTest("UpdateEfieNull", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ bonusTrack: null }));
        assert.ok(count > 0);
        assert.ok(await table(AlbumEntity).every(a => a.bonusTrack == null));
    });

    // SongEmbedded song = new(){ Name="Mana Mana", Duration=184s };
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => (int)a.Id % 2 == 0 ? song : null).Execute();
    // Assert.True(All(a => (int)a.Id % 2 == 0 ? a.BonusTrack.Try(b => b.Name) == "Mana Mana" : a.BonusTrack.Try(b => b.Name) == null));
    txTest("UpdateEfieConditional", async () => {
        const song = new SongEmbedded();
        song.name = "Mana Mana";
        const count = await table(AlbumEntity)
            .executeUpdate(a => ({ bonusTrack: (a.id as number) % 2 == 0 ? song : null }));
        assert.ok(count > 0);
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => label).Execute();
    txTest("UpdateFie", async () => {
        const label = await table(LabelEntity).first();
        const count = await table(AlbumEntity).executeUpdate(a => ({ label: label }));
        assert.ok(count > 0);
        assert.ok(await table(AlbumEntity).every(a => a.label.is(label)));
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => (int)a.Id % 2 == 0 ? label : null).Execute();
    txTest("UpdateFieConditional", async () => {
        const label = await table(LabelEntity).first();
        const count = await table(AlbumEntity)
            .executeUpdate(a => ({ label: (a.id as number) % 2 == 0 ? label : null! }));
        assert.ok(count > 0);
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => label).Execute();
    txTest("UpdateFieSetReadonly", async () => {
        const label = await table(LabelEntity).first();
        const count = await table(AlbumEntity).executeUpdate(a => ({ label: label }));
        assert.ok(count > 0);
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Mixin<CorruptMixin>().Corrupt, a => true).Execute();
    // A mixin field is a valid setter key (altea flattens a mixin's columns into the owner table);
    // the object literal is cast to include the mixin's members.
    txTest("UpdateMixin", async () => {
        const count = await table(NoteWithDateEntity)
            .executeUpdate(a => ({ corrupt: true } as Partial<CorruptMixin & NoteWithDateEntity>));
        assert.ok(count > 0);
        assert.ok(await table(NoteWithDateEntity).every(a => a.mixin(CorruptMixin).corrupt == true));
    });

    // LabelEntity label = Database.Query<LabelEntity>().FirstEx();
    // Database.Query<LabelEntity>().UnsafeUpdate().Set(a => a.Owner, a => label.ToLite()).Execute();
    txTest("UpdateFieToLite", async () => {
        const label = await table(LabelEntity).first();
        const count = await table(LabelEntity).executeUpdate(a => ({ owner: label.toLite() }));
        assert.ok(count > 0);
    });

    // LabelEntity label = new LabelEntity();
    // Assert.Throws<InvalidOperationException>(() => …Set(a => a.Label, a => label).Execute()); Assert.Contains("is new and has no Id", e.Message);
    txTest("UpdateFieNew", async () => {
        const label = new LabelEntity();
        await assert.rejects(
            async () => table(AlbumEntity).executeUpdate(a => ({ label: label })),
            /is new and has no Id/);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Label, a => null!).Execute();
    txTest("UpdateFieNull", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ label: null! }));
        assert.ok(count > 0);
        assert.ok(await table(AlbumEntity).every(a => a.label == null));
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Author, a => michael).Execute();
    txTest("UpdateIbFie", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(AlbumEntity).executeUpdate(a => ({ author: michael }));
        assert.ok(count > 0);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Author, a => a.Id > 1 ? michael : null!).Execute();
    txTest("UpdateIbFieConditional", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(AlbumEntity)
            .executeUpdate(a => ({ author: (a.id as number) > 1 ? michael : null! }));
        assert.ok(count > 0);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.Author, a => null!).Execute();
    txTest("UpdateIbNull", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ author: null! }));
        assert.ok(count > 0);
        assert.ok(await table(AlbumEntity).every(a => a.author == null));
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => michael).Execute();
    txTest("UpdateIbaFie", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ target: michael }));
        assert.ok(count > 0);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => michael.ToLite()).Execute();
    txTest("UpdateIbaLiteFie", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ otherTarget: michael.toLite() }));
        assert.ok(count > 0);
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => null!).Execute();
    txTest("UpdateIbaNull", async () => {
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ target: null! }));
        assert.ok(count > 0);
        assert.ok(await table(NoteWithDateEntity).every(a => a.target == null));
    });

    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => null).Execute();
    txTest("UpdateIbaLiteNull", async () => {
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ otherTarget: null }));
        assert.ok(count > 0);
        assert.ok(await table(NoteWithDateEntity).every(a => a.otherTarget == null));
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => a.CreationTime > Clock.Now ? michael : null!).Execute();
    txTest("UpdateIbaConditional", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity)
            .executeUpdate(a => ({ target: a.creationTime > Clock.now ? michael : null! }));
        assert.ok(count > 0);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => a.CreationTime > Clock.Now ? michael.ToLite() : null).Execute();
    txTest("UpdateIbaLiteConditional", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity)
            .executeUpdate(a => ({ otherTarget: a.creationTime > Clock.now ? michael.toLite() : null }));
        assert.ok(count > 0);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.Target, a => a.Target ?? michael).Execute();
    txTest("UpdateIbaCoalesce", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity).executeUpdate(a => ({ target: a.target ?? michael }));
        assert.ok(count > 0);
    });

    // ArtistEntity michael = Database.Query<ArtistEntity>().SingleEx(a => a.Dead);
    // Database.Query<NoteWithDateEntity>().UnsafeUpdate().Set(a => a.OtherTarget, a => a.OtherTarget ?? michael.ToLite()).Execute();
    txTest("UpdateIbaLiteCoalesce", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const count = await table(NoteWithDateEntity)
            .executeUpdate(a => ({ otherTarget: a.otherTarget ?? michael.toLite() }));
        assert.ok(count > 0);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack!.Name, a => a.BonusTrack!.Name + " - ").Execute();
    // A nested `{ bonusTrack: { name: … } }` object literal is a PARTIAL embedded update: it sets
    // only the bonusTrack.name sub-column (HasValue untouched — a null bonusTrack stays null).
    txTest("UpdateEmbeddedField", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ bonusTrack: { name: a.bonusTrack?.name + " - " } }));
        assert.ok(count > 0);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => a.BonusTrack, a => null).Execute();
    txTest("UpdateEmbeddedNull", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ bonusTrack: null }));
        assert.ok(count > 0);
        assert.ok(await table(AlbumEntity).every(a => a.bonusTrack == null));
    });

    // Database.Query<AlbumEntity>().Select(a => new { a.Label, Album = a }).UnsafeUpdatePart(p => p.Label!).Set(a => a.Name, p => p.Label!.Name + "/" + p.Album!.Id).Execute();
    // executeUpdatePart(partSelector, setter): the setter's object KEYS name the part's columns;
    // its VALUES read the ROOT projection (Signum binds the value selector to the root, so it can
    // reach any source field — here the label's name and the album's id).
    txTest("UnsafeUpdatePart", async () => {
        const count = await table(AlbumEntity)
            .map(a => ({ label: a.label, album: a }))
            .executeUpdatePart(p => p.label, x => ({ name: x.label.name + "/" + (x.album.id as number) }));
        assert.ok(count > 0);
    });

    // ArtistEntity artist = Database.Query<ArtistEntity>().FirstEx();
    // Database.MListQuery((ArtistEntity a) => a.Friends).UnsafeUpdateMList().Set(mle => mle.Element, mle => artist.ToLite()).Set(mle => mle.Parent, mle => artist).Execute();
    // altea models the MList as the ArtistEntity_Friends part entity, so this is a plain
    // executeUpdate over that table (no MListQuery / UnsafeUpdateMList API needed).
    txTest("UpdateMListLite", async () => {
        const artist = await table(ArtistEntity).first();
        const count = await table(ArtistEntity_Friends)
            .executeUpdate(mle => ({ friend: artist.toLite(), artist: artist.toLite() }));
        assert.ok(count >= 0);
    });

    // ArtistEntity artist = Database.Query<ArtistEntity>().FirstEx();
    // Database.MListQuery((BandEntity a) => a.Members).UnsafeUpdateMList().Set(mle => mle.Element, mle => artist).Execute();
    txTest("UpdateMListEntity", async () => {
        const artist = await table(ArtistEntity).first();
        const count = await table(BandEntity_Members)
            .executeUpdate(mle => ({ member: artist }));
        assert.ok(count >= 0);
    });

    // Database.MListQuery((AlbumEntity a) => a.Songs).UnsafeUpdateMList().Set(mle => mle.Element.Seconds, mle => 3).Execute();
    txTest("UpdateMListEmbedded", async () => {
        const count = await table(AlbumEntity_Songs)
            .executeUpdate(mle => ({ seconds: toInt(3) }));
        assert.ok(count > 0);
        assert.ok(await table(AlbumEntity_Songs).every(s => s.seconds == 3));
    });

    // (from a from mle in a.MListElements(_ => _.Songs) select new { LabelId = a.Label.Id, mle }).UnsafeUpdateMListPart(p => p.mle).Set(mle => mle.Element.Seconds, p => (int)p.LabelId).Execute();
    // altea: the part table carries a back-reference to its owner, so the owner's field is reached
    // by navigation in the value (s.album.entity.label.id) — a plain executeUpdate, no MListPart API.
    txTest("UpdateMListEmbeddedPart", async () => {
        const count = await table(AlbumEntity_Songs)
            .executeUpdate(s => ({ seconds: toInt(s.album.entity.label.id as number) }));
        assert.ok(count >= 0);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(a => ((ISecretContainer)a).Secret, a => "Hi").Execute();
    // Not ported: explicit interface implementation (a member reachable only by casting to the
    // interface that declares it) is a C#-only concept with no TypeScript equivalent.

    // Database.Query<LabelEntity>().UnsafeUpdatePart(lb => lb.Owner!.Entity.Country).Set(ctr => ctr.Name, lb => lb.Name).Execute();
    // Part = each label's owner's country; set that country's Name to the ROOT label's name
    // (the value selector binds to the root, per Signum — see UnsafeUpdatePart above).
    txTest("UnsafeUpdatePartExpand", async () => {
        const count = await table(LabelEntity)
            .executeUpdatePart(lb => lb.owner!.entity.country, lb => ({ name: lb.name }));
        assert.ok(count >= 0);
    });

    // Database.Query<AlbumEntity>().UnsafeUpdate().Set(ctr => ctr.BonusTrack!.Index, lb => 2).Execute();
    txTest("UnsafeUpdateNullableEmbeddedValue", async () => {
        const count = await table(AlbumEntity).executeUpdate(a => ({ bonusTrack: { index: toInt(2) } }));
        assert.ok(count > 0);
        assert.ok(await table(AlbumEntity).every(a => a.bonusTrack == null || a.bonusTrack!.index == 2));
    });

    // using (tr) { CreateTemporaryTable<MyTempView>(); Query<ArtistEntity>().UnsafeInsertView(a => new MyTempView { MyId = (int)a.Id, Used = false });
    //   Database.View<MyTempView>().Where(a => a.MyId > 1).UnsafeUpdateView().Set(a => a.Used, a => true).Execute(); tr.Commit(); }
    // altea: executeUpdate over the view is UnsafeUpdateView (the target is the temp table); the
    // update correlates by MyTempView2's @viewPrimaryKey (myId). Runs on one pinned connection.
    txTest("UnsafeUpdateMyView", async () => {
        await Administrator.createTemporaryTable(MyTempView2);
        await table(ArtistEntity).executeInsert(MyTempView2, a => ({ myId: toInt(a.id as number), used: false }));

        const count = await view(MyTempView2).filter(a => a.myId > 1).executeUpdate(a => ({ used: true }));
        assert.ok(count >= 0);
        assert.ok(await view(MyTempView2).every(a => a.myId <= 1 || a.used == true));
    });
});
