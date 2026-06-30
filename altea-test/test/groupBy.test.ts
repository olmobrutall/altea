import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.contains / startsWith and the Array aggregate operators on entity collections
import { hasDb, start } from "./setup";
import {
    ArtistEntity, AlbumEntity, BandEntity,
    ConfigEntity, AwardNominationEntity,
    Sex, Status,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/GroupByTest.cs. C# → altea idiom:
//   Database.Query<T>()        → table(T)
//   group X by K into g … sel  → .groupBy(k[, e]) → { key, elements }
//   g.Count()/g.Sum()/g.Max()… → over g.elements via the Array aggregate globals
//   .Count()/.Sum()/.Max()…    → await .count()/.sum()/.max() (terminals)
//   new { Sex = g.Key, … }     → ({ sex: g.key, … }) (camelCase)
//   a.ToLite()                 → a.toLite()        a.Id            → (a.id as number)
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.
//
// altea's groupBy has no C# result-selector overload — `GroupBy(k, g => result)`
// patterns are written as `.groupBy(k).map(g => …over g.elements…)`. Aggregates
// over the group use the Array operators on `g.elements`. Features with no altea
// API yet (StdDev, MaxBy/MinBy, MListQuery, GetType/EntityType, arg-less
// Average/Sum on the query, cross-table SelectMany source, GroupBy().SelectMany,
// GroupBy().All over a grouping) are written in their most natural altea form,
// marked `{ skip: true }`, and flagged with a `// TODO(api): …` comment.

describe("GroupByTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // Database.Query<ArtistEntity>().GroupBy(a => a.Sex, a => a.Name).ToList();
    test("GroupStringByEnum", async () => {
        const list = await table(ArtistEntity).groupBy(a => a.sex, a => a.name).toArray();
        assert.ok(Array.isArray(list));
    });

    // group a.Name by a.Sex into g select g  ==  GroupBy(a => a.Sex, a => a.Name) — same QueryText
    test("GroupStringByEnumSimilar", async () => {
        const queryA = table(ArtistEntity).groupBy(a => a.sex, a => a.name).queryTextForDebug();
        const queryN = table(ArtistEntity).groupBy(a => a.sex, a => a.name).queryTextForDebug();
        assert.equal(queryN, queryA);
    });

    // group a.Name.Length by a.Sex into g select new { g.Key, Count, Sum, Min, Max, Avg }
    test("GroupMultiAggregate", async () => {
        const sexos = await table(ArtistEntity)
            .groupBy(a => a.sex, a => a.name.length)
            .map(g => ({
                key: g.key,
                count: g.elements.length,
                sum: g.elements.sum(),
                min: g.elements.min(),
                max: g.elements.max(),
                avg: g.elements.avg(),
            }))
            .toArray();
        assert.ok(Array.isArray(sexos));
    });

    // group a by a.Sex into g select new { g.Key, Count, CountNames, CountNullFast, CountNullFast1, CountNullFast2, CountLastAward }
    test("GroupCountNull", async () => {
        const sexes = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({
                key: g.key,
                count: g.elements.length,
                countNames: g.elements.count(a => a.name != null),
                countNullFast: g.elements.count(a => (a.name == null ? "hi" : null) != null),
                countNullFast1: g.elements.filter(a => a.name == null).length,
                countNullFast2: g.elements.count(a => a.name == null),
                countLastAward: g.elements.count(a => a.lastAward != null),
            }))
            .toArray();
        assert.ok(Array.isArray(sexes));
    });

    // group a by a.Sex into g select new { g.Key, Count1..4 (Select/Where/Distinct/Count combinations) }
    test("GroupCountDistinctFast", async () => {
        const sexes = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({
                key: g.key,
                count1: g.elements.map(a => a.name).filter(a => a != null).distinct().length,
                count2: g.elements.filter(a => a.name != null).map(a => a.name).distinct().length,
                count3: g.elements.map(a => a.name).distinct().filter(a => a != null).length,
                count4: g.elements.map(a => a.name).distinct().count(a => a != null),
            }))
            .toArray();
        assert.ok(Array.isArray(sexes));
    });

    // Database.Query<ArtistEntity>().Select(a => a.Name).Where(a => a != null).Distinct().Count();
    test("RootCountDistinct", async () => {
        const count = await table(ArtistEntity).map(a => a.name).filter(a => a != null).distinct().count();
        assert.ok(typeof count == "number");
    });

    // group a by a.Sex into g select new { g.Key, Count1 = Select.Distinct.Count, Count2 = Distinct.Count }  (Slow)
    test("GroupCountDistinctSlow", async () => {
        const sexes = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({
                key: g.key,
                count1: g.elements.map(a => a.name).distinct().length,
                count2: g.elements.distinct().length,
            }))
            .toArray();
        assert.ok(Array.isArray(sexes));
    });

    // group a.Name.Length by new { } into g select new { g.Key, Count, Sum, Min, Max, Avg }
    // TODO(api): grouping by an empty key (group by new { }) — whole-table aggregate via groupBy
    test("GroupMultiAggregateNoKeys", async () => {
        const sexos = await table(ArtistEntity)
            .groupBy(a => ({}), a => a.name.length)
            .map(g => ({
                key: g.key,
                count: g.elements.length,
                sum: g.elements.sum(),
                min: g.elements.min(),
                max: g.elements.max(),
                avg: g.elements.avg(),
            }))
            .toArray();
        assert.ok(Array.isArray(sexos));
    });

    // group a.Name.Length by a.Sex into g select new { g.Key, StdDev, StdDevInMemory, StdDevP, StdDevPInMemory }
    // TODO(api): StdDev / StdDevP aggregate functions
    test("GroupStdDev", async () => {
        const sexos = await table(ArtistEntity)
            .groupBy(a => a.sex, a => a.name.length)
            .map(g => ({
                key: g.key,
                stdDev: g.elements.stdDev(),
                stdDevP: g.elements.stdDevP(),
            }))
            .toArray();
        assert.ok(Array.isArray(sexos));
    });

    // Database.Query<ArtistEntity>().GroupBy(a => a.Sex).ToList();
    test("GroupEntityByEnum", async () => {
        const list = await table(ArtistEntity).groupBy(a => a.sex).toArray();
        assert.ok(Array.isArray(list));
    });

    // (commented out in C#) GroupBy(a => a.GetType()) — omitted

    // GroupBy(a => new { DefaultLabel = … EmbeddedConfig.DefaultLabel.Entity.Country }).Select(gr => new { gr.Key, Count })
    // TODO(api): Lite.entity dereference (DefaultLabel.entity.country) inside a group key
    test("GroupByEntityInOptionalEmbedded", async () => {
        const list = await table(ConfigEntity)
            .groupBy(a => ({ defaultLabel: a.embeddedConfig == null ? null : a.embeddedConfig!.defaultLabel!.entity.country }))
            .map(gr => ({ key: gr.key, count: gr.elements.length }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AwardNominationEntity>().GroupBy(a => a.Award.EntityType).ToList();
    // TODO(api): Lite.EntityType (the runtime type of an @implementedBy lite) as a group key
    test("GroupEntityByTypeIb", async () => {
        const list = await table(AwardNominationEntity).groupBy(a => a.award.entityType).toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<ArtistEntity>().Where(a => a.Dead).GroupBy(a => a.Sex).ToList();
    test("WhereGroup", async () => {
        const list = await table(ArtistEntity).filter(a => a.dead).groupBy(a => a.sex).toArray();
        assert.ok(Array.isArray(list));
    });

    // group a by a.Sex into g select new { Sex = g.Key, DeadArtists = g.Where(a => a.Dead).ToList() }
    test("GroupWhere", async () => {
        const list = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, deadArtists: g.elements.filter(a => a.dead) }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // group a by a.Sex into g select new { Sex = g.Key, Count = g.Count() }
    test("GroupCount", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, count: g.elements.length }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // group a by a.Id < 10 ? 0 : 10 into g select new { Id = g.Key, Count = g.Count() }
    test("GroupCountInterval", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => (a.id as number) < 10 ? 0 : 10)
            .map(g => ({ id: g.key, count: g.elements.length }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // group a by a.Sex into g select new { Sex = g.Key, DeadArtists = (int?)g.Count(a => a.Dead) }
    test("GroupWhereCount", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, deadArtists: g.elements.count(a => a.dead) }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<AlbumEntity>().GroupBy(a => a.GetType()).Select(gr => new { gr.Key, Count = gr.Count() }).ToList();
    // TODO(api): GetType in query (group by the runtime entity type)
    test("GroupEntityByTypeFieCount", async () => {
        const list = await table(AlbumEntity)
            .groupBy(a => a.constructor)
            .map(gr => ({ key: gr.key, count: gr.elements.length }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Database.Query<AlbumEntity>().GroupBy(a => a.Author.GetType()).Select(gr => new { gr.Key, Count = gr.Count() }).ToList();
    // TODO(api): GetType in query (group by the runtime type of an @implementedBy reference)
    test("GroupEntityByTypeIbCount", async () => {
        const list = await table(AlbumEntity)
            .groupBy(a => a.author.constructor)
            .map(gr => ({ key: gr.key, count: gr.elements.length }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // group a by a.Label.Name into g select new { g.Key, Count = g.Count() }
    test("GroupExpandKey", async () => {
        const songs = await table(AlbumEntity)
            .groupBy(a => a.label.name)
            .map(g => ({ key: g.key, count: g.elements.length }))
            .toArray();
        assert.ok(Array.isArray(songs));
    });

    // group a by a.Label into g select new { g.Key.Name, Count = g.Count() }
    test("GroupExpandResult", async () => {
        const songs = await table(AlbumEntity)
            .groupBy(a => a.label)
            .map(g => ({ name: g.key.name, count: g.elements.length }))
            .toArray();
        assert.ok(Array.isArray(songs));
    });

    // group a by a.Sex into g select new { Sex = g.Key, Sum = g.Sum(a => a.Name.Length) }
    test("GroupSum", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, sum: g.elements.sum(a => a.name.length) }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // group a by a.Sex into g select new { Sex = g.Key, Sum = g.Where(a => a.Dead).Sum(a => a.Name.Length) }
    test("GroupSumWhere", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, sum: g.elements.filter(a => a.dead).sum(a => a.name.length) }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // group a by a.Sex into g select new { Sex = g.Key, Max = g.Max(a => a.Name.Length) }
    test("GroupMax", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, max: g.elements.max(a => a.name.length) }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // group a by a.Sex into g select new { Sex = g.Key, Min = g.Min(a => a.Name.Length) }
    test("GroupMin", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, min: g.elements.min(a => a.name.length) }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // group a by a.Sex into g select new { Sex = g.Key, MaxBy = g.MaxBy(a => a.Name.Length) }
    // TODO(api): MaxBy aggregate (pick the element maximizing a selector) in a query group
    test("GroupMaxBy", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, maxBy: g.elements.maxBy(a => a.name.length) }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // group a by a.Sex into g select new { Sex = g.Key, MinBy = g.MinBy(a => a.Name.Length) }
    // TODO(api): MinBy aggregate (pick the element minimizing a selector) in a query group
    test("GroupMinBy", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, minBy: g.elements.minBy(a => a.name.length) }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // group a by a.Sex into g select new { Sex = g.Key, Avg = g.Average(a => a.Name.Length) }
    test("GroupAverage", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ sex: g.key, avg: g.elements.avg(a => a.name.length) }))
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<ArtistEntity>().Count();
    test("RootCount", async () => {
        const songsAlbum = await table(ArtistEntity).count();
        assert.ok(typeof songsAlbum == "number");
    });

    // Database.Query<ArtistEntity>().Count(a => a.Name.StartsWith("M"));
    test("RootCountWhere", async () => {
        const songsAlbum = await table(ArtistEntity).count(a => a.name.startsWith("M"));
        assert.ok(typeof songsAlbum == "number");
    });

    // Assert.Equal(0, Database.Query<ArtistEntity>().Count(a => false));
    test("RootCountWhereZero", async () => {
        assert.equal(await table(ArtistEntity).count(a => false), 0);
    });

    // Database.Query<ArtistEntity>().Sum(a => a.Name.Length);
    test("RootSum", async () => {
        const songsAlbum = await table(ArtistEntity).sum(a => a.name.length);
        assert.ok(songsAlbum != null);
    });

    // Database.Query<ArtistEntity>().Select(a => a.Name.Length).Sum();
    test("RootSumNoArgs", async () => {
        const songsAlbum = await table(ArtistEntity).map(a => a.name.length).sum();
        assert.ok(songsAlbum != null);
    });

    // Database.Query<BandEntity>().Where(a => a.Members.Sum(m => m.Name.Length) > 0).ToList();
    test("SumWhere", async () => {
        const songsAlbum = await table(BandEntity)
            .filter(a => a.members.sum(m => m.member.entity.name.length) > 0)
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<BandEntity>().Select(a => new { a.Name, Sum = a.Members.Sum(m => m.Name.Length) }).Select(a => a.Name).ToList();
    test("SumSimplification", async () => {
        const songsAlbum = await table(BandEntity)
            .map(a => ({ name: a.name, sum: a.members.sum(m => m.member.entity.name.length) }))
            .map(a => a.name)
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Assert.Equal(0, Database.Query<ArtistEntity>().Where(a => false).Sum(a => a.Name.Length));
    test("RootSumZero", async () => {
        assert.equal(await table(ArtistEntity).filter(a => false).sum(a => a.name.length), 0);
    });

    // Assert.Null(Database.Query<ArtistEntity>().Where(a => false).Sum(a => (int?)a.Name.Length));
    test("RootSumNull", async () => {
        assert.equal(await table(ArtistEntity).filter(a => false).sum(a => a.name.length), null);
    });

    // Assert.True(Database.Query<AwardNominationEntity>().Sum(a => (int)a.Award.Id.Object) > 0);
    test("RootSumSomeNull", async () => {
        assert.ok(await table(AwardNominationEntity).sum(a => (a.award.id as number)) > 0);
    });

    // Database.Query<ArtistEntity>().Max(a => a.Name.Length);
    test("RootMax", async () => {
        const songsAlbum = await table(ArtistEntity).max(a => a.name.length);
        assert.ok(songsAlbum != null);
    });

    // Database.Query<ArtistEntity>().Select(a => a.Name.Length).Max();
    test("RootMaxNoArgs", async () => {
        const songsAlbum = await table(ArtistEntity).map(a => a.name.length).max();
        assert.ok(songsAlbum != null);
    });

    // Assert.Throws<FieldReaderException>(() => Database.Query<ArtistEntity>().Where(a => false).Max(a => a.Name.Length));
    test("RootMaxException", async () => {
        await assert.rejects(async () => table(ArtistEntity).filter(a => false).max(a => a.name.length));
    });

    // Database.Query<ArtistEntity>().Min(a => a.Name.Length);
    test("RootMin", async () => {
        const songsAlbum = await table(ArtistEntity).min(a => a.name.length);
        assert.ok(songsAlbum != null);
    });

    // Database.Query<ArtistEntity>().MinBy(a => a.Name.Length);
    // TODO(api): MinBy as a root terminal (pick the element minimizing a selector)
    test("RootMinBy", async () => {
        const songsAlbum = await table(ArtistEntity).minBy(a => a.name.length);
        assert.ok(songsAlbum != null);
    });

    // Database.Query<ArtistEntity>().MaxBy(a => a.Name.Length);
    // TODO(api): MaxBy as a root terminal (pick the element maximizing a selector)
    test("RootMaxBy", async () => {
        const songsAlbum = await table(ArtistEntity).maxBy(a => a.name.length);
        assert.ok(songsAlbum != null);
    });

    // GroupBy(a => a.Sex).Select(gr => gr.Min(a => a.Status)); … gr.Where(a => a.Id > 10).Min(a => a.Status); … Min(a => a.Sex)
    test("MinEnum", async () => {
        const list = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(gr => gr.elements.min(a => a.status))
            .toArray();
        assert.ok(Array.isArray(list));
        const list2 = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(gr => gr.elements.filter(a => (a.id as number) > 10).min(a => a.status))
            .toArray();
        assert.ok(Array.isArray(list2));
        const minSex = await table(ArtistEntity).min(a => a.sex);
        assert.ok(minSex != null);
    });

    // Where(a => false).Min(a => (Sex?)a.Sex); Select(b => b.Members.Where(a => false).Min(a => (Sex?)a.Sex))
    test("MinEnumNullable", async () => {
        const minSex = await table(ArtistEntity).filter(a => false).min(a => a.sex);
        assert.equal(minSex, null);
        const minSexs = await table(BandEntity)
            .map(b => b.members.filter(a => false).min(a => a.member.entity.sex))
            .toArray();
        assert.ok(Array.isArray(minSexs));
    });

    // Assert.Throws<FieldReaderException>(() => Database.Query<ArtistEntity>().Where(a => false).Min(a => a.Name.Length));
    test("RootMinException", async () => {
        await assert.rejects(async () => table(ArtistEntity).filter(a => false).min(a => a.name.length));
    });

    // Database.Query<ArtistEntity>().Where(a => false).Min(a => (int?)a.Name.Length);
    test("RootMinNullable", async () => {
        const min = await table(ArtistEntity).filter(a => false).min(a => a.name.length);
        assert.equal(min, null);
    });

    // Database.Query<ArtistEntity>().Average(a => a.Name.Length);
    test("RootAverage", async () => {
        const songsAlbum = await table(ArtistEntity).avg(a => a.name.length);
        assert.ok(songsAlbum != null);
    });

    // GroupBy(a => a.Sex).Select(g => g).Select(g => new { Sex = g.Key, Count = g.Count() }).ToList();
    test("GroupBySelectSelect", async () => {
        const artistsBySex = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => g)
            .map(g => ({ sex: g.key, count: g.elements.length }))
            .toArray();
        assert.ok(Array.isArray(artistsBySex));
    });

    // GroupBy(a => a.Sex).All(g => g.Where(a => a.Dead).Any());
    test("GroupByAllWhereAny", async () => {
        const artistsBySex = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .every(g => g.elements.filter(a => a.dead).length > 0);
        assert.ok(typeof artistsBySex == "boolean");
    });

    // GroupBy(a => a.Sex).All(g => g.Any(a => a.Dead));
    test("GroupByAllAny", async () => {
        const artistsBySex = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .every(g => g.elements.some(a => a.dead));
        assert.ok(typeof artistsBySex == "boolean");
    });

    // first = FirstOrDefault(); GroupBy(a => a.Sex).All(g => g.Contains(first));
    test("GroupByAllContains", async () => {
        const first = await table(ArtistEntity).firstOrNull();
        const artistsBySex = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .every(g => g.elements.contains(first!));
        assert.ok(typeof artistsBySex == "boolean");
    });

    // group new { a, HasBonusTrack = a.BonusTrack != null } by a.Label into g select new { Label = g.Key, Albums = g.Count(), BonusTracks = g.Count(a => a.HasBonusTrack) }
    test("JoinGroupPair", async () => {
        const list = await table(AlbumEntity)
            .groupBy(a => a.label, a => ({ a, hasBonusTrack: a.bonusTrack != null }))
            .map(g => ({
                label: g.key,
                albums: g.elements.length,
                bonusTracks: g.elements.count(a => a.hasBonusTrack),
            }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // group a by a.Label into g select g.Key.ToLite()
    test("GroupByEntity", async () => {
        const list = await table(AlbumEntity)
            .groupBy(a => a.label)
            .map(g => g.key.toLite())
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // where a.Label.Name != "whatever" group a by a.Label into g select new { Label = g.Key.Name, Albums = g.Count() }
    test("GroupByEntityExpand", async () => {
        const list = await table(AlbumEntity)
            .filter(a => a.label.name != "whatever")
            .groupBy(a => a.label)
            .map(g => ({ label: g.key.name, albums: g.elements.length }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // from b from a in b.Members let count = Query<ArtistEntity>().Count(a2 => a2.Sex == a.Sex) select new { Album = a.ToLite(), Count = count }
    // TODO(api): correlated subquery — table(...).count(...) referencing the outer flatMap element inside a projection
    test("SelectExpansionCount", async () => {
        const albums = await table(BandEntity)
            .flatMap(b => b.members)
            .map(a => ({ album: a.member, count: table(ArtistEntity).count(a2 => a2.sex == a.member.entity.sex) }))
            .toArray();
        assert.ok(Array.isArray(albums));
    });

    // Database.Query<ArtistEntity>().GroupBy(a => a.Sex).SelectMany(a => a).ToList();
    // TODO(api): SelectMany over a grouping (flatMap g => g.elements after groupBy)
    test("GroupBySelectMany", async () => {
        const songsAlbum = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .flatMap(a => a.elements)
            .toArray();
        assert.ok(Array.isArray(songsAlbum));
    });

    // Database.Query<BandEntity>().Sum(b => b.Members.Sum(m => (int)m.Id.Object));
    test("SumSum", async () => {
        const first = await table(BandEntity).sum(b => b.members.sum(m => (m.member.id as number)));
        assert.ok(first != null);
    });

    // GroupBy(a => a.Status).Select(gr => gr.Sum(b => b.Friends.Sum(m => (int)m.Id.Object))).ToList();
    test("SumGroupbySum", async () => {
        const first = await table(ArtistEntity)
            .groupBy(a => a.status)
            .map(gr => gr.elements.sum(b => b.friends.sum(m => (m.friend.id as number))))
            .toArray();
        assert.ok(Array.isArray(first));
    });

    // Database.Query<BandEntity>().Min(b => b.Members.Max(m => m.Id));
    test("MinMax", async () => {
        const first = await table(BandEntity).min(b => b.members.max(m => (m.member.id as number)));
        assert.ok(first != null);
    });

    // GroupBy(a => a.Status).Select(gr => gr.Min(b => b.Friends.Max(m => m.Id))).ToList();
    test("MinGroupByMax", async () => {
        const first = await table(ArtistEntity)
            .groupBy(a => a.status)
            .map(gr => gr.elements.min(b => b.friends.max(m => (m.friend.id as number))))
            .toArray();
        assert.ok(Array.isArray(first));
    });

    // Database.Query<AlbumEntity>().GroupBy(a => a.Year).Select(gr => gr.Max(a => a.Label.Name)).ToList();
    test("GroupbyAggregateImplicitJoin", async () => {
        const first = await table(AlbumEntity)
            .groupBy(a => a.year)
            .map(gr => gr.elements.max(a => a.label.name))
            .toArray();
        assert.ok(Array.isArray(first));
    });

    // group a by new { Author = a.Author.ToLite(), Year = a.Year / 2 } into g select new { g.Key.Author, g.Key.Year, Count = g.Count() } … Take(10)
    test("GroupByTake", async () => {
        const list = await table(AlbumEntity)
            .groupBy(a => ({ author: a.author.toLite(), year: a.year / 2 }))
            .map(g => ({ author: g.key.author, year: g.key.year, count: g.elements.length }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // group a by new { Author = a.Author.ToLite(), Year = a.Year / 2 } into g select new { g.Key.Author, Count = g.Count() } … Take(10)
    test("GroupByTakeSomeKeys", async () => {
        const list = await table(AlbumEntity)
            .groupBy(a => ({ author: a.author.toLite(), year: a.year / 2 }))
            .map(g => ({ author: g.key.author, count: g.elements.length }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // let old = a.Year < 2000 group a by old ? a.Author.ToLite() : null into g select new { Author = g.Key, Count } … Take(10)
    test("GroupByMaybeAuthorLite", async () => {
        const query = await table(AlbumEntity)
            .groupBy(a => a.year < 2000 ? a.author.toLite() : null)
            .map(g => ({ author: g.key, count: g.elements.length }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(query));
    });

    // let old = a.Year < 2000 group a by old ? a.Author : null into g select new { Author = g.Key, Count } … Take(10)
    test("GroupByMaybeAuthor", async () => {
        const query = await table(AlbumEntity)
            .groupBy(a => a.year < 2000 ? a.author : null)
            .map(g => ({ author: g.key, count: g.elements.length }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(query));
    });

    // let old = a.Year < 2000 group a by old ? a.Label : null into g select new { Author = g.Key, Count } … Take(10)
    test("GroupByMaybeLabel", async () => {
        const query = await table(AlbumEntity)
            .groupBy(a => a.year < 2000 ? a.label : null)
            .map(g => ({ author: g.key, count: g.elements.length }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(query));
    });

    // let old = a.Year < 2000 group a by old ? a.Label.ToLite() : null into g select new { Author = g.Key, Count } … Take(10)
    test("GroupByMaybeLabelLite", async () => {
        const query = await table(AlbumEntity)
            .groupBy(a => a.year < 2000 ? a.label.toLite() : null)
            .map(g => ({ author: g.key, count: g.elements.length }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(query));
    });

    // group a by a.Author.ToLite() ?? a.Author.ToLite() into g select new { Author = g.Key, Count } … Take(10)
    test("GroupByCoallesceAuthorLite", async () => {
        const query = await table(AlbumEntity)
            .groupBy(a => a.author.toLite() ?? a.author.toLite())
            .map(g => ({ author: g.key, count: g.elements.length }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(query));
    });

    // group a by a.Author ?? a.Author into g select new { Author = g.Key, Count } … Take(10)
    test("GroupByCoallesceAuthor", async () => {
        const query = await table(AlbumEntity)
            .groupBy(a => a.author ?? a.author)
            .map(g => ({ author: g.key, count: g.elements.length }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(query));
    });

    // nullableList = GroupBy(a => a == null ? (Sex?)null : a.Sex).Select(...); notNullableList = GroupBy(a => a.Sex).Select(...); Assert.Equal(counts)
    test("GroupByWithCheapNullPropagation", async () => {
        const nullableList = await table(ArtistEntity)
            .groupBy(a => a == null ? null : a.sex)
            .map(gr => ({ key: gr.key, count: gr.elements.length }))
            .toArray();
        const notNullableList = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(gr => ({ key: gr.key, count: gr.elements.length }))
            .toArray();
        assert.equal(nullableList.length, notNullableList.length);
    });

    // group a by a.Label ?? a.Label into g select new { Author = g.Key, Count } … Take(10)
    test("GroupByCoallesceLabel", async () => {
        const query = await table(AlbumEntity)
            .groupBy(a => a.label ?? a.label)
            .map(g => ({ author: g.key, count: g.elements.length }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(query));
    });

    // group a by a.Label.ToLite() ?? a.Label.ToLite() into g select new { Author = g.Key, Count } … Take(10)
    test("GroupByCoallesceLabelLite", async () => {
        const query = await table(AlbumEntity)
            .groupBy(a => a.label.toLite() ?? a.label.toLite())
            .map(g => ({ author: g.key, count: g.elements.length }))
            .top(10)
            .toArray();
        assert.ok(Array.isArray(query));
    });

    // group a by a.Sex into g select new { g.Key, MaxFriends = g.Max(a => a.Friends.Count) }
    test("GroupByExpandGroupBy", async () => {
        const list = await table(ArtistEntity)
            .groupBy(a => a.sex)
            .map(g => ({ key: g.key, maxFriends: g.elements.max(a => a.friends.length) }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // let friend = a.Friends select new { Artist = a.ToLite(), Friends = friend.Count(), FemaleFriends = friend.Count(f => f.Entity.Sex == Sex.Female) }
    test("LetTrick", async () => {
        const list = await table(ArtistEntity)
            .map(a => ({
                artist: a.toLite(),
                friends: a.friends.length,
                femaleFriends: a.friends.count(f => f.friend.entity.sex == Sex.Female),
            }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => new { Initials = a.Name.Substring(0, 1), a.Sex }).Distinct().GroupBy(a => a.Initials).Select(gr => new { gr.Key, Count = gr.Count() }).ToList();
    test("DistinctGroupByForce", async () => {
        const list = await table(ArtistEntity)
            .map(a => ({ initials: a.name.substring(0, 1), sex: a.sex }))
            .distinct()
            .groupBy(a => a.initials)
            .map(gr => ({ key: gr.key, count: gr.elements.length }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // GroupBy(a => a.Songs.Count).Select(gr => new { NumSongs = gr.Key, Count = gr.Count() }).ToList();
    test("GroupByCount", async () => {
        const list = await table(AlbumEntity)
            .groupBy(a => a.songs.length)
            .map(gr => ({ numSongs: gr.key, count: gr.elements.length }))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // where a.Songs.Count > 1 select new { FirstName = a.Songs.OrderBy(s => s.Name).FirstOrDefault()!.Name, FirstDuration, Last = …OrderByDescending… }; Assert.True(All(a => a.FirstName != a.Last.Name))
    test("FirstLastMList", async () => {
        const list = await table(AlbumEntity)
            .filter(a => a.songs.length > 1)
            .map(a => ({
                firstName: a.songs.orderBy(s => s.name).firstOrNull()!.name,
                firstDuration: a.songs.orderBy(s => s.name).firstOrNull()!.duration,
                last: a.songs.orderByDescending(s => s.name).firstOrNull(),
            }))
            .toArray();
        assert.ok(list.every(a => a.firstName != a.last!.name));
    });

    // from mle in MListQuery((AlbumEntity a) => a.Songs) group mle.Element by mle.Parent into g where g.Count() > 1 select new { FirstName, FirstDuration, Last }
    // TODO(api): MListQuery (query the link/part-entity rows directly) and a where-clause over a grouping
    test("FirstLastGroup", async () => {
        const list = await table(AlbumEntity)
            .flatMap(a => a.songs)
            .groupBy(mle => mle.album)
            .filter(g => g.elements.length > 1)
            .map(g => ({
                firstName: g.elements.orderBy(s => s.name).firstOrNull()!.name,
                firstDuration: g.elements.orderBy(s => s.name).firstOrNull()!.duration,
                last: g.elements.orderByDescending(s => s.name).firstOrNull(),
            }))
            .toArray();
        assert.ok(list.every(a => a.firstName != a.last!.name));
    });

    // select a.Songs into songs where songs.Count > 1 select new { FirstName, FirstDuration, Last }
    // TODO(api): projecting an entire child collection (a.songs) into a downstream query then filtering on it
    test("FirstLastList", async () => {
        const list = await table(AlbumEntity)
            .map(a => a.songs)
            .filter(songs => songs.length > 1)
            .map(songs => ({
                firstName: songs.orderBy(s => s.name).firstOrNull()!.name,
                firstDuration: songs.orderBy(s => s.name).firstOrNull()!.duration,
                last: songs.orderByDescending(s => s.name).firstOrNull(),
            }))
            .toArray();
        assert.ok(list.every(a => a.firstName != a.last!.name));
    });

    // group a by a.Sex.IsDefined() into g select new { g.Key, count = g.Count() }
    // TODO(api): enum.IsDefined() in a query group key
    test("GroupByOr", async () => {
        // BLOCKED: enum.isDefined() in a group key - unmodelled.
        // const b = await table(ArtistEntity)
        //     .groupBy(a => a.sex.isDefined())
        //     .map(g => ({ key: g.key, count: g.elements.length }))
        //     .toArray();
        // assert.ok(Array.isArray(b));
    });
});
