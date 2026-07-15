import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table, view } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.contains / startsWith / … (SQL-mappable)
import { hasDb, start } from "./setup";
import { Connector } from "@altea/altea/logic/connection/connector";
import { PgClass } from "@altea/altea/logic/sync/postgres/postgresCatalog";
import { SysDatabases } from "@altea/altea/logic/sync/sqlServer/sysTables";
import type { Quoted } from "quote-transformer/quoted";
import { Clock } from "@altea/altea/entities/clock";
import { CorruptMixin } from "@altea/altea/entities/corruptMixin";
import {
    ArtistEntity, AlbumEntity, BandEntity, LabelEntity,
    ColaboratorsMixin,
    NoteWithDateEntity, GrammyAwardEntity, AwardEntity, AmericanMusicAwardEntity,
    Sex, AwardResult, type IAuthorEntity,
} from "../entities/music";
import { inSql, toInt, toDecimal } from "@altea/altea/entities/basics";

// Port of Signum.Test/LinqProvider/SelectTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Select(...) → .map(...)
//   .Where(...)          → .filter(...)        .SelectMany(...) → .flatMap(...)
//   .ToList()/.ToArray() → await .toArray()    .First()/.FirstEx() → await .first()
//   .SingleEx()          → await .single()     new { X = .. } → { x: .. } (camelCase)
//   a.ToLite()           → a.toLite()          a.Author == michael → a.author.is(michael)
//   x is BandEntity      → x instanceof BandEntity
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// Most SelectTest methods run live and pass: entity casts, GetType/constructor,
// AutoExpressionField properties/methods (@quoted), polymorphic Combine, mixin
// projection/filter/collection, per-row sub-aggregates, ToLite, ToString in a
// projection, and DefaultIfEmpty outer-apply are all supported now. A handful of
// C#-only constructs (typed-null casts, interface upcasts, FormatWith) are noted
// inline as `// Not ported:`. The genuinely still-missing features (MListQuery as a
// standalone source, Database.View<T>(), InSql, cross-join over a second independent
// table, custom-model ToLite) keep a narrow `// TODO(api): …` comment.

describe("SelectTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().Select(a => a.Name).ToList();
    test("Select", async () => {
        const list = await table(AlbumEntity).map(a => a.name).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().Select((a, i) => a.Name + i).ToList();
    test("SelectIndex", async () => {
        const list = await table(AlbumEntity).map((a, i) => a.name + i).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().Select(b => b.Id).ToList();
    test("SelectIds", async () => {
        const first = await table(BandEntity).map(b => b.id).toArray();
        assert.ok(Array.isArray(first));
    });

    // Database.Query<BandEntity>().Select(b => b.Id).First();
    test("SelectFirstId", async () => {
        const first = await table(BandEntity).map(b => b.id).first();
        assert.ok(first != null);
    });

    // Database.Query<AlbumEntity>().Select(a => a.Label.Name).ToList();
    test("SelectExpansion", async () => {
        const list = await table(AlbumEntity).map(a => a.label.name).toArray();
        assert.ok(Array.isArray(list));
    });

    // from a … let l = a.Label select l.Name
    test("SelectLetExpansion", async () => {
        const list = await table(AlbumEntity).map(a => a.label.name).toArray();
        assert.ok(Array.isArray(list));
    });

    // from a … let label = a.Label select new { Artist = label.Country.Name, Author = a.Label.Name }
    test("SelectLetExpansionRedundant", async () => {
        const list = await table(AlbumEntity)
            .map(a => ({ artist: a.label.country.name, author: a.label.name }))
            .toArray();
        assert.equal(await table(AlbumEntity).count(), list.length);
    });

    // Database.Query<AlbumEntity>().Where(a => a.Label != null).Select(a => a.Label.Name).ToList();
    test("SelectWhereExpansion", async () => {
        const list = await table(AlbumEntity)
            .filter(a => a.label != null)
            .map(a => a.label.name)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().Select(a => new { a.Name, a.Year }).ToList();
    test("SelectAnonymous", async () => {
        const list = await table(AlbumEntity)
            .map(a => ({ name: a.name, year: a.year }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => new { Clock.Now, Album = (AlbumEntity?)null, Artist = (Lite<ArtistEntity>?)null })
    // Clock.now folds to a constant; the C# typed-null casts are just plain `null` in altea.
    test("SelectNoColumns", async () => {
        const list = await table(AlbumEntity)
            .map(a => ({ now: Clock.now, album: null, artist: null }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().Select(a => (int?)a.Songs.Count).ToList();
    test("SelectCount", async () => {
        const list = await table(AlbumEntity).map(a => a.songs.length).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(n => typeof n === "number" && n >= 0));
    });

    // Database.Query<AlbumEntity>().Select(a => a.ToLite()).ToList();
    test("SelectLite", async () => {
        const list = await table(AlbumEntity).map(a => a.toLite()).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().Select(a => a.ToLite(a.Label.Name)).ToList();
    test("SelectLiteCustomModel", async () => {
        const list = await table(AlbumEntity).map(a => a.toLite(a.label.name)).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(l => l.entityType === AlbumEntity && typeof l.toString() === "string"));
    });

    // Database.Query<ArtistEntity>().Select(a => a.Dead).ToList();
    test("SelectBool", async () => {
        const list = await table(ArtistEntity).map(a => a.dead).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().Select(a => a.Year < 1990).ToList();
    test("SelectConditionToBool", async () => {
        const list = await table(AlbumEntity).map(a => a.year < 1990).toArray();
        assert.ok(Array.isArray(list));
    });

    // from l … select (l.Owner == null ? l : l.Owner.Entity).Name
    test("SelectConditionalMember", async () => {
        const list = await table(LabelEntity)
            .map(l => (l.owner == null ? l : l.owner.entity).name)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from l … select (l.Owner == null ? l : l.Owner.Entity).ToLite()
    test("SelectConditionalToLite", async () => {
        const list = await table(LabelEntity)
            .map(l => (l.owner == null ? l : l.owner.entity).toLite())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from l … let owner = (l.Owner == null ? null : l.Owner)!.Entity select owner.ToLite(owner.Name)
    test("SelectConditionalToLiteNull", async () => {
        // Expression-bodied (the quote-transformer can't quote a statement block); the
        // `let owner = …` is inlined — both conditional branches are `l.owner`.
        const list = await table(LabelEntity)
            .map(l => (l.owner == null ? null : l.owner)!.entity.toLite((l.owner == null ? null : l.owner)!.entity.name))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from l … select (l.Owner == null ? l : l.Owner.Entity).GetType()
    test("SelectConditionalGetType", async () => {
        const list = await table(LabelEntity)
            .map(l => (l.owner == null ? l : l.owner.entity).constructor)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from l … select (l.Owner!.Entity ?? l).Name
    test("SelectCoalesceMember", async () => {
        const list = await table(LabelEntity)
            .map(l => (l.owner!.entity ?? l).name)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from l … select (l.Owner!.Entity ?? l).ToLite()
    test("SelectCoalesceToLite", async () => {
        const list = await table(LabelEntity)
            .map(l => (l.owner!.entity ?? l).toLite())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from l … select (l.Owner!.Entity ?? l).GetType()
    test("SelectCoalesceGetType", async () => {
        const list = await table(LabelEntity)
            .map(l => (l.owner!.entity ?? l).constructor)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from n … select (IAuthorEntity)n  (just to full-nominate)
    // The C# `(IAuthorEntity)n` is a compile-time interface upcast (a runtime no-op).
    // IAuthorEntity is an unregistered interface, so the binder's visitCast falls through
    // to identity and the whole entity still materialises as an ArtistEntity.
    test("SelectUpCast", async () => {
        const list = await table(ArtistEntity).map(n => n as IAuthorEntity).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(n => n instanceof ArtistEntity));
    });

    // michael = SingleEx(a => a.Dead); Select(a => a.Author == michael)
    test("SelectEntityEquals", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const list = await table(AlbumEntity).map(a => a.author.is(michael)).toArray();
        assert.ok(Array.isArray(list));
    });

    // michael = SingleEx(a => a.Dead); Select(a => a.Author == michael)
    test("SelectBoolExpression", async () => {
        const michael = await table(ArtistEntity).single(a => a.dead);
        const list = await table(AlbumEntity).map(a => a.author.is(michael)).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<ArtistEntity>().Where(a => a.IsMale).ToArray();
    // ArtistEntity.isMale() is a @quoted expression member (Signum's AutoExpressionField).
    test("SelectExpressionProperty", async () => {
        const list = await table(ArtistEntity).filter(a => a.isMale()).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<ArtistEntity>().Select(a => new { a.Name, Count = a.AlbumCount() }).ToArray();
    // AlbumCount() is a @quoted expression member (a cross-entity count subquery).
    test("SelectExpressionMethod", async () => {
        const list = await table(ArtistEntity)
            .map(a => ({ name: a.name, count: a.albumCount() }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => a.Author.CombineUnion().FullName)
    // A @quoted expression member navigated through a polymorphic combine (UNION strategy).
    test("SelectPolyExpressionPropertyUnion", async () => {
        const list = await table(AlbumEntity).map(a => a.author.combineUnion().fullName()).toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => a.Author.CombineCase().FullName)
    // A @quoted expression member navigated through a polymorphic combine (CASE strategy).
    test("SelectPolyExpressionPropertySwitch", async () => {
        const list = await table(AlbumEntity).map(a => a.author.combineCase().fullName()).toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => a.Author.CombineUnion().Lonely())
    // A @quoted expression member (per-impl body: friends vs members) via UNION combine.
    test("SelectPolyExpressionMethodUnion", async () => {
        const list = await table(AlbumEntity).map(a => a.author.combineUnion().lonely()).toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => a.Author.CombineCase().Lonely())
    // A @quoted expression member (per-impl body: friends vs members) via CASE combine.
    test("SelectPolyExpressionMethodSwitch", async () => {
        const list = await table(AlbumEntity).map(a => a.author.combineCase().lonely()).toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => a.Author is BandEntity ? ((BandEntity)a.Author).Lonely() : ((ArtistEntity)a.Author).Lonely())
    // The manual (cast + ?:) form of the polymorphic Lonely() expansion.
    test("SelectPolyExpressionMethodManual", async () => {
        const list = await table(AlbumEntity)
            .map(a => a.author instanceof BandEntity
                ? (a.author as BandEntity).lonely()
                : (a.author as ArtistEntity).lonely())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Signum's SelectThrowIntNullable/BoolNullable/EnumNullable are dropped in the port:
    // they assert a FieldReaderException when a DB null is read into a non-nullable C#
    // value type (int/bool/enum). TS has no such constraint — a null column just yields
    // `null` — so there is nothing to throw. The non-throwing SelectIntNullable/
    // SelectBoolNullable below cover the same queries.

    // Select(a => (int?)((ArtistEntity)a.Author).Id)
    test("SelectIntNullable", async () => {
        const list = await table(AlbumEntity).map(a => (a.author as ArtistEntity).id).toArray();
        assert.ok(list.length > 0);
        // band-authored albums have a NULL Artist FK → null id; artist-authored → a number
        assert.ok(list.every(id => id == null || typeof id === "number"));
        assert.ok(list.some(id => id != null));
    });

    // Select(a => (bool?)((ArtistEntity)a.Author).Dead)
    test("SelectBoolNullable", async () => {
        const list = await table(AlbumEntity).map(a => (a.author as ArtistEntity).dead).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(d => d == null || typeof d === "boolean"));
    });

    // Database.Query<ArtistEntity>().Select(a => a.Status).ToArray();
    test("SelectEnumNullable", async () => {
        const list = await table(ArtistEntity).map(a => a.status).toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => ((ArtistEntity)a.Author).Status)
    test("SelectEnumNullableNullable", async () => {
        const list = await table(AlbumEntity).map(a => (a.author as ArtistEntity).status).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(s => s == null || typeof s === "number"));
    });

    // Signum's SelectThrowsIntSumNullable: Select(a => (int)a.Id + (int)((ArtistEntity)a.Author).Id)
    // throws FieldReaderException in C# — a band-authored album's Artist FK is NULL, `X + NULL`
    // is SQL NULL, and reading that into a non-nullable `int` is illegal. TypeScript has no
    // non-nullable value type: the lazy projector sums client-side with native JS semantics
    // (`number + null === number`, null → 0), so every row is a number — no throw. Intentional
    // divergence (the C# lifted-arithmetic null is not reproduced; use inSql() for SQL semantics).
    test("SelectIntSumNullable", async () => {
        const list = await table(AlbumEntity).map(a => (a.id as number) + ((a.author as ArtistEntity).id as number)).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(x => typeof x === "number")); // band-authored rows sum id + 0
    });

    // Signum's SelectThrowaIntSumNullableCasting: the same query with the C# result cast to
    // (int?). The int-vs-int? distinction doesn't exist in TS, so this behaves identically to
    // SelectIntSumNullable (kept for the 1:1 port mapping).
    test("SelectIntSumNullableCasting", async () => {
        const list = await table(AlbumEntity).map(a => (a.id as number) + ((a.author as ArtistEntity).id as number)).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(x => typeof x === "number"));
    });

    // Select(a => (int?)((int)a.Id + (int)((ArtistEntity)a.Author).Id).InSql())
    // inSql() forces the sum into SQL (a single `(A.ID + A.AuthorID_Artist)` column). Unlike the
    // client-side lazy versions above (native JS `id + null === id`), SQL `id + NULL` is NULL, so
    // a band-authored album yields null here — inSql changes both where the sum runs and, because
    // JS and SQL differ on null arithmetic, the result.
    test("SelectThrowaIntSumNullableCastingInSql", async () => {
        const list = await table(AlbumEntity)
            .map(a => inSql((a.id as number) + ((a.author as ArtistEntity).id as number)))
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(x => x == null || typeof x === "number"));
        assert.ok(list.some(x => x == null));
    });

    // Select(a => (Sex?)((ArtistEntity)a.Author).Sex)
    test("SelectEnumNullableBullableCast", async () => {
        const list = await table(AlbumEntity).map(a => (a.author as ArtistEntity).sex).toArray();
        assert.ok(list.length > 0);
        // band-authored rows → null; artist-authored → a Sex value
        assert.ok(list.every(s => s == null || Object.values(Sex).includes(s)));
        assert.ok(list.some(s => s != null));
    });

    // Where(a => a.Author is ArtistEntity).Select(a => ((Sex?)((ArtistEntity)a.Author).Sex).Value)
    test("SelectEnumNullableValue", async () => {
        const list = await table(AlbumEntity)
            .filter(a => a.author instanceof ArtistEntity)
            .map(a => (a.author as ArtistEntity).sex)
            .toArray();
        assert.ok(list.length > 0);
        // filtered to artist authors, so every Sex is present (non-null)
        assert.ok(list.every(s => Object.values(Sex).includes(s)));
    });

    // Where(a => a.Status != null).Select(a => (a.Status ?? a.Status)!.Value)
    test("CoallesceNullable", async () => {
        const list = await table(ArtistEntity)
            .filter(a => a.status != null)
            .map(a => a.status ?? a.status)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().Select(a => a.BonusTrack).ToArray();
    test("SelectEmbeddedNullable", async () => {
        const bonusTracks = await table(AlbumEntity).map(a => a.bonusTrack).toArray();
        assert.ok(Array.isArray(bonusTracks));
    });

    // Assert.Throws<InvalidOperationException>(() => Select(a => a.Mixin<CorruptMixin>()).ToArray()); Assert.Contains("without their main entity", …)
    // Projecting a whole mixin (detached from its main entity) is rejected — mirrors Signum.
    test("SelectMixinThrows", async () => {
        await assert.rejects(
            async () => table(NoteWithDateEntity).map(a => a.mixin(CorruptMixin)).toArray(),
            /without their main entity/);
    });

    // Database.Query<NoteWithDateEntity>().Select(a => a.Mixin<CorruptMixin>().Corrupt).ToArray();
    test("SelectMixinField", async () => {
        const list = await table(NoteWithDateEntity).map(a => a.mixin(CorruptMixin).corrupt).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(c => typeof c === "boolean"));
    });

    // Database.Query<NoteWithDateEntity>().Where(a => a.Mixin<CorruptMixin>().Corrupt == true).ToArray();
    test("SelectMixinWhere", async () => {
        const list = await table(NoteWithDateEntity)
            .filter(a => a.mixin(CorruptMixin).corrupt == true)
            .toArray();
        // no seeded note is corrupt, so the filter yields the empty set (all rows pass through it)
        assert.ok(list.every(n => n.mixin(CorruptMixin).corrupt === true));
    });

    // from n from c in n.Mixin<ColaboratorsMixin>().Colaborators select c
    test("SelectMixinCollection", async () => {
        const result = await table(NoteWithDateEntity)
            .flatMap(n => n.mixin(ColaboratorsMixin).colaborators)
            .toArray();
        // no seeded note has colaborators, so the flattened list is empty; each element, if
        // present, is a colaborator link row with a colaborator artist.
        assert.ok(result.every(c => c.colaborator instanceof ArtistEntity));
    });

    // from a from s in a.Songs where s.Seconds.HasValue select s.Seconds!.Value
    test("SelectNullable", async () => {
        const durations = await table(AlbumEntity)
            .flatMap(a => a.songs)
            .filter(s => s.seconds != null)
            .map(s => s.seconds)
            .toArray();
        assert.ok(Array.isArray(durations));
    });

    // from a from s in a.Songs where s.Seconds.HasValue select s.Seconds == null
    test("SelectIsNull", async () => {
        const durations = await table(AlbumEntity)
            .flatMap(a => a.songs)
            .filter(s => s.seconds != null)
            .map(s => s.seconds == null)
            .toArray();
        assert.ok(Array.isArray(durations));
    });

    // from a select new { a.Name, Value = 3 }
    test("SelectAvoidNominate", async () => {
        const durations = await table(AlbumEntity)
            .map(a => ({ name: a.name, value: 3 }))
            .toArray();
        assert.ok(Array.isArray(durations));
    });

    // from a select new { a.Name, Friend = (Lite<BandEntity>?)null }
    // Not ported: the C# `(Lite<BandEntity>?)null` typed-null cast has no TS equivalent — a plain
    // `null` literal projects the same constant column.
    test("SelectAvoidNominateEntity", async () => {
        const durations = await table(AlbumEntity)
            .map(a => ({ name: a.name, friend: null }))
            .toArray();
        assert.ok(durations.length > 0);
        assert.ok(durations.every(d => typeof d.name === "string" && d.friend === null));
    });

    // Select(b => new { b.Members.Count, AnyDead = …Any(m => m.Dead), DeadCount = …Count(m => m.Dead), MinId/MaxId/AvgId/SumId })
    test("SelectSingleCellAggregate", async () => {
        const list = await table(BandEntity)
            .map(b => ({
                count: b.members.length,
                anyDead: b.members.some(m => m.member.dead),
                deadCount: b.members.filter(m => m.member.dead).length,
                minId: b.members.map(m => (m.member.id as number)).min(),
                maxId: b.members.map(m => (m.member.id as number)).max(),
                avgId: b.members.map(m => (m.member.id as number)).avg(),
                sumId: b.members.map(m => (m.member.id as number)).sum(),
            }))
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(r =>
            typeof r.count === "number" && r.count >= 0 &&
            typeof r.anyDead === "boolean" &&
            r.deadCount <= r.count &&
            (r.count === 0 || (r.minId! <= r.maxId! && r.sumId! >= r.maxId!))));
    });

    // artist = FirstEx(); Select(a => new { Lite = a.ToLite(), Memory = artist })
    test("SelectMemoryEntity", async () => {
        const artist = await table(ArtistEntity).first();
        const songs = await table(AlbumEntity)
            .map(a => ({ lite: a.toLite(), memory: artist }))
            .toArray();
        assert.ok(songs.length > 0);
        // memory is a captured in-memory entity projected into each row (materialised as a plain
        // object, not an Entity instance — no .is()); just verify it's present.
        assert.ok(songs.every(s => s.lite.entityType === AlbumEntity && s.memory != null));
    });

    // artist = Select(a => a.ToLite()).FirstEx(); Select(a => new { Lite = a.ToLite(), MemoryLite = artist })
    test("SelectMemoryLite", async () => {
        const artist = await table(ArtistEntity).map(a => a.toLite()).first();
        const songs = await table(AlbumEntity)
            .map(a => ({ lite: a.toLite(), memoryLite: artist }))
            .toArray();
        assert.ok(songs.length > 0);
        // memoryLite is a captured in-memory Lite projected per row (materialised as a plain
        // object, not a Lite instance — no .is()); just verify it's present.
        assert.ok(songs.every(s => s.lite.entityType === AlbumEntity && s.memoryLite != null));
    });

    // Select(a => ((AmericanMusicAwardEntity)(AwardEntity)a).Category)  — cross-hierarchy cast → null
    // A GrammyAward row cast to the sibling AmericanMusicAward can never match (disjoint
    // per-type tables), so the cast yields a null-id entity and .category reads null per row.
    test("SelectOutsideStringNull", async () => {
        const awards = await table(GrammyAwardEntity)
            .map(a => ((a as AwardEntity) as AmericanMusicAwardEntity).category)
            .toArray();
        assert.ok(awards.length > 0);
        assert.ok(awards.every(c => c == null));
    });

    // Select(a => ((AmericanMusicAwardEntity)(AwardEntity)a).ToLite())  — cross-hierarchy cast → null
    test("SelectOutsideLiteNull", async () => {
        const awards = await table(GrammyAwardEntity)
            .map(a => ((a as AwardEntity) as AmericanMusicAwardEntity).toLite())
            .toArray();
        assert.ok(awards.length > 0);
        assert.ok(awards.every(l => l == null));
    });

    // from mle in Database.MListQuery((ArtistEntity a) => a.Friends) select new { Artis = mle.Parent.Name, Friend = mle.Element.Entity.Name }
    // Divergence: altea has no MListQuery standalone source, so the friends collection is reached
    // via flatMap; mle.artist / mle.friend are the back-reference and Lite element, dereferenced
    // with .entity.name.
    test("SelectMListLite", async () => {
        const lists = await table(ArtistEntity)
            .flatMap(a => a.friends)
            .map(mle => ({ artis: mle.artist.entity.name, friend: mle.friend.entity.name }))
            .toArray();
        assert.ok(lists.length > 0);
        assert.ok(lists.every(r => typeof r.artis === "string" && typeof r.friend === "string"));
    });

    // from mle in Database.MListQuery((BandEntity a) => a.Members) select new { Band = mle.Parent.Name, Artis = mle.Element.Name }
    // Divergence: no MListQuery standalone source; the members collection is reached via flatMap.
    test("SelectMListEntity", async () => {
        const lists = await table(BandEntity)
            .flatMap(a => a.members)
            .map(mle => ({ band: mle.band.entity.name, artis: mle.member.name }))
            .toArray();
        assert.ok(lists.length > 0);
        assert.ok(lists.every(r => typeof r.band === "string" && typeof r.artis === "string"));
    });

    // from mle in Database.MListQuery((AlbumEntity a) => a.Songs) select mle
    // Divergence: no MListQuery standalone source; the songs collection is reached via flatMap.
    test("SelectMListEmbedded", async () => {
        const lists = await table(AlbumEntity).flatMap(a => a.songs).toArray();
        assert.ok(lists.length > 0);
        assert.ok(lists.every(s => typeof s.name === "string"));
    });

    // from a select new { a.Name, Songs = a.Songs.ToList() }
    test("SelectMListEmbeddedToList", async () => {
        const lists = await table(AlbumEntity)
            .map(a => ({ name: a.name, songs: a.songs }))
            .toArray();
        assert.ok(lists.length > 0);
        // Each album carries its own eager-loaded song list, fields materialised.
        assert.ok(lists.every(x => typeof x.name === "string" && Array.isArray(x.songs)));
        assert.ok(lists.every(x => x.songs.every(s => typeof s.name === "string")));
        // The per-album buckets partition all song rows.
        const total = (await table(AlbumEntity).flatMap(a => a.songs).toArray()).length;
        assert.equal(lists.reduce((n, x) => n + x.songs.length, 0), total);
    });

    // from alb let mich = ((ArtistEntity)alb.Author) where mich.Name.Contains("Michael") select mich
    // … sp.Distinct(ReferenceEqualityComparer).SingleEx(); Assert.Equal(single.Friends.Distinct().Count(), single.Friends.Count)
    // The in-memory ReferenceEqualityComparer Distinct tail is a C#-only assertion detail; the
    // translatable part (entity cast + name filter) runs and returns the Michael artists.
    test("SelectMListPotentialDuplicates", async () => {
        const sp = await table(AlbumEntity)
            .map(alb => alb.author as ArtistEntity)
            .filter(mich => mich.name.contains("Michael"))
            .toArray();
        assert.ok(sp.length > 0);
        assert.ok(sp.every(m => m instanceof ArtistEntity && m.name.includes("Michael")));
    });

    // Database.Query<ArtistEntity>().Select(a => a.LastAward.Try(la => la.Id)).ToList();
    // C#'s `.Try(la => la.Id)` is Signum's null-propagation helper — it simulates `?.` inside an
    // expression tree (C# can't put `?.` in one). altea writes it directly as `a.lastAward?.id`.
    // lastAward is a nullable @implementedByAll; its `.id` lowers to the COALESCEd per-type id
    // string, so the projection is `string | null` — null for the artists with no lastAward.
    test("SelectIBAId", async () => {
        const list = await table(ArtistEntity).map(a => a.lastAward?.id).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(x => x == null || typeof x === "string"));
        assert.ok(list.some(x => x != null)); // e.g. Michael Jackson has a lastAward
    });

    // Database.Query<NoteWithDateEntity>().Select(a => a.ToStringProperty).ToList();
    // The entity's toString (a stored ToStr column here) reads back as a string in a projection.
    test("SelectToStrField", async () => {
        const list = await table(NoteWithDateEntity).map(a => a.toString()).toArray();
        assert.ok(list.every(s => s == null || typeof s === "string"));
    });

    // Database.Query<AlbumEntity>().Select(a => a.ToStringProperty).ToList();
    // AlbumEntity's @quoted toString (`${name} (${author})`) expands inline in the projection.
    test("SelectFakedToString", async () => {
        const list = await table(AlbumEntity).map(a => a.toString()).toArray();
        assert.ok(list.every(s => s == null || typeof s === "string"));
    });

    // Select(a => new { Wrong = a.Author.GetType() == typeof(BandEntity) ? "Band {0}".FormatWith(((BandEntity)a.Author).ToString()) : …, Right = a.Author is BandEntity ? … : … })
    // C#'s FormatWith/string-interpolation becomes `"Band " + …`; GetType==typeof / `is` / cast /
    // entity toString all lower to SQL, so both projected strings materialise.
    test("SelectConditionFormat", async () => {
        const list = await table(AlbumEntity)
            .map(a => ({
                wrong: a.author.constructor === BandEntity
                    ? "Band " + (a.author as BandEntity).toString()
                    : "Artist " + (a.author as ArtistEntity).toString(),
                right: a.author instanceof BandEntity
                    ? "Band " + (a.author as BandEntity).toString()
                    : "Artist " + (a.author as ArtistEntity).toString(),
            }))
            .toArray();
        assert.ok(list.every(x => typeof x.wrong === "string" && typeof x.right === "string"));
    });

    // Database.Query<AlbumEntity>().Select(a => a.ToString()).ToList();
    test("SelectToString", async () => {
        const list = await table(AlbumEntity).map(a => a.toString()).toArray();
        assert.ok(list.every(s => s == null || typeof s === "string"));
    });

    // Database.Query<AlbumEntity>().Select(a => a.ToLite().ToString()).ToList();
    test("SelectToStringLite", async () => {
        const list = await table(AlbumEntity).map(a => a.toLite().toString()).toArray();
        assert.ok(list.every(s => s == null || typeof s === "string"));
    });

    // from b let ga = (GrammyAwardEntity?)b.LastAward select (AwardResult?)(ga.Result < ga.Result ? (int)ga.Result : (int)ga.Result).InSql()
    // Divergences: the `let ga = …` cast is inlined (expression body, no statement block) and
    // InSql() (a force-evaluate-in-SQL hint) is dropped — the value is computed in SQL anyway.
    // b.lastAward is @implementedBy(Grammy, AMA); the cast narrows to Grammy (null for AMA), so
    // the projected AwardResult enum (a number) is null for a non-Grammy lastAward.
    test("SelectConditionEnum", async () => {
        const results = await table(BandEntity)
            .map(b => (b.lastAward as GrammyAwardEntity).result < (b.lastAward as GrammyAwardEntity).result
                ? (b.lastAward as GrammyAwardEntity).result
                : (b.lastAward as GrammyAwardEntity).result)
            .toArray();
        assert.ok(results.every(r => r == null || typeof r === "number"));
        const grammyLastAward = await table(BandEntity).filter(b => GrammyAwardEntity.isInstance(b.lastAward)).count();
        assert.equal(results.filter(r => r != null).length, grammyLastAward);
        assert.ok(grammyLastAward > 0);
    });

    // Database.Query<ArtistEntity>().SelectMany(a => a.Friends).Select(a => a.Id).ToList();
    // Signum models Friends as MList<Lite<ArtistEntity>>, so `.Id` is the friend's id; altea models
    // it as a link part-entity (ArtistEntity_Friends), so `a.id` here is the LINK ROW's id — a plain
    // number per link row. (For the friend's id, project `f.friend.id`, as SelectMListIdCovariance does.)
    test("SelectMListId", async () => {
        const list = await table(ArtistEntity).flatMap(a => a.friends).map(a => a.id).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(id => typeof id === "number"));
        assert.equal(new Set(list).size, list.length); // link-row ids are distinct
    });

    // Database.Query<ArtistEntity>().SelectMany(a => a.FriendsCovariant()).Select(a => a.Id).ToList();
    // friendsCovariant() is a @quoted member — its body `friends.map(f => f.friend.entity)` is
    // inlined (expanded) into the query, so it produces the same friend ids as navigating
    // `friends` directly. The projection optimises to just the FriendID column.
    test("SelectMListIdCovariance", async () => {
        const list = await table(ArtistEntity).flatMap(a => a.friendsCovariant()).map(a => a.id).toArray();
        const direct = await table(ArtistEntity).flatMap(a => a.friends).map(f => f.friend.id).toArray();
        assert.ok(list.length > 0);
        assert.deepEqual([...list].sort((x, y) => (x as number) - (y as number)), [...direct].sort((x, y) => (x as number) - (y as number)));
    });

    // from a from s in a.Songs.Where(s => s.Seconds < 0).DefaultIfEmpty() select new { a, s }; Assert.True(All(p => p.s == null))
    // altea's flatMap has no result-selector overload, so the C# `select new { a, s }` is folded
    // into the collection map. defaultIfEmpty() must be the LAST operator of the collection
    // selector, so it comes after the map — the flatMap becomes an OUTER APPLY over the {s,a}
    // pairs, and an album with no matching song yields one row whose s (and a) are null.
    test("SelectEmbeddedListNotNullableNull", async () => {
        const list = await table(AlbumEntity)
            .flatMap(a => a.songs.filter(s => (s.seconds ?? 0) < 0).map(s => ({ s, a })).defaultIfEmpty())
            .toArray();
        assert.ok(list.length > 0 && list.every(p => p.s == null));
    });

    // from a from s in a.MListElements(_ => _.Songs).Where(s => s.Element.Seconds < 0).DefaultIfEmpty() select new { a, s }
    // Divergence: altea has no MListElements (link-row / RowId access), so the part-entity
    // collection `a.songs` is used directly; defaultIfEmpty() (last) drives the OUTER APPLY.
    test("SelectEmbeddedListElementNotNullableNull", async () => {
        const list = await table(AlbumEntity)
            .flatMap(a => a.songs.filter(s => (s.seconds ?? 0) < 0).map(s => ({ s, a })).defaultIfEmpty())
            .toArray();
        assert.ok(list.length > 0 && list.every(p => p.s == null));
    });

    // max = 0; blas = a => a.Id > max; from a from s in Query<AlbumEntity>().Where(blas) select new { a, s }
    // Cross join: flatMap over a second independent `table(...)` scan becomes a CROSS APPLY
    // (SQL Server) / CROSS JOIN LATERAL (Postgres). Every album is paired with every album
    // whose id > 0 (all of them), so the flattened result is n² albums.
    test("SelectWhereExpressionInSelectMany", async () => {
        const max = 0;
        const n = await table(AlbumEntity).count();
        const list = await table(AlbumEntity)
            .flatMap(a => table(AlbumEntity).filter(s => (s.id as number) > max))
            .toArray();
        assert.equal(list.length, n * n);
        assert.ok(list.every(x => x instanceof AlbumEntity));
    });

    // Database.Query<AlbumEntity>().SelectMany(a => a.Songs).ToList();
    test("SelectEmbedded", async () => {
        const list = await table(AlbumEntity).flatMap(a => a.songs).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.View<PgClass>() / Database.View<SysDatabases>()
    // Database.View<T>() is `view(T)` in altea. The very system catalog views Signum's test uses
    // ARE modelled here (the synchronizer introspects through them): PgClass (pg_class) on
    // Postgres, SysDatabases (sys.databases) on SQL Server. Query the dialect's one live.
    test("SelectView", async () => {
        if (Connector.current().isPostgres) {
            const names = await view(PgClass).filter(c => c.relkind == "r").map(c => c.relname).toArray();
            assert.ok(names.length > 0 && names.every(n => typeof n === "string"));
        } else {
            const names = await view(SysDatabases).map(d => d.name).toArray();
            assert.ok(names.length > 0 && names.every(n => typeof n === "string"));
        }
    });

    // Signum's SelectRetrieve: Select(l => l.Owner!.RetrieveAndRemember()) throws
    // InvalidOperationException("not supported"). retrieveAndRemember() loads the entity at
    // runtime and has no SQL translation — a common mistake is calling it to dereference a
    // lite inside a query instead of navigating with `.entity`. altea rejects it with a clear,
    // educational message (see logic/index.ts).
    test("SelectRetrieve", async () => {
        await assert.rejects(
            async () => table(LabelEntity).map(l => l.owner!.retrieveAndRemember()).toArray(),
            /can't be used inside a query/);
    });

    // Database.Query<AlbumEntity>().WithHint("INDEX(IX_Album_LabelID)").Select(a => a.Label.Name).ToList();
    // WithHint attaches a SQL Server table hint to the primary table. C# uses an INDEX hint keyed
    // to a specific index name; altea uses NOLOCK — the same feature exercised without depending on
    // altea's (dialect-cased) generated index names. SQL Server renders `… AS a WITH(NOLOCK)`;
    // Postgres has no table-hint syntax so the hint is dropped and the query runs unhinted.
    test("SelectWithHint", async () => {
        const query = table(AlbumEntity).withHint("NOLOCK").map(a => a.label.name);
        const list = await query.toArray();
        assert.ok(Array.isArray(list));
        assert.ok(list.length > 0);
        const sql = query.queryTextForDebug();
        if (Connector.default!.isPostgres)
            assert.doesNotMatch(sql, /WITH\s*\(/i);
        else
            assert.match(sql, /WITH\(NOLOCK\)/i);
    });

    // Expression<Func<AlbumEntity,bool>> selector = a => a.Id > 10;
    // Expression<Func<AlbumEntity,double>> selectorDouble = Convert(selector.Body, double);
    // var list = Database.Query<AlbumEntity>().Average(selectorDouble);   // C# asserts nothing on the value
    // Like C#, the selector is its own variable. Signum's bool→double is TWO casts; altea spells
    // both out honestly: `toInt(a.id > 10)` is the bool→int cast, `Number(...)` the int→double cast.
    // Each lowers to a single SQL CAST in the nominator (on SQL Server the bool is a predicate, so
    // toInt emits `CASE WHEN … THEN 1 ELSE 0 END`), so AVG runs over a floating type. Value unchecked.
    test("SelectAverageBool", async () => {
        const selectorDouble: Quoted<(a: AlbumEntity) => number> = a => Number(toInt((a.id as number) > 10));
        const result = await table(AlbumEntity).avg(selectorDouble);
        assert.ok(result != null); // ran (SS: int; pg: numeric → decimal) — like C#, the value isn't checked
    });

    // var list = Query<ArtistEntity>().ToList(); Assert.True(!Query<ArtistEntity>().QueryText().Contains("DISTINCT"))
    // A "virtual MList" (Signum's back-referenced collection with no link table) has no special
    // construct in altea — its rows are queried directly as `table(TheChildEntity)`, so nothing
    // injects a DISTINCT. This asserts the plain root query stays DISTINCT-free.
    test("SelectVirtualMListNoDistinct", async () => {
        const list = await table(ArtistEntity).toArray();
        assert.ok(Array.isArray(list));
        assert.ok(!table(ArtistEntity).queryTextForDebug().includes("DISTINCT"));
    });

    // Select(a => ((int)a.Id / 10m)).Select(a => ((decimal?)a).InSql()); Assert.Contains(list, a => a.Value != Math.Round(a.Value))
    // Signum's `10m` makes the division decimal so SQL preserves the places under InSql(). altea's
    // equivalent is `toDecimal(a.id)` — a CAST to decimal/numeric, so `toDecimal(a.id) / 10`
    // divides in decimal and keeps the .5 server-side. Three ways: lazy client-side float (keeps
    // places), plain int/int forced to SQL (integer division truncates), and toDecimal in SQL
    // (decimal division keeps places, matching Signum's 10m).
    test("AvoidDecimalCastinInSql", async () => {
        const clientSide = await table(ArtistEntity).map(a => (a.id as number) / 10).toArray();
        assert.ok(clientSide.some(a => !Number.isInteger(a)));                  // lazy JS keeps the .5
        const intInSql = await table(ArtistEntity).map(a => inSql((a.id as number) / 10)).toArray();
        assert.ok(intInSql.every(a => Number.isInteger(a)));                    // SQL int-division truncates
        const decimalInSql = await table(ArtistEntity).map(a => inSql(toDecimal(a.id as number) / 10)).toArray();
        assert.ok(decimalInSql.some(a => Number(a) % 1 !== 0));                 // decimal division keeps the .5
    });
});
