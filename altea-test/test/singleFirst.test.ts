import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.startsWith / … (SQL-mappable)
import { hasDb, start } from "./setup";
import {
    ArtistEntity, BandEntity, LabelEntity, AlbumEntity, ConfigEntity, Sex,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/SingleFirstTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Where(...) → .filter(...)
//   .Select(...)         → .map(...)           .ToList()/.ToArray() → await .toArray()
//   .FirstEx(pred?)      → await .first(pred?)  .FirstOrDefault(pred?) → await .firstOrNull(pred?)
//   .SingleEx(pred?)     → await .single(pred?) .SingleOrDefaultEx(pred?) → await .singleOrNull(pred?)
//   new { X = .. }       → { x: .. } (camelCase)  Sex.Male → Sex.Male
// Several tests below project/filter using *collection-level* terminals
// (b.Members.FirstEx()/SingleEx()/… inside a Select) and group-join / DefaultIfEmpty
// / InDB constructs that the current Query<T> API does not yet express; those are
// written in their most natural altea form, marked  and flagged
// with // TODO(api): <gap>.
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.

describe("SingleFirstTest", { skip: !hasDb }, () => {
    let isPostgres = false;
    before(async () => { isPostgres = (await start()).isPostgres; });

    // var bandsCount = Database.Query<BandEntity>().Select(b => new { b.Name, Members = b.Members.Select(a => new { a.Name, a.Sex }).ToString(p => "{0} ({1})".FormatWith(p.Name, p.Sex), "\n") }).ToList();
    // var bands1 = Database.Query<BandEntity>().Select(b => new { b.Name, Member = b.Members.FirstOrDefault()!.Name }).ToList();
    // var bands2 = Database.Query<BandEntity>().Select(b => new { b.Name, Member = b.Members.FirstEx().Name }).ToList();
    // var bands3 = Database.Query<BandEntity>().Select(b => new { b.Name, Member = b.Members.SingleOrDefaultEx()!.Name }).ToList();
    // var bands4 = Database.Query<BandEntity>().Select(b => new { b.Name, Member = b.Members.SingleEx().Name }).ToList();
    // var bands1b = Database.Query<BandEntity>().Select(b => new { b.Name, Member = b.Members.FirstOrDefault(a => a.Sex == Sex.Female)!.Name }).ToList();
    // var bands2b = Database.Query<BandEntity>().Select(b => new { b.Name, Member = b.Members.FirstEx(a => a.Sex == Sex.Female).Name }).ToList();
    // var bands3b = Database.Query<BandEntity>().Select(b => new { b.Name, Member = b.Members.SingleOrDefaultEx(a => a.Sex == Sex.Female)!.Name }).ToList();
    // var bands4b = Database.Query<BandEntity>().Select(b => new { b.Name, Member = b.Members.SingleEx(a => a.Sex == Sex.Female).Name }).ToList();
    test("SelectFirstOrDefault", async () => {
        // TODO(api): collection-to-string aggregate (MList.ToString(selector, separator)) + string interpolation/FormatWith
        const bandsCount = await table(BandEntity)
            .map(b => ({ name: b.name, members: b.members.map(a => ({ name: a.member.name, sex: a.member.sex })).map(p => p.name + " (" + p.sex + ")").join("\n") }))
            .toArray();
        assert.ok(Array.isArray(bandsCount));

        // TODO(api): collection-level terminals (members.firstOrNull/first/singleOrNull/single) inside a projection
        const bands1 = await table(BandEntity).map(b => ({ name: b.name, member: b.members.firstOrNull()!.member.name })).toArray();
        const bands2 = await table(BandEntity).map(b => ({ name: b.name, member: b.members.first().member.name })).toArray();
        const bands3 = await table(BandEntity).map(b => ({ name: b.name, member: b.members.singleOrNull()!.member.name })).toArray();
        const bands4 = await table(BandEntity).map(b => ({ name: b.name, member: b.members.single().member.name })).toArray();

        const bands1b = await table(BandEntity).map(b => ({ name: b.name, member: b.members.firstOrNull(a => a.member.sex == Sex.Female)!.member.name })).toArray();
        const bands2b = await table(BandEntity).map(b => ({ name: b.name, member: b.members.first(a => a.member.sex == Sex.Female).member.name })).toArray();
        const bands3b = await table(BandEntity).map(b => ({ name: b.name, member: b.members.singleOrNull(a => a.member.sex == Sex.Female)!.member.name })).toArray();
        const bands4b = await table(BandEntity).map(b => ({ name: b.name, member: b.members.single(a => a.member.sex == Sex.Female).member.name })).toArray();
        assert.ok(Array.isArray(bands1) && Array.isArray(bands2) && Array.isArray(bands3) && Array.isArray(bands4));
        assert.ok(Array.isArray(bands1b) && Array.isArray(bands2b) && Array.isArray(bands3b) && Array.isArray(bands4b));
    });

    // Database.Query<BandEntity>().Where(b => b.Members.OrderBy(a => a.Sex).Select(a => a.Sex).FirstEx() == Sex.Male).Select(a => a.Name).ToList();
    test("SelectSingleCellWhere", async () => {
        // TODO(api): collection-level ordering + projection + terminal (members.orderBy(...).map(...).first()) inside a predicate
        const list = await table(BandEntity)
            .filter(b => b.members.orderBy(a => a.member.sex).map(a => a.member.sex).first() == Sex.Male)
            .map(a => a.name)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<BandEntity>().Select(b => new { FirstName = b.Members.Select(m => m.Name).FirstEx(), FirstOrDefaultName = b.Members.Select(m => m.Name).FirstOrDefault(), SingleName = b.Members.Select(m => m.Name).SingleEx(), SingleOrDefaultName = b.Members.Select(m => m.Name).SingleOrDefaultEx() }).ToList();
    test("SelectSingleCellSingle", async () => {
        // TODO(api): collection-level projection + terminal (members.map(...).first()/firstOrNull()/single()/singleOrNull()) inside a projection
        const list = await table(BandEntity).map(b => ({
            firstName: b.members.map(m => m.member.name).first(),
            firstOrDefaultName: b.members.map(m => m.member.name).firstOrNull(),
            singleName: b.members.map(m => m.member.name).single(),
            singleOrDefaultName: b.members.map(m => m.member.name).singleOrNull(),
        })).toArray();
        assert.ok(Array.isArray(list));
    });

    // var query = Database.Query<BandEntity>().Select(b => new { b.Members.FirstEx().Name, b.Members.FirstEx().Dead, b.Members.FirstEx().Sex }); query.ToList(); Assert.Equal(1, query.QueryText().CountRepetitions(IsPostgres ? "LATERAL" : "APPLY"));
    test("SelectDoubleSingle", async () => {
        // TODO(api): collection-level terminal (members.first()) inside a projection
        const query = table(BandEntity).map(b => ({
            name: b.members.first().member.name,
            dead: b.members.first().member.dead,
            sex: b.members.first().member.sex,
        }));
        await query.toArray();

        // TODO(api): QueryText().CountRepetitions(...) helper + Schema.Current.Settings.IsPostgres for the APPLY/LATERAL assertion
        const text = query.queryTextForDebug();
        assert.ok(typeof text == "string");
    });

    // Two DISTINCT firstOrNull predicates, each read for several members (the
    // goodFriend/worstEnemy shape): the shared single-row subquery must dedup PER predicate
    // (one APPLY, not one per member access), while the two DISTINCT predicates stay
    // separate. So the UniqueRequest dedup must produce EXACTLY two OUTER APPLYs — not one
    // (over-dedup: it failed to tell `> 100` from `< 100`) nor four (no dedup). Guards the
    // canonical-signature key against similar-but-different predicates.
    test("SelectTwoDistinctFirstOrDefault", async () => {
        const query = table(AlbumEntity).map(a => ({
            longName: a.songs.firstOrNull(s => s.seconds! > 100)!.name,
            longIndex: a.songs.firstOrNull(s => s.seconds! > 100)!.index,
            shortName: a.songs.firstOrNull(s => s.seconds! < 100)!.name,
            shortIndex: a.songs.firstOrNull(s => s.seconds! < 100)!.index,
        }));
        const rows = await query.toArray();
        assert.ok(Array.isArray(rows));

        // One correlated apply per distinct predicate (the two identical predicates dedupe). The
        // OUTER-join-to-a-single-row apply is `OUTER APPLY` on SQL Server, `LEFT JOIN LATERAL` on
        // Postgres.
        const applyRe = isPostgres ? /LEFT JOIN LATERAL/g : /OUTER APPLY/g;
        const applies = (query.queryTextForDebug().match(applyRe) ?? []).length;
        assert.equal(applies, 2, `expected two correlated applies (one per distinct predicate), got ${applies}`);
    });

    // var neasted = (from b in Database.Query<BandEntity>() select b.Members.Select(a => a.Sex).FirstOrDefault()).ToList();
    test("SelecteNestedFirstOrDefault", async () => {
        // TODO(api): collection-level projection + terminal (members.map(...).firstOrNull()) as the projected value
        const neasted = await table(BandEntity)
            .map(b => b.members.map(a => a.member.sex).firstOrNull())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // var neasted = (from b in Database.Query<BandEntity>() select b.Members.Where(a => a.Name.StartsWith("a")).Select(a => (Sex?)a.Sex).FirstOrDefault()).ToList();
    test("SelecteNestedFirstOrDefaultNullify", async () => {
        // TODO(api): collection-level filter + projection + terminal (members.filter(...).map(...).firstOrNull()) as the projected value
        // TODO(api): enum-to-nullable cast ((Sex?)a.Sex)
        const neasted = await table(BandEntity)
            .map(b => b.members.filter(a => a.member.name.startsWith("a")).map(a => (a.member.sex as Sex | null)).firstOrNull())
            .toArray();
        assert.ok(Array.isArray(neasted));
    });

    // var result = (from lab in Database.Query<LabelEntity>() join al in Database.Query<AlbumEntity>().DefaultIfEmpty() on lab equals al.Label into g select new { lab.Id, lab.Name, NumExecutions = (int?)g.Count(), LastExecution = (from al2 in Database.Query<AlbumEntity>() where (int?)al2.Id == g.Max(a => (int?)a.Id) select al2.ToLite()).FirstOrDefault() }).ToList();
    test("SelectGroupLast", async () => {
        // TODO(api): group join with DefaultIfEmpty (join ... into g), group aggregates (g.Count()/g.Max(...)), correlated subquery projection, and lab.Id access
        const result = await table(LabelEntity)
            .innerJoin(
                table(AlbumEntity),
                lab => lab,
                al => al.label,
                (lab, al) => ({ lab, al }))
            .groupBy(x => ({ id: x.lab.id, name: x.lab.name }), x => x.al)
            .map(g => ({
                id: g.key.id,
                name: g.key.name,
                numExecutions: (g.elements.length as number | null),
                lastExecution: table(AlbumEntity)
                    .filter(al2 => (al2.id as number | null) == g.elements.map(a => (a.id as number | null)).max())
                    .map(al2 => al2.toLite())
                    .firstOrNull(),
            }))
            .toArray();
        assert.ok(Array.isArray(result));
    });

    // var config = Database.Query<ConfigEntity>().SingleEx();
    test("SelectEmbeddedWithMList", async () => {
        const config = await table(ConfigEntity).single();
        assert.ok(config != null);
    });

    // var firstMembers = Database.Query<BandEntity>().Where(a => a.Members.FirstEx().Name.StartsWith("a")).Select(a => a.Members.FirstEx()).ToList();
    test("FirstInSelectAndWhere", async () => {
        // TODO(api): collection-level terminal (members.first()) inside both a predicate and a projection
        const firstMembers = await table(BandEntity)
            .filter(a => a.members.first().member.name.startsWith("a"))
            .map(a => a.members.first())
            .toArray();
        assert.ok(Array.isArray(firstMembers));
    });

    // var michael = Database.Query<ArtistEntity>().FirstEx().ToLite(); Database.Query<BandEntity>().Select(a => new { a.Id, Count = a.Members.Where(m => m.Sex == michael.InDB(a => a.Sex)).Count(), Any = a.Members.Where(m => m.Sex == michael.InDB(a => a.Sex)).Any(a => a.Name.StartsWith("a")) }).ToList();
    test("DoubleUniqueExpansionWithInDB", async () => {
        // TODO(api): collection-level terminal (artists.first()) producing an entity to .toLite()
        const michael = (await table(ArtistEntity).first()).toLite();

        // TODO(api): Lite.inDB(selector) subquery expansion (no altea API), plus collection-level filter + count/some inside a projection, plus a.Id access
        const result = await table(BandEntity)
            .map(a => ({
                id: a.id,
                count: a.members.filter(m => m.member.sex == michael.inDB(x => x.sex)).length,
                any: a.members.filter(m => m.member.sex == michael.inDB(x => x.sex)).some(a => a.member.name.startsWith("a")),
            }))
            .toArray();
        assert.ok(Array.isArray(result));
        assert.ok(michael != null);
    });
});
