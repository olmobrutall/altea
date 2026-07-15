import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.startsWith / contains / … (SQL-mappable)
import { hasDb, start } from "./setup";
import { Lite } from "@altea/altea/entities/lite";
import {
    ArtistEntity, AlbumEntity, BandEntity, LabelEntity,
    NoteWithDateEntity, AwardNominationEntity, GrammyAwardEntity,
    type IAuthorEntity,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/SelectImplementations.cs (class
// SelectImplementationsTest1). C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Select(...) → .map(...)
//   .Where(...)          → .filter(...)        .SelectMany(...) → .flatMap(...)
//   .ToList()/.ToArray() → await .toArray()    .Count()     → await .count()
//   a.ToLite()           → a.toLite()          new { X = .. } → { x: .. } (camelCase)
//   x is ArtistEntity    → x instanceof ArtistEntity
//   (ArtistEntity)x      → (x as ArtistEntity)
//   lite.Entity          → lite.entity (navigate a Lite<T> via .entity)
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// This file is heavy on polymorphism. Signum interface types (IAuthorEntity) do
// NOT exist in altea — author/target/award are `Entity` (or `Lite<Entity>`) with
// @implementedBy/@implementedByAll. Tests depending on the interface are
// skipped+flagged. CombineUnion/CombineCase are modelled (`.combineUnion()` /
// `.combineCase()` on any reference). GetType, typeof, EntityType, Cast/OfType
// operators, Try(...), and entity casts in queries are still unmodelled. Those are
// written in their most natural altea form, marked `{ skip: true }`, and flagged
// with a `// TODO(api): …` comment. Skipped tests still compile.

describe("SelectImplementationsTest1", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<AlbumEntity>().Select(a => a.GetType()).ToList();
    test("SelectType", async () => {
        const list = await table(AlbumEntity).map(a => a.constructor).toArray();
        // GetType() projects the runtime type — the AlbumEntity constructor for a single-table entity.
        assert.ok(list.length > 0 && list.every(t => t === AlbumEntity));
    });

    // Database.Query<LabelEntity>().Select(a => new { Label = a.ToLite(), a.Owner, OwnerType = a.Owner!.Entity.GetType() }).ToList();
    test("SelectTypeNull", async () => {
        const list = await table(LabelEntity)
            .map(a => ({ label: a.toLite(), owner: a.owner, ownerType: a.owner!.entity.constructor }))
            .toArray();
        // owner is a nullable Lite<LabelEntity>; its entity's runtime type is LabelEntity (null when absent).
        assert.ok(list.length > 0 && list.every(x => x.ownerType == null || x.ownerType === LabelEntity));
    });

    // Database.Query<AlbumEntity>().Select(a => a.Author.ToLite()).ToList();
    test("SelectLiteIB", async () => {
        const list = await table(AlbumEntity).map(a => a.author.toLite()).toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => new { ToStr1 = a.Author.ToLite(), ToStr2 = a.Author.ToLite() }); Assert.Equal(2, …LEFT OUTER JOIN); ToList()
    test("SelectLiteIBDouble", async () => {
        const list = await table(AlbumEntity)
            .map(a => ({ toStr1: a.author.toLite(), toStr2: a.author.toLite() }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => a.Author.CombineUnion().ToLite().ToString()!.Length > 0).Select(a => a.Author.CombineUnion().ToLite())
    test("SelectLiteIBDoubleWhereUnion", async () => {
        const list = await table(AlbumEntity)
            .filter(a => a.author.combineUnion().toLite().toString()!.length > 0)
            .map(a => a.author.combineUnion().toLite())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => a.Author.CombineCase().ToLite().ToString()!.Length > 0).Select(a => a.Author.CombineCase().ToLite())
    test("SelectLiteIBDoubleWhereSwitch", async () => {
        const list = await table(AlbumEntity)
            .filter(a => a.author.combineCase().toLite().toString()!.length > 0)
            .map(a => a.author.combineCase().toLite())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().Select(a => new { Type = a.Target.GetType(), Target = a.Target.ToLite() }).ToList();
    test("SelectTypeIBA", async () => {
        const list = await table(NoteWithDateEntity)
            .map(a => ({ type: a.target.constructor, target: a.target.toLite() }))
            .toArray();
        // target is @implementedByAll: GetType() resolves its stored type-id column to a constructor.
        assert.ok(list.length > 0 && list.every(x => x.type == null || typeof x.type === "function"));
    });

    // Database.Query<AwardNominationEntity>().Select(a => a.Award.EntityType).ToList();
    test("SelectTypeLiteIB", async () => {
        const list = await table(AwardNominationEntity).map(a => a.award.entityType).toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => a.LastAward == null ? null : a.LastAward.Id.ToString()).ToList();
    // The id of an @implementedByAll reference is the per-PK-type id columns cast to string
    // and coalesced (ibaId), so `.id` yields a string; null when the reference is null.
    test("SelectIdLiteIBA", async () => {
        const list = await table(ArtistEntity)
            .map(a => a.lastAward == null ? null : (a.lastAward.id as string))
            .toArray();
        assert.ok(list.every(x => x == null || typeof x === "string"));
        assert.ok(list.some(x => x != null)); // Michael Jackson has a lastAward
    });

    // Where(a => a.LastAward!.Id.ToString() == "3").ToList();
    test("WhereIdLiteIB", async () => {
        const list = await table(ArtistEntity)
            .filter(a => (a.lastAward!.id as string) == "3")
            .toArray();
        assert.ok(list.every(a => a instanceof ArtistEntity));
        // Positive check: read an artist's lastAward id back, filter by it, find the artist.
        const michaelAwardId = await table(ArtistEntity)
            .filter(a => a.name == "Michael Jackson").map(a => a.lastAward!.id as string).firstOrNull();
        assert.ok(michaelAwardId != null);
        const matched = await table(ArtistEntity).filter(a => (a.lastAward!.id as string) == michaelAwardId!).toArray();
        assert.ok(matched.some(a => a.name === "Michael Jackson"));
    });

    // Where(a => a.Friends.Select(a => a.ToString()).Contains(a.LastAward!.Id.ToString())).ToList();
    // The @implementedByAll .id binds inside a correlated subquery-membership test. No seeded
    // row has a friend whose ToString equals the lastAward id string, so the set is empty.
    test("ContainsIdLiteIB", async () => {
        const list = await table(ArtistEntity)
            .filter(a => a.friends.map(f => f.friend.toString()).contains(a.lastAward!.id as string))
            .toArray();
        assert.ok(list.every(a => a instanceof ArtistEntity));
    });

    // Database.Query<AwardNominationEntity>().Where(a => a.Award.Entity is GrammyAwardEntity).ToList();
    // GrammyAwardEntity.isInstance(x) is the static-method form of `x instanceof GrammyAwardEntity`.
    test("SelectEntityWithLiteIb", async () => {
        const list = await table(AwardNominationEntity)
            .filter(a => GrammyAwardEntity.isInstance(a.award.entity))
            .map(a => a.award)
            .toArray();
        assert.ok(list.every(l => l.entityType === GrammyAwardEntity));
    });

    // Where(a => a.Award.Entity.GetType() == typeof(GrammyAwardEntity)).ToList();
    test("SelectEntityWithLiteIbType", async () => {
        const list = await table(AwardNominationEntity)
            .filter(a => a.award.entity.constructor === GrammyAwardEntity)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Type[] types = { typeof(GrammyAwardEntity) }; Where(a => types.Contains(a.Award.Entity.GetType())).ToList();
    test("SelectEntityWithLiteIbTypeContains", async () => {
        const types: Function[] = [GrammyAwardEntity];
        const list = await table(AwardNominationEntity)
            .filter(a => types.contains(a.award.entity.constructor))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => a.Award.EntityType == typeof(GrammyAwardEntity)).ToList();
    test("SelectEntityWithLiteIbRuntimeType", async () => {
        const list = await table(AwardNominationEntity)
            .filter(a => a.award.entityType === GrammyAwardEntity)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<ArtistEntity>().Select(a => a.ToLite()).ToList();
    test("SelectLiteUpcast", async () => {
        const list = await table(ArtistEntity).map(a => a.toLite()).toArray();
        assert.ok(Array.isArray(list));
    });

    // SelectMany(a => a.Friends).Select(a => (Lite<IAuthorEntity>)a).ToList();
    // The `as Lite<IAuthorEntity>` upcast is a compile-time no-op: IAuthorEntity is an
    // unregistered interface, so the binder's visitCast falls through to identity and the
    // projected lite stays a Lite<ArtistEntity> at runtime.
    test("SelectLiteCastUpcast", async () => {
        const list = await table(ArtistEntity)
            .flatMap(a => a.friends)
            .map(a => a.friend as Lite<IAuthorEntity>)
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(l => l.entityType === ArtistEntity && l.id != null));
    });

    // SelectMany(a => a.Friends).Select(a => (Lite<ArtistEntity>)a).ToList();
    test("SelectLiteCastNocast", async () => {
        const list = await table(ArtistEntity)
            .flatMap(a => a.friends)
            .map(a => a.friend)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => (Lite<ArtistEntity>)a.Author.ToLite()).ToList();
    // Lite downcast: a.author is @implementedBy(Artist, Band); narrowing the lite to
    // Lite<ArtistEntity> keeps the artist-authored rows (null for band-authored).
    test("SelectLiteCastDowncast", async () => {
        const list = await table(AlbumEntity).map(a => a.author.toLite() as Lite<ArtistEntity>).toArray();
        assert.ok(list.every(l => l == null || l.entityType === ArtistEntity));
        const artistAuthored = await table(AlbumEntity).filter(a => ArtistEntity.isInstance(a.author)).count();
        assert.equal(list.filter(l => l != null).length, artistAuthored);
        assert.ok(artistAuthored > 0);
    });

    // SelectAuthorsLite<ArtistEntity, IAuthorEntity>(): Select(a => a.ToLite<LT>())
    // altea has no generic `toLite<IAuthorEntity>()`; the interface-typed lite is the
    // ordinary `toLite()` upcast with `as Lite<IAuthorEntity>` (identity in the binder).
    test("SelectLiteGenericUpcast", async () => {
        const list = await table(ArtistEntity).map(a => a.toLite() as Lite<IAuthorEntity>).toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(l => l.entityType === ArtistEntity && l.id != null));
    });

    // from a let band = (BandEntity)a.Author select new { Artist = band.ToString(), Author = a.Author.CombineUnion().ToString() }
    test("SelectLiteIBRedundantUnion", async () => {
        const list = await table(AlbumEntity)
            .map(a => ({ artist: (a.author as BandEntity).toString(), author: a.author.combineUnion().toString() }))
            .toArray();
        assert.equal(await table(AlbumEntity).count(), list.length);
    });

    // from a let band = (BandEntity)a.Author select new { Artist = band.ToString(), Author = a.Author.CombineCase().ToString() }
    test("SelectLiteIBRedundantSwitch", async () => {
        const list = await table(AlbumEntity)
            .map(a => ({ artist: (a.author as BandEntity).toString(), author: a.author.combineCase().toString() }))
            .toArray();
        assert.equal(await table(AlbumEntity).count(), list.length);
    });

    // Select(a => a.Author.CombineUnion().ToLite()).Where(a => a.ToString()!.StartsWith("Michael")).ToList();
    test("SelectLiteIBWhereUnion", async () => {
        const list = await table(AlbumEntity)
            .map(a => a.author.combineUnion().toLite())
            .filter(a => a.toString()!.startsWith("Michael"))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => a.Author.CombineCase().ToLite()).Where(a => a.ToString()!.StartsWith("Michael")).ToList();
    test("SelectLiteIBWhereSwitch", async () => {
        const list = await table(AlbumEntity)
            .map(a => a.author.combineCase().toLite())
            .filter(a => a.toString()!.startsWith("Michael"))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().Select(a => a.Target.ToLite()).ToList();  (duplicate name SelectLiteIBA)
    test("SelectLiteIBA", async () => {
        const list = await table(NoteWithDateEntity).map(a => a.target.toLite()).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<ArtistEntity>().ToList();
    test("SelectSimpleEntity", async () => {
        const list3 = await table(ArtistEntity).toArray();
        assert.ok(Array.isArray(list3));
    });

    // Database.Query<AlbumEntity>().ToList();
    test("SelectEntity", async () => {
        const list3 = await table(AlbumEntity).toArray();
        assert.ok(Array.isArray(list3));
    });

    // Database.Query<AlbumEntity>().Select(a => a).ToList();
    test("SelectEntitySelect", async () => {
        const list = await table(AlbumEntity).map(a => a).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().Select(a => a.Author).ToList();
    test("SelectEntityIB", async () => {
        const list = await table(AlbumEntity).map(a => a.author).toArray();
        assert.ok(Array.isArray(list));
    });

    // from a let aut = a.Author select new { aut, a.Author }
    test("SelectEntityIBRedundan", async () => {
        const list = await table(AlbumEntity)
            .map(a => ({ aut: a.author, author: a.author }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<NoteWithDateEntity>().Select(a => a.Target).ToList();
    test("SelectEntityIBA", async () => {
        const list = await table(NoteWithDateEntity).map(a => a.target).toArray();
        assert.ok(Array.isArray(list));
    });

    // from a select ((ArtistEntity)a.Author).Name ?? ((BandEntity)a.Author).Name
    // Casting an @implementedBy reference to a concrete implementation reads that impl's column
    // (null when the row is the other impl); the ?? coalesces to the author's name.
    test("SelectCastIB", async () => {
        const list = await table(AlbumEntity)
            .map(a => (a.author as ArtistEntity).name ?? (a.author as BandEntity).name)
            .toArray();
        assert.ok(list.length > 0 && list.every(n => n != null));
    });

    // from a select a.Author.CombineUnion().Name
    test("SelectCastIBPolymorphicUnion", async () => {
        const list = await table(AlbumEntity).map(a => a.author.combineUnion().name).toArray();
        assert.ok(Array.isArray(list));
    });

    // from a select a.Author.CombineCase().Name
    test("SelectCastIBPolymorphicSwitch", async () => {
        const list = await table(AlbumEntity).map(a => a.author.combineCase().name).toArray();
        assert.ok(Array.isArray(list));
    });

    // from a select (int?)a.Award!.Entity.Year
    // a.award is a Lite<Entity> over @implementedBy(Grammy, Personal, AMA); .entity derefs to
    // the IB reference, the cast narrows to Grammy (null for the other impls / null award),
    // and .year reads the Grammy column — null for a non-Grammy nomination.
    test("SelectCastIBPolymorphicForceNullify", async () => {
        const list = await table(AwardNominationEntity)
            .map(a => (a.award!.entity as GrammyAwardEntity).year)
            .toArray();
        assert.ok(list.every(y => y == null || typeof y === "number"));
        const grammyNoms = await table(AwardNominationEntity).filter(a => GrammyAwardEntity.isLite(a.award)).count();
        assert.equal(list.filter(y => y != null).length, grammyNoms);
        assert.ok(grammyNoms > 0);
    });

    // from a select a.Author.CombineUnion().LastAward.Try(la => la.ToLite())
    test("SelectCastIBPolymorphicIBUnion", async () => {
        const list = await table(AlbumEntity)
            .map(a => a.author.combineUnion().lastAward?.toLite())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from a select a.Author.CombineCase().LastAward.Try(la => la.ToLite())
    test("SelectCastIBPolymorphicIBSwitch", async () => {
        const list = await table(AlbumEntity)
            .map(a => a.author.combineCase().lastAward?.toLite())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from n select ((ArtistEntity)n.Target).Name ?? ((AlbumEntity)n.Target).Name ?? ((BandEntity)n.Target).Name
    // Each IBA cast reads the id guarded by the type discriminator, so a target of the wrong
    // type yields a null name and the coalesce falls through to the matching type's cast.
    test("SelectCastIBA", async () => {
        const list = await table(NoteWithDateEntity)
            .map(n => (n.target as ArtistEntity).name ?? (n.target as AlbumEntity).name ?? (n.target as BandEntity).name)
            .toArray();
        // Every seeded note targets an Artist/Album/Band, so every row coalesces to a name.
        assert.ok(list.length > 0);
        assert.ok(list.every(n => typeof n === "string"));
    });

    // (from n select n.Target).Cast<BandEntity>().ToList();
    test("SelectCastIBACastOperator", async () => {
        const list = await table(NoteWithDateEntity).map(n => n.target).cast(BandEntity).toArray();
        assert.ok(Array.isArray(list));
    });

    // (from n select n.Target).OfType<BandEntity>().ToList();
    test("SelectCastIBAOfTypeOperator", async () => {
        const list = await table(NoteWithDateEntity).map(n => n.target).ofType(BandEntity).toArray();
        assert.ok(Array.isArray(list));
    });

    // from a select (a.Author is ArtistEntity ? ((ArtistEntity)a.Author).Name : ((BandEntity)a.Author).Name)
    test("SelectCastIsIB", async () => {
        const list = await table(AlbumEntity)
            .map(a => a.author instanceof ArtistEntity ? (a.author as ArtistEntity).name : (a.author as BandEntity).name)
            .toArray();
        assert.ok(list.length > 0 && list.every(n => n != null));
    });

    // from n select n.Target is ArtistEntity ? ((ArtistEntity)n.Target).Name : ((BandEntity)n.Target).Name
    // Artist targets → artist name; the else-branch casts to Band, so a Band target → band
    // name and any other type (e.g. the Album target) → null (type-guarded id nulls out).
    test("SelectCastIsIBA", async () => {
        const list = await table(NoteWithDateEntity)
            .map(n => n.target instanceof ArtistEntity ? (n.target as ArtistEntity).name : (n.target as BandEntity).name)
            .toArray();
        assert.ok(list.some(n => n != null));
        assert.ok(list.every(n => n == null || typeof n === "string"));
    });

    // from n select new { Name = … ? ((ArtistEntity)n.Target).Name : ((BandEntity)n.Target).Name, FullName = … ? ((ArtistEntity)n.Target).FullName : ((BandEntity)n.Target).FullName }
    // IBA downcast + .name works; fullName() is a @quoted method, inlined by fromQuoted from
    // the concrete cast type (ArtistEntity/BandEntity.prototype.fullName.__quoted).
    test("SelectCastIsIBADouble", async () => {
        const list = await table(NoteWithDateEntity)
            .map(n => ({
                name: n.target instanceof ArtistEntity ? (n.target as ArtistEntity).name : (n.target as BandEntity).name,
                fullName: n.target instanceof ArtistEntity ? (n.target as ArtistEntity).fullName() : (n.target as BandEntity).fullName(),
            }))
            .toArray();
        assert.ok(list.length > 0);
        // fullName() is @quoted `() => this.name` on both, so it equals the name branch.
        assert.ok(list.every(x => x.fullName === x.name));
    });

    // from n where (… ? ((ArtistEntity)n.Target).Name : ((BandEntity)n.Target).Name).Length > 0 select … ((ArtistEntity)n.Target).FullName : ((BandEntity)n.Target).FullName
    // IBA downcast + .name/.length + the @quoted fullName() all bind; a @quoted body inlines
    // in both a WHERE (via fullNominate) and a projection.
    test("SelectCastIsIBADoubleWhere", async () => {
        const list = await table(NoteWithDateEntity)
            .filter(n => (n.target instanceof ArtistEntity ? (n.target as ArtistEntity).name : (n.target as BandEntity).name).length > 0)
            .map(n => n.target instanceof ArtistEntity ? (n.target as ArtistEntity).fullName() : (n.target as BandEntity).fullName())
            .toArray();
        assert.ok(list.every(s => s == null || typeof s === "string"));
    });

    // from n where n.Target.ToLite() is Lite<AlbumEntity> select n.Target.ToLite()
    // `is Lite<AlbumEntity>` → AlbumEntity.isLite(...) (TS erases the generic, so a
    // dedicated method reads the lite's entityType instead of `instanceof`).
    test("SelectIsIBLite", async () => {
        const list = await table(NoteWithDateEntity)
            .filter(n => AlbumEntity.isLite(n.target.toLite()))
            .map(n => n.target.toLite())
            .toArray();
        assert.ok(list.every(l => l.entityType === AlbumEntity));
    });

    // from a where a.Author is Lite<BandEntity> select a.Author
    // a.Author is a Lite<IAuthorEntity> (@implementedBy Artist/Band); isLite narrows to Band.
    test("SelectIsIBALite", async () => {
        const list = await table(AwardNominationEntity)
            .filter(a => BandEntity.isLite(a.author))
            .map(a => a.author)
            .toArray();
        assert.ok(list.every(l => l.entityType === BandEntity));
    });

    // from n select (Lite<AlbumEntity>)n.Target.ToLite()
    // Lite downcast over an @implementedByAll target: narrows to the album rows.
    test("SelectCastIBALite", async () => {
        const list = await table(NoteWithDateEntity).map(n => n.target.toLite() as Lite<AlbumEntity>).toArray();
        assert.ok(list.every(l => l == null || l.entityType === AlbumEntity));
        const albumTargets = await table(NoteWithDateEntity).filter(n => AlbumEntity.isInstance(n.target)).count();
        assert.equal(list.filter(l => l != null).length, albumTargets);
    });

    // from a select (Lite<BandEntity>)a.Author
    // Lite downcast on a Lite<IAuthorEntity> field (@implementedBy): narrows to band rows.
    test("SelectCastIBLite", async () => {
        const list = await table(AwardNominationEntity).map(a => a.author as Lite<BandEntity>).toArray();
        assert.ok(list.every(l => l == null || l.entityType === BandEntity));
        const bandAuthored = await table(AwardNominationEntity).filter(a => BandEntity.isLite(a.author)).count();
        assert.equal(list.filter(l => l != null).length, bandAuthored);
    });

    // The `instanceof` operator on a LITE is ALWAYS false in the provider (as it is in plain JS —
    // a lite is never a runtime instance of the entity), so this filter returns NO rows. The real
    // lite type-test is `AlbumEntity.isLite(lite)` / `lite.isInstanceOf(AlbumEntity)` below.
    test("SelectIsIBLiteOperatorAlwaysFalse", async () => {
        const viaOperator = await table(NoteWithDateEntity)
            .filter(n => n.target.toLite() instanceof AlbumEntity)
            .map(n => n.target.toLite())
            .toArray();
        assert.equal(viaOperator.length, 0);
        // …while the method form really does find the album-targeted rows.
        const viaMethod = await table(NoteWithDateEntity).count(n => AlbumEntity.isLite(n.target.toLite()));
        assert.ok(viaMethod > 0);
    });

    // The `lite.isInstanceOf(Ctor)` method form inside a query — the same lowering as the operator.
    test("SelectIsIBLiteIsInstanceOfMethod", async () => {
        const list = await table(NoteWithDateEntity)
            .filter(n => n.target.toLite().isInstanceOf(AlbumEntity))
            .map(n => n.target.toLite())
            .toArray();
        assert.ok(list.every(l => l.entityType === AlbumEntity));
        const viaStatic = await table(NoteWithDateEntity).count(n => AlbumEntity.isLite(n.target.toLite()));
        assert.equal(list.length, viaStatic);
    });

    // On an @implementedBy lite field (author = Lite<IAuthorEntity>): the `instanceof` operator is
    // always-false (empty), the `isInstanceOf` method is the real test (matches `isLite`).
    test("SelectIsIBALiteOperatorVsMethod", async () => {
        const viaOperator = await table(AwardNominationEntity).filter(a => a.author instanceof BandEntity).count();
        const viaMethod = await table(AwardNominationEntity).filter(a => a.author.isInstanceOf(BandEntity)).count();
        const viaStatic = await table(AwardNominationEntity).count(a => BandEntity.isLite(a.author));
        assert.equal(viaOperator, 0);
        assert.equal(viaMethod, viaStatic);
        assert.ok(viaStatic > 0);
    });

    // The `instanceof` operator on an ENTITY reference (already worked; locks parity with isInstance).
    test("SelectAuthorInstanceOfBand", async () => {
        const viaOperator = await table(AlbumEntity).filter(a => a.author instanceof BandEntity).count();
        const viaStatic = await table(AlbumEntity).count(a => BandEntity.isInstance(a.author));
        assert.equal(viaOperator, viaStatic);
        assert.ok(viaOperator > 0);
    });

    // In memory: `lite.isInstanceOf(Ctor)` is honest (reads the lite's entityType, subtype-inclusive).
    // The raw `instanceof` operator can't be — a lite is never a JS instance of the entity — hence the method.
    test("IsInstanceOfInMemory", async () => {
        const artist = await table(ArtistEntity).first();
        const lite = artist.toLite();
        assert.equal(lite.isInstanceOf(ArtistEntity), true);
        assert.equal(lite.isInstanceOf(BandEntity), false);
        assert.equal(lite instanceof ArtistEntity, false); // the operator lies in memory — use isInstanceOf
    });
});
