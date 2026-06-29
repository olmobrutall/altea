import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.contains / startsWith / endsWith / … (SQL-mappable)
import { hasDb, start } from "./setup";
import {
    ArtistEntity, AlbumEntity, BandEntity, LabelEntity,
    NoteWithDateEntity, Sex, Status,
} from "../entities/music";

// Port of Signum.Test/LinqProvider/SqlFunctionsTest.cs. C# → altea idiom:
//   Database.Query<T>()  → table(T)            .Where(...) → .filter(...)
//   .Select(...)         → .map(...)           .ToList()/.ToArray() → await .toArray()
//   .Any(pred)           → await .some(pred)   .Count(pred) → await .count(pred)
//   .FirstEx()           → await .first()      .GroupBy(k)  → .groupBy(k)
//   a.ToLite()           → a.toLite()          new { X = .. } → { x: .. } (camelCase)
// C# string functions map to JS where a globals.ts/JS method exists
// (.Length→.length, .ToLower()→.toLowerCase(), .Contains→.contains,
//  .StartsWith→.startsWith, .EndsWith→.endsWith, .IndexOf→.indexOf,
//  .Substring→.substring, .TrimStart→.trimStart, .TrimEnd→.trimEnd).
// SQL-only functions with no JS/altea equivalent (Like, InSql, Start/End/Reverse/
// Replicate, DateTime parts/diffs, Math.*, MListQuery, TableValuedFunction,
// SqlHierarchyId, polymorphic Combine, enum/entity ToString in query, etc.) are
// written in their most natural altea form, marked `{ skip: true }`, and flagged
// with a `// TODO(api): …` comment.
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.

describe("SqlFunctionsTest", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    // StringFunctions: IndexOf/Contains/StartsWith/EndsWith/Like + Length/ToLower/ToUpper/Trim*/Substring + Start/End/Reverse/Replicate.InSql
    // TODO(api): Like (SQL LIKE pattern), InSql() hint, and Start/End/Reverse/Replicate SQL string functions
    test("StringFunctions", { skip: true }, async () => {
        const artists = table(ArtistEntity);
        assert.ok(await artists.some(a => a.name.indexOf("M") == 0));
        assert.ok(await artists.some(a => a.name.indexOf("Mi") == 0));
        assert.ok(await artists.some(a => a.name.contains("Jackson")));
        assert.ok(await artists.some(a => a.name.startsWith("Billy")));
        assert.ok(await artists.some(a => a.name.endsWith("Corgan")));
        // assert.ok(await artists.some(a => a.name.like("%Michael%")));        // TODO(api): Like
        assert.equal(await artists.count(a => a.name.endsWith("Orri Páll Dýrason")), 1);
        assert.equal(await artists.count(a => a.name.startsWith("Orri Páll Dýrason")), 1);

        await table(ArtistEntity).map(a => a.name.length).toArray();
        await table(ArtistEntity).map(a => a.name.toLowerCase()).toArray();
        await table(ArtistEntity).map(a => a.name.toUpperCase()).toArray();
        await table(ArtistEntity).map(a => a.name.trimStart()).toArray();
        await table(ArtistEntity).map(a => a.name.trimEnd()).toArray();
        await table(ArtistEntity).map(a => a.name.substring(2)).toArray();        // .InSql()
        await table(ArtistEntity).map(a => a.name.substring(2, 2 + 2)).toArray(); // .InSql()
        // await table(ArtistEntity).map(a => a.name.start(2)).toArray();         // TODO(api): Start
        // await table(ArtistEntity).map(a => a.name.end(2)).toArray();           // TODO(api): End
        // await table(ArtistEntity).map(a => a.name.reverse()).toArray();        // TODO(api): Reverse
        // await table(ArtistEntity).map(a => a.name.replicate(2)).toArray();     // TODO(api): Replicate
    });

    // Assert.True(Query<AlbumEntity>().Any(a => a.Author.CombineUnion().Name.Contains("Jackson")))
    // TODO(api): polymorphic expression Combine (CombineUnion) over an @implementedBy reference
    test("StringFunctionsPolymorphicUnion", { skip: true }, async () => {
        // assert.ok(await table(AlbumEntity).some(a => a.author.combineUnion().name.contains("Jackson")));
    });

    // Assert.True(Query<AlbumEntity>().Any(a => a.Author.CombineCase().Name.Contains("Jackson")))
    // TODO(api): polymorphic expression Combine (CombineCase) over an @implementedBy reference
    test("StringFunctionsPolymorphicSwitch", { skip: true }, async () => {
        // assert.ok(await table(AlbumEntity).some(a => a.author.combineCase().name.contains("Jackson")));
    });

    // Select(b => b.Members.FirstOrDefault(a => a.Sex == Sex.Female) ?? b.Members.FirstOrDefault(a => a.Sex == Sex.Male)!).Select(a => a.ToLite())
    // TODO(api): per-row firstOrNull over a part-entity collection (b.members) inside a projection, with coalesce of entities
    test("CoalesceFirstOrDefault", { skip: true }, async () => {
        // const list = await table(BandEntity)
        //     .map(b => b.members.firstOrNull(a => a.member.entity.sex == Sex.Female)
        //         ?? b.members.firstOrNull(a => a.member.entity.sex == Sex.Male)!)
        //     .map(a => a.toLite())
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => !a.Author.CombineUnion().ToString()!.Contains("Hola"))
    // TODO(api): polymorphic expression Combine (CombineUnion) and entity ToString in query
    test("StringContainsUnion", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => !a.author.combineUnion().toString().contains("Hola"))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => !a.Author.CombineCase().ToString()!.Contains("Hola"))
    // TODO(api): polymorphic expression Combine (CombineCase) and entity ToString in query
    test("StringContainsSwitch", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => !a.author.combineCase().toString().contains("Hola"))
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Where(a => a.CreationDate == DateTime.Today.ToDateOnly())
    // TODO(api): DateTime.Today / today-as-date constant compared against a PlainDate column
    test("DateParameters", { skip: true }, async () => {
        // const list = await table(NoteWithDateEntity)
        //     .filter(a => a.creationDate == Temporal.Now.plainDateISO())
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Dump CreationTime.Year/Quarter/Month/Day/DayOfYear/Hour/Minute/Second/Millisecond + CreationDate.Year/Quarter/Month/Day/DayOfYear
    // TODO(api): DateTime/Date part extraction in query (year/quarter/month/day/dayOfYear/hour/minute/second/millisecond)
    test("DateTimeFunctions", { skip: true }, async () => {
        // await table(NoteWithDateEntity).map(n => n.creationTime.year).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.quarter()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.month).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.day).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.dayOfYear).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.hour).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.minute).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.second).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.millisecond).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.year).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.quarter()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.month).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.day).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.dayOfYear).toArray();
    });

    // Dump CreationTime.YearStart/QuarterStart/MonthStart/WeekStart/Date/TruncHours/TruncMinutes/TruncSeconds + CreationDate.*Start
    // TODO(api): DateTime/Date truncation in query (yearStart/quarterStart/monthStart/weekStart/date/truncHours/truncMinutes/truncSeconds)
    test("DateTimeFunctionsStart", { skip: true }, async () => {
        // await table(NoteWithDateEntity).map(n => n.creationTime.yearStart()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.quarterStart()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.monthStart()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.weekStart()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.date).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.truncHours()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.truncMinutes()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.truncSeconds()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.yearStart()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.quarterStart()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.monthStart()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.weekStart()).toArray();
    });

    // Dump CreationTime.ToDateOnly() / DateOnly.FromDateTime(CreationTime) + CreationDate.ToDateTime() / ToDateTime(TimeOnly.MaxValue)
    // TODO(api): DateTime↔Date conversion in query (toDateOnly / fromDateTime / toDateTime)
    test("DateTimeFunctionsConvert", { skip: true }, async () => {
        // await table(NoteWithDateEntity).map(n => n.creationTime.toPlainDate()).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.toPlainDateTime()).toArray();
    });

    // mem vs db Count of Where(a => a.CreationTime.DayOfWeek == a.CreationTime.DayOfWeek) and CreationDate.DayOfWeek
    // TODO(api): DayOfWeek extraction in query
    test("DayOfWeekWhere", { skip: true }, async () => {
        // const memCount = (await table(NoteWithDateEntity).toArray())
        //     .filter(a => a.creationTime.dayOfWeek == a.creationTime.dayOfWeek).length;
        // const dbCount = await table(NoteWithDateEntity)
        //     .count(a => a.creationTime.dayOfWeek == a.creationTime.dayOfWeek);
        // assert.equal(memCount, dbCount);
    });

    // mem vs db Count of Where(a => a.CreationTime.DayOfWeek == DayOfWeek.Sunday) and CreationDate.DayOfWeek
    // TODO(api): DayOfWeek extraction in query and a DayOfWeek enum constant
    test("DayOfWeekWhereConstant", { skip: true }, async () => {
        // const memCount = (await table(NoteWithDateEntity).toArray())
        //     .filter(a => a.creationTime.dayOfWeek == DayOfWeek.Sunday).length;
        // const dbCount = await table(NoteWithDateEntity)
        //     .count(a => a.creationTime.dayOfWeek == DayOfWeek.Sunday);
        // assert.equal(memCount, dbCount);
    });

    // Select(a => (DayOfWeek?)Query<NoteWithDateEntity>().Where(n => n.Target.Is(a)).FirstOrDefault()!.CreationTime.DayOfWeek); Assert.Contains(null, list)
    // TODO(api): DayOfWeek extraction in query and a correlated subquery (firstOrNull over a filtered table) inside a projection
    test("DayOfWeekSelectNullable", { skip: true }, async () => {
        // const list = await table(ArtistEntity)
        //     .map(a => table(NoteWithDateEntity).filter(n => n.target.is(a)).firstOrNull()!.creationTime.dayOfWeek)
        //     .toArray();
        // assert.ok(list.contains(null));
    });

    // mem vs db Select(a => a.CreationTime.DayOfWeek == DayOfWeek.Sunday) and CreationDate.DayOfWeek
    // TODO(api): DayOfWeek extraction in query and a DayOfWeek enum constant
    test("DayOfWeekSelectConstant", { skip: true }, async () => {
        // const memCount = (await table(NoteWithDateEntity).toArray())
        //     .map(a => a.creationTime.dayOfWeek == DayOfWeek.Sunday);
        // const dbCount = await table(NoteWithDateEntity)
        //     .map(a => a.creationTime.dayOfWeek == DayOfWeek.Sunday).toArray();
        // assert.deepEqual(memCount, dbCount);
    });

    // dows = new[]{ Monday, Sunday }; mem vs db Count of Where(a => dows.Contains(a.CreationTime.DayOfWeek)) and CreationDate.DayOfWeek
    // TODO(api): DayOfWeek extraction in query and an in-clause (array.contains(value)) over DayOfWeek
    test("DayOfWeekContains", { skip: true }, async () => {
        // const dows = [DayOfWeek.Monday, DayOfWeek.Sunday];
        // const memCount = (await table(NoteWithDateEntity).toArray())
        //     .filter(a => dows.contains(a.creationTime.dayOfWeek)).length;
        // const dbCount = await table(NoteWithDateEntity)
        //     .count(a => dows.contains(a.creationTime.dayOfWeek));
        // assert.equal(memCount, dbCount);
    });

    // Where(a => a.ReleaseDate.HasValue).GroupBy(a => (DayOfWeek?)a.ReleaseDate!.Value.DayOfWeek).OrderBy(a => a.Key).Select(gr => new { gr.Key, Count = gr.Count() })
    // TODO(api): DayOfWeek extraction in query and groupBy over a nullable DayOfWeek key
    test("DayOfWeekGroupByNullable", { skip: true }, async () => {
        // const listy0 = await table(NoteWithDateEntity)
        //     .filter(a => a.releaseDate != null)
        //     .groupBy(a => a.releaseDate!.dayOfWeek)
        //     .orderBy(a => a.key)
        //     .map(gr => ({ key: gr.key, count: gr.elements.length }))
        //     .toArray();
        // assert.ok(Array.isArray(listy0));
    });

    // GroupBy(a => a.CreationTime.DayOfWeek).Select(gr => new { gr.Key, Count = gr.Count() }); compare ordered mem vs db
    // TODO(api): DayOfWeek extraction in query and groupBy over a DayOfWeek key
    test("DayOfWeekGroupBy", { skip: true }, async () => {
        // const listA = await table(NoteWithDateEntity)
        //     .groupBy(a => a.creationTime.dayOfWeek)
        //     .map(gr => ({ key: gr.key, count: gr.elements.length }))
        //     .toArray();
        // assert.ok(Array.isArray(listA));
    });

    // Dump (CreationTime - CreationTime).Total{Days,Hours,Minutes,Seconds} + (AddDays(1)-CreationTime).TotalMilliseconds + (CreationDate.DayNumber - CreationDate.DayNumber)
    // TODO(api): DateTime subtraction / TimeSpan totals (totalDays/totalHours/totalMinutes/totalSeconds/totalMilliseconds), AddDays, DayNumber, InSql()
    test("DateDiffFunctions", { skip: true }, async () => {
        // await table(NoteWithDateEntity).map(n => n.creationTime.since(n.creationTime).total("days")).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.add({ days: 1 }).since(n.creationTime).total("milliseconds")).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.dayNumber - n.creationDate.dayNumber).toArray();
    });

    // Dump CreationTime.DaysTo/MonthsTo/YearsTo(CreationTime).InSql()
    // TODO(api): DateTime difference helpers (daysTo/monthsTo/yearsTo) in query and InSql()
    test("DateTimeDiffFunctionsTo", { skip: true }, async () => {
        // await table(NoteWithDateEntity).map(n => n.creationTime.daysTo(n.creationTime)).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.monthsTo(n.creationTime)).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.yearsTo(n.creationTime)).toArray();
    });

    // Dump CreationDate.DaysTo/MonthsTo/YearsTo(CreationDate).InSql()
    // TODO(api): Date difference helpers (daysTo/monthsTo/yearsTo) in query and InSql()
    test("DateOnlyDiffFunctionsTo", { skip: true }, async () => {
        // await table(NoteWithDateEntity).map(n => n.creationDate.daysTo(n.creationDate)).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.monthsTo(n.creationDate)).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationDate.yearsTo(n.creationDate)).toArray();
    });

    // Dump CreationTime.Date; if (IsDbType(TimeSpan)) Dump CreationTime.TimeOfDay
    // TODO(api): DateTime.Date (date truncation) and TimeOfDay extraction in query
    test("DateFunctions", { skip: true }, async () => {
        // await table(NoteWithDateEntity).map(n => n.creationTime.date).toArray();
        // await table(NoteWithDateEntity).map(n => n.creationTime.timeOfDay).toArray();
    });

    // Where(n => n.CreationTime.DayOfWeek != DayOfWeek.Sunday).Select(n => n.CreationTime.DayOfWeek) + CreationDate.DayOfWeek
    // TODO(api): DayOfWeek extraction in query and a DayOfWeek enum constant
    test("DayOfWeekFunction", { skip: true }, async () => {
        // const list = await table(NoteWithDateEntity)
        //     .filter(n => n.creationTime.dayOfWeek != DayOfWeek.Sunday)
        //     .map(n => n.creationTime.dayOfWeek)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // if (IsDbType(TimeSpan)): MListQuery(Songs).Select(mle => mle.Element.Duration).Where(d => d != null); Duration.Hours/Minutes/Seconds/Milliseconds + (CreationTime ± Duration)
    // TODO(api): MListQuery (link-row access), TimeSpan/Duration part extraction (hours/minutes/seconds/milliseconds) and DateTime ± Duration arithmetic in query
    test("TimeSpanFunction", { skip: true }, async () => {
        // const durations = table(AlbumEntity).flatMap(a => a.songs).map(s => s.duration).filter(d => d != null);
        // await durations.map(d => d!.hours).toArray();
        // await durations.map(d => d!.minutes).toArray();
        // await durations.map(d => d!.seconds).toArray();
        // await durations.map(d => d!.milliseconds).toArray();
    });

    // SqlHierarchyId: nodes, GetAncestor/GetLevel/IsDescendantOf/GetReparentedValue/GetDescendant/GetRoot
    // TODO(api): SqlHierarchyId type and its functions are not modelled (LabelEntity.Node is not present)
    test("SqlHierarchyIdFunction", { skip: true }, async () => {
        // SqlHierarchyId is not modelled in altea.
    });

    // Dump Math.Sign/Abs/Sin/Asin/Cos/Acos/Tan/Atan/Atan2/Pow/Sqrt/Exp/Log/Floor/Log10/Ceiling/Round/Truncate over a.Year
    // TODO(api): SQL Math functions in query (sign/abs/sin/asin/cos/acos/tan/atan/atan2/pow/sqrt/exp/log/floor/log10/ceiling/round/truncate) and InSql()
    test("MathFunctions", { skip: true }, async () => {
        // await table(AlbumEntity).map(a => Math.sign(a.year)).toArray();
        // await table(AlbumEntity).map(a => -Math.sign(a.year) * a.year).toArray();
        // await table(AlbumEntity).map(a => Math.abs(a.year)).toArray();
        // await table(AlbumEntity).map(a => Math.sin(a.year)).toArray();
        // await table(AlbumEntity).map(a => Math.asin(Math.sin(a.year))).toArray();
        // await table(AlbumEntity).map(a => Math.cos(a.year)).toArray();
        // await table(AlbumEntity).map(a => Math.acos(Math.cos(a.year))).toArray();
        // await table(AlbumEntity).map(a => Math.tan(a.year)).toArray();
        // await table(AlbumEntity).map(a => Math.atan(Math.tan(a.year))).toArray();
        // await table(AlbumEntity).map(a => Math.atan2(1, 1)).toArray();
        // await table(AlbumEntity).map(a => Math.pow(a.year, 2)).toArray();
        // await table(AlbumEntity).map(a => Math.sqrt(a.year)).toArray();
        // await table(AlbumEntity).map(a => Math.exp(Math.log(a.year))).toArray();
        // await table(AlbumEntity).map(a => Math.floor(a.year + 0.5)).toArray();
        // await table(AlbumEntity).map(a => Math.log10(a.year)).toArray();
        // await table(AlbumEntity).map(a => Math.ceil(a.year + 0.5)).toArray();
        // await table(AlbumEntity).map(a => Math.round(a.year + 0.5)).toArray();
        // await table(AlbumEntity).map(a => Math.trunc(a.year + 0.5)).toArray();
    });

    // Select(a => (a.Name + null).InSql()); Assert.DoesNotContain(list, string.IsNullOrEmpty)
    // TODO(api): concatenation with a typed null literal and InSql() hint
    test("ConcatenateNull", { skip: true }, async () => {
        // const list = await table(ArtistEntity).map(a => a.name + null).toArray();
        // assert.ok(!list.some(s => s == null || s == ""));
    });

    // Select(a => a.Sex.ToString())
    // TODO(api): enum toString in query
    test("EnumToString", { skip: true }, async () => {
        // const sexs = await table(ArtistEntity).map(a => a.sex.toString()).toArray();
        // assert.ok(Array.isArray(sexs));
    });

    // Select(a => a.Status.ToString())
    // TODO(api): nullable enum toString in query
    test("NullableEnumToString", { skip: true }, async () => {
        // const sexs = await table(ArtistEntity).map(a => a.status.toString()).toArray();
        // assert.ok(Array.isArray(sexs));
    });

    // Select(a => a.Name + " is " + a.Status)
    // TODO(api): nullable enum coerced to string in concatenation inside a query projection
    test("ConcatenateStringNullableNominate", { skip: true }, async () => {
        // const list2 = await table(ArtistEntity).map(a => a.name + " is " + a.status).toArray();
        // assert.ok(Array.isArray(list2));
    });

    // Select(a => a.Name + " is published by " + a.Label)
    // TODO(api): entity coerced to string (ToString) in concatenation inside a query projection
    test("ConcatenateStringNullableEntity", { skip: true }, async () => {
        // const list1 = await table(AlbumEntity).map(a => a.name + " is published by " + a.label).toArray();
        // assert.ok(Array.isArray(list1));
    });

    // Where(a => (a + "").Contains("Michael")); Assert.True(list.Count == 1)
    // TODO(api): entity coerced to string (ToString) in concatenation inside a query filter
    test("ConcatenateStringFullNominate", { skip: true }, async () => {
        // const list = await table(ArtistEntity).filter(a => (a + "").contains("Michael")).toArray();
        // assert.equal(list.length, 1);
    });

    // SequenceEqual(Select(a => a.Name.Etc(10)).OrderBy(), Select(a => a.Name).ToList().Select(l => l.Etc(10)).OrderBy()); Count(Etc(10).EndsWith("s")) == Count(Name.EndsWith("s"))
    // TODO(api): String.Etc in query and parameterless OrderBy() (order by the value itself)
    test("Etc", { skip: true }, async () => {
        // const dbEtc = (await table(AlbumEntity).map(a => a.name.etc(10)).toArray()).orderBy(s => s);
        // const memEtc = (await table(AlbumEntity).map(a => a.name).toArray()).map(l => l.etc(10)).orderBy(s => s);
        // assert.deepEqual(dbEtc, memEtc);
        // assert.equal(
        //     await table(AlbumEntity).count(a => a.name.etc(10).endsWith("s")),
        //     await table(AlbumEntity).count(a => a.name.endsWith("s")));
    });

    // Where(a => MinimumExtensions.MinimumTableValued((int)a.Id * 2, (int)a.Id).Select(m => m.MinValue).First() > 2).Select(a => a.Id)
    // TODO(api): table-valued function (MinimumTableValued) in query
    test("TableValuedFunction", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .filter(a => MinimumExtensions.minimumTableValued((a.id as number) * 2, (a.id as number)).map(m => m.minValue).first() > 2)
        //     .map(a => a.id)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // Cross-join songs x4 with MinimumTableValued vs MinimumScalar perf comparison
    // TODO(api): MListQuery, table-valued function (MinimumTableValued), scalar UDF (MinimumScalar) and cross joins
    test("TableValuedPerformanceTest", { skip: true }, async () => {
        // Requires MListQuery + table-valued/scalar UDFs + cross joins.
    });

    // from b let min = MinimumExtensions.MinimumTableValued((int)b.Id, (int)b.Id).FirstOrDefault()!.MinValue select b.Name
    // TODO(api): table-valued function (MinimumTableValued) in a let/projection
    test("SimplifyMinimumTableValued", { skip: true }, async () => {
        // const result = await table(BandEntity).map(b => b.name).toArray();
        // assert.ok(Array.isArray(result));
    });

    // Select(a => (a.Songs.Count > 10 ? Large : a.Songs.Count > 5 ? Medium : Small).InSql())
    // TODO(api): per-row collection .length (a.songs.length) inside a projection, local enum (AlbumSize) and InSql()
    test("NominateEnumSwitch", { skip: true }, async () => {
        // const list = await table(AlbumEntity)
        //     .map(a => a.songs.length > 10 ? AlbumSize.Large : a.songs.length > 5 ? AlbumSize.Medium : AlbumSize.Small)
        //     .toArray();
        // assert.ok(Array.isArray(list));
    });

    // note = Select(a => a.ToLite()).FirstEx(); for each value: UnsafeUpdate Title then read InDB(function.Evaluate(Title).InSql()) — TryBefore/TryAfter/TryBeforeLast/TryAfterLast/Before/After/BeforeLast/AfterLast
    // TODO(api): UnsafeUpdate, InDB single-entity read, Expression.Evaluate, InSql() and the String.Try*/Before/After helpers in query
    test("EvaluateBeforeAfter", { skip: true }, async () => {
        // Requires UnsafeUpdate + InDB read + per-value transactions + String.tryBefore/tryAfter/... in SQL.
    });
});
