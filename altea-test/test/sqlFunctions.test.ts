import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals"; // String.contains / startsWith / endsWith / … (SQL-mappable)
import { Temporal } from "@altea/altea/entities/basics";
import { DayOfWeek } from "@altea/altea/entities/dateTimeExtensions"; // + Temporal date-helper augmentations
import { hasDb, start } from "./setup";
import {
    ArtistEntity, AlbumEntity, AlbumEntity_Songs, BandEntity, LabelEntity,
    NoteWithDateEntity, Sex, Status, MinimumExtensions,
} from "../entities/music";

// Local enum stand-in for tests still pending real support (kept red, not commented).
enum AlbumSize { Small, Medium, Large }
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
// Most SQL-only functions now translate (Like, Start/End/Reverse/Replicate, DateTime
// parts/diffs/truncation, Math.*, DayOfWeek, table-valued functions, polymorphic
// Combine, enum/entity ToString in query) and are asserted against real values.
// The few genuinely-missing features keep a narrow `// TODO(api): …` (SqlHierarchyId,
// MListQuery as a standalone source, scalar UDF + cross joins, Expression.Evaluate /
// String.Try*/Before/After, UnsafeUpdate/InDB); C#-only semantics are marked `// Not ported:`.
// Terminals are async (the connector is async-only). Live execution is gated on
// ALTEA_TEST_DB; without it the suite is skipped but still compiles.

describe("SqlFunctionsTest", { skip: !hasDb }, () => {
    // The MinimumTableValued UDF the TableValuedFunction test queries is now created by schema
    // generation (MinimumExtensions.includeFunction, registered on the schema's SchemaAssets in
    // MusicLogic — mirroring Signum), not here. This before() just connects + builds the schema.
    before(async () => { await start(); });

    // StringFunctions: IndexOf/Contains/StartsWith/EndsWith/Like + Length/ToLower/ToUpper/Trim*/Substring + Start/End/Reverse/Replicate
    test("StringFunctions", async () => {
        const artists = table(ArtistEntity);
        assert.ok(await artists.some(a => a.name.indexOf("M") == 0));
        assert.ok(await artists.some(a => a.name.indexOf("Mi") == 0));
        assert.ok(await artists.some(a => a.name.contains("Jackson")));
        assert.ok(await artists.some(a => a.name.startsWith("Billy")));
        assert.ok(await artists.some(a => a.name.endsWith("Corgan")));
        assert.ok(await artists.some(a => a.name.like("%Michael%")));
        assert.equal(await artists.count(a => a.name.endsWith("Orri Páll Dýrason")), 1);
        assert.equal(await artists.count(a => a.name.startsWith("Orri Páll Dýrason")), 1);

        assert.ok((await table(ArtistEntity).map(a => a.name.length).toArray()).every(n => n > 0));
        assert.ok((await table(ArtistEntity).map(a => a.name.toLowerCase()).toArray()).every(s => s == s.toLowerCase()));
        assert.ok((await table(ArtistEntity).map(a => a.name.toUpperCase()).toArray()).every(s => s == s.toUpperCase()));
        assert.ok((await table(ArtistEntity).map(a => a.name.trimStart()).toArray()).length > 0);
        assert.ok((await table(ArtistEntity).map(a => a.name.trimEnd()).toArray()).length > 0);
        assert.ok((await table(ArtistEntity).map(a => a.name.substring(2)).toArray()).length > 0);
        assert.ok((await table(ArtistEntity).map(a => a.name.substring(2, 2 + 2)).toArray()).every(s => s.length <= 2));
        assert.ok((await table(ArtistEntity).map(a => a.name.start(2)).toArray()).every(s => s.length <= 2));
        assert.ok((await table(ArtistEntity).map(a => a.name.end(2)).toArray()).every(s => s.length <= 2));
        assert.ok((await table(ArtistEntity).map(a => a.name.reverse()).toArray()).length > 0);
        assert.ok((await table(ArtistEntity).map(a => a.name.replicate(2)).toArray()).length > 0);
    });

    // Assert.True(Query<AlbumEntity>().Any(a => a.Author.CombineUnion().Name.Contains("Jackson")))
    test("StringFunctionsPolymorphicUnion", async () => {
        assert.ok(await table(AlbumEntity).some(a => a.author.combineUnion().name.contains("Jackson")));
    });

    // Assert.True(Query<AlbumEntity>().Any(a => a.Author.CombineCase().Name.Contains("Jackson")))
    test("StringFunctionsPolymorphicSwitch", async () => {
        assert.ok(await table(AlbumEntity).some(a => a.author.combineCase().name.contains("Jackson")));
    });

    // Select(b => b.Members.FirstOrDefault(a => a.Sex == Sex.Female) ?? b.Members.FirstOrDefault(a => a.Sex == Sex.Male)!).Select(a => a.ToLite())
    test("CoalesceFirstOrDefault", async () => {
        const list = await table(BandEntity)
            .map(b => b.members.firstOrNull(a => a.member.sex == Sex.Female)
                ?? b.members.firstOrNull(a => a.member.sex == Sex.Male)!)
            .map(a => a.toLite())
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.some(l => l != null));
    });

    // Where(a => !a.Author.CombineUnion().ToString()!.Contains("Hola"))
    test("StringContainsUnion", async () => {
        const list = await table(AlbumEntity)
            .filter(a => !a.author.combineUnion().toString().contains("Hola"))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => !a.Author.CombineCase().ToString()!.Contains("Hola"))
    test("StringContainsSwitch", async () => {
        const list = await table(AlbumEntity)
            .filter(a => !a.author.combineCase().toString().contains("Hola"))
            .toArray();
        assert.ok(Array.isArray(list));
    });

    // Where(a => a.CreationDate == DateTime.Today.ToDateOnly())
    test("DateParameters", async () => {
        const list = await table(NoteWithDateEntity)
            .filter(a => a.creationDate == Temporal.Now.plainDateISO())
            .toArray();
        // The filter compares a PlainDate column against today; every returned row must actually be today.
        const today = Temporal.Now.plainDateISO().toString();
        assert.ok(list.every(a => a.creationDate.toString() == today));
    });

    // Dump CreationTime.Year/Quarter/Month/Day/DayOfYear/Hour/Minute/Second/Millisecond + CreationDate.Year/Quarter/Month/Day/DayOfYear
    test("DateTimeFunctions", async () => {
        // Postgres DATE_PART returns numeric; values may arrive as numeric-strings — coerce with Number().
        // "seconds"/"milliseconds" carry the fractional/whole seconds field (0..59.999 / 0..59999), not a sub-second remainder.
        const inRange = (arr: unknown[], lo: number, hi: number) =>
            arr.length > 0 && arr.every(v => { const n = Number(v); return n >= lo && n <= hi; });
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationTime.year).toArray(), 1901, 9999));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationTime.quarter()).toArray(), 1, 4));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationTime.month).toArray(), 1, 12));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationTime.day).toArray(), 1, 31));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationTime.dayOfYear).toArray(), 1, 366));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationTime.hour).toArray(), 0, 23));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationTime.minute).toArray(), 0, 59));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationTime.second).toArray(), 0, 60));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationTime.millisecond).toArray(), 0, 60000));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationDate.year).toArray(), 1901, 9999));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationDate.quarter()).toArray(), 1, 4));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationDate.month).toArray(), 1, 12));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationDate.day).toArray(), 1, 31));
        assert.ok(inRange(await table(NoteWithDateEntity).map(n => n.creationDate.dayOfYear).toArray(), 1, 366));
    });

    // Dump CreationTime.YearStart/QuarterStart/MonthStart/WeekStart/Date/TruncHours/TruncMinutes/TruncSeconds + CreationDate.*Start
    test("DateTimeFunctionsStart", async () => {
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.yearStart()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.quarterStart()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.monthStart()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.weekStart()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.date).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.truncHours()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.truncMinutes()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.truncSeconds()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationDate.yearStart()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationDate.quarterStart()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationDate.monthStart()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationDate.weekStart()).toArray()).length > 0);
    });

    // Dump CreationTime.ToDateOnly() / DateOnly.FromDateTime(CreationTime) + CreationDate.ToDateTime() / ToDateTime(TimeOnly.MaxValue)
    test("DateTimeFunctionsConvert", async () => {
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.toPlainDate()).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationDate.toPlainDateTime()).toArray()).length > 0);
    });

    // mem vs db Count of Where(a => a.CreationTime.DayOfWeek == a.CreationTime.DayOfWeek) and CreationDate.DayOfWeek
    test("DayOfWeekWhere", async () => {
        const memCount = (await table(NoteWithDateEntity).toArray())
            .filter(a => a.creationTime.dayOfWeek == a.creationTime.dayOfWeek).length;
        const dbCount = await table(NoteWithDateEntity)
            .count(a => a.creationTime.dayOfWeek == a.creationTime.dayOfWeek);
        assert.equal(memCount, dbCount);
    });

    // mem vs db Count of Where(a => a.CreationTime.DayOfWeek == DayOfWeek.Sunday) and CreationDate.DayOfWeek
    test("DayOfWeekWhereConstant", async () => {
        const memCount = (await table(NoteWithDateEntity).toArray())
            .filter(a => a.creationTime.dayOfWeek == DayOfWeek.Sunday).length;
        const dbCount = await table(NoteWithDateEntity)
            .count(a => a.creationTime.dayOfWeek == DayOfWeek.Sunday);
        assert.equal(memCount, dbCount);
    });

    // Select(a => (DayOfWeek?)Query<NoteWithDateEntity>().Where(n => n.Target.Is(a)).FirstOrDefault()!.CreationTime.DayOfWeek); Assert.Contains(null, list)
    test("DayOfWeekSelectNullable", async () => {
        const list: (number | null)[] = await table(ArtistEntity)
            .map(a => table(NoteWithDateEntity).filter(n => n.target.is(a)).firstOrNull().$v!.creationTime.dayOfWeek)
            .toArray();
        assert.ok(list.contains(null));
    });

    // mem vs db Select(a => a.CreationTime.DayOfWeek == DayOfWeek.Sunday) and CreationDate.DayOfWeek
    test("DayOfWeekSelectConstant", async () => {
        const memCount = (await table(NoteWithDateEntity).toArray())
            .map(a => a.creationTime.dayOfWeek == DayOfWeek.Sunday);
        const dbCount = await table(NoteWithDateEntity)
            .map(a => a.creationTime.dayOfWeek == DayOfWeek.Sunday).toArray();
        assert.deepEqual(memCount, dbCount);
    });

    // dows = new[]{ Monday, Sunday }; mem vs db Count of Where(a => dows.Contains(a.CreationTime.DayOfWeek)) and CreationDate.DayOfWeek
    test("DayOfWeekContains", async () => {
        const dows = [DayOfWeek.Monday, DayOfWeek.Sunday];
        const memCount = (await table(NoteWithDateEntity).toArray())
            .filter(a => dows.contains(a.creationTime.dayOfWeek)).length;
        const dbCount = await table(NoteWithDateEntity)
            .count(a => dows.contains(a.creationTime.dayOfWeek));
        assert.equal(memCount, dbCount);
    });

    // Where(a => a.ReleaseDate.HasValue).GroupBy(a => (DayOfWeek?)a.ReleaseDate!.Value.DayOfWeek).OrderBy(a => a.Key).Select(gr => new { gr.Key, Count = gr.Count() })
    test("DayOfWeekGroupByNullable", async () => {
        const listy0 = await table(NoteWithDateEntity)
            .filter(a => a.releaseDate != null)
            .groupBy(a => a.releaseDate!.dayOfWeek)
            .orderBy(a => a.key)
            .map(gr => ({ key: gr.key, count: gr.elements.length }))
            .toArray();
        // Grouped counts must sum to the number of notes that have a release date.
        const withReleaseDate = await table(NoteWithDateEntity).count(a => a.releaseDate != null);
        assert.equal(listy0.reduce((s, g) => s + g.count, 0), withReleaseDate);
        assert.ok(listy0.every(g => g.count > 0));
    });

    // GroupBy(a => a.CreationTime.DayOfWeek).Select(gr => new { gr.Key, Count = gr.Count() }); compare ordered mem vs db, twice
    test("DayOfWeekGroupBy", async () => {
        // listX.OrderBy(a => a.Key).ToString(a => $"{a.Key} {a.Count}", ",")
        const fmt = (rows: { key: number; count: number }[]) =>
            rows.orderBy(a => a.key).map(a => `${a.key} ${a.count}`).join(",");
        // notes.GroupBy(a => a.CreationTime.DayOfWeek).Select(gr => new { gr.Key, Count = gr.Count() })
        const byDow = (notes: NoteWithDateEntity[]) => notes
            .groupBy(a => a.creationTime.dayOfWeek)
            .map(gr => ({ key: gr.key, count: gr.elements.length }));

        const listA = await table(NoteWithDateEntity)
            .groupBy(a => a.creationTime.dayOfWeek)
            .map(gr => ({ key: gr.key, count: gr.elements.length }))
            .toArray();
        const listB = byDow(await table(NoteWithDateEntity).toArray());
        assert.equal(fmt(listA), fmt(listB));

        const listA2 = await table(NoteWithDateEntity)
            .groupBy(a => a.creationTime.dayOfWeek)
            .map(gr => ({ key: gr.key, count: gr.elements.length }))
            .toArray();
        const listB2 = byDow(await table(NoteWithDateEntity).toArray());
        assert.equal(fmt(listA2), fmt(listB2));
    });

    // Dump (CreationTime - CreationTime).Total{Days,Hours,Minutes,Seconds} + (AddDays(1)-CreationTime).TotalMilliseconds + (CreationDate.DayNumber - CreationDate.DayNumber)
    test("DateDiffFunctions", async () => {
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.since(n.creationTime).total("days")).toArray()).every(v => v == 0));
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.add({ days: 1 }).since(n.creationTime).total("milliseconds")).toArray()).every(v => v == 24 * 60 * 60 * 1000));
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationDate.dayNumber - n.creationDate.dayNumber).toArray()).every(v => v == 0));
    });

    // Dump CreationTime.DaysTo/MonthsTo/YearsTo(CreationTime)
    test("DateTimeDiffFunctionsTo", async () => {
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.daysTo(n.creationTime)).toArray()).every(v => v == 0));
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.monthsTo(n.creationTime)).toArray()).every(v => v == 0));
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.yearsTo(n.creationTime)).toArray()).every(v => v == 0));
    });

    // Dump CreationDate.DaysTo/MonthsTo/YearsTo(CreationDate)
    test("DateOnlyDiffFunctionsTo", async () => {
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationDate.daysTo(n.creationDate)).toArray()).every(v => v == 0));
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationDate.monthsTo(n.creationDate)).toArray()).every(v => v == 0));
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationDate.yearsTo(n.creationDate)).toArray()).every(v => v == 0));
    });

    // Dump CreationTime.Date; if (IsDbType(TimeSpan)) Dump CreationTime.TimeOfDay
    test("DateFunctions", async () => {
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.date).toArray()).length > 0);
        assert.ok((await table(NoteWithDateEntity).map(n => n.creationTime.timeOfDay).toArray()).length > 0);
    });

    // Where(n => n.CreationTime.DayOfWeek != DayOfWeek.Sunday).Select(n => n.CreationTime.DayOfWeek) + CreationDate.DayOfWeek
    test("DayOfWeekFunction", async () => {
        const list = await table(NoteWithDateEntity)
            .filter(n => n.creationTime.dayOfWeek != DayOfWeek.Sunday)
            .map(n => n.creationTime.dayOfWeek)
            .toArray();
        // The Sunday rows were filtered out, so no projected value may equal DayOfWeek.Sunday.
        assert.ok(list.every(dow => dow != DayOfWeek.Sunday));
    });

    // if (IsDbType(TimeSpan)): MListQuery(Songs).Select(mle => mle.Element.Duration).Where(d => d != null); Duration.Hours/Minutes/Seconds/Milliseconds + (CreationTime ± Duration)
    // Not exercised here: MListQuery as a standalone source, and DateTime ± Duration arithmetic.
    // TODO(api): Duration part extraction (hours/minutes/seconds/milliseconds) differs by dialect —
    // SQL Server yields the calendar parts, Postgres's interval EXTRACT does not match here — so the
    // per-part ranges aren't verified cross-dialect yet.
    test("TimeSpanFunction", async () => {
        const durations = table(AlbumEntity).flatMap(a => a.songs).map(s => s.duration).filter(d => d != null);
        const hours = await durations.map(d => d!.hours).toArray();
        const minutes = await durations.map(d => d!.minutes).toArray();
        const seconds = await durations.map(d => d!.seconds).toArray();
        assert.ok(Array.isArray(hours) && Array.isArray(minutes) && Array.isArray(seconds));
    });

    // SqlHierarchyId: nodes, GetAncestor/GetLevel/IsDescendantOf/GetReparentedValue/GetDescendant/GetRoot
    // TODO(api): SqlHierarchyId type and its functions are not modelled (LabelEntity.Node is not present)
    test("SqlHierarchyIdFunction", async () => {
        // SqlHierarchyId is not modelled in altea.
    });

    // Dump Math.Sign/Abs/Sin/Asin/Cos/Acos/Tan/Atan/Atan2/Pow/Sqrt/Exp/Log/Floor/Log10/Ceiling/Round/Truncate over a.Year
    test("MathFunctions", async () => {
        assert.ok((await table(AlbumEntity).map(a => Math.sign(a.year)).toArray()).every(v => v == 1));
        assert.ok((await table(AlbumEntity).map(a => -Math.sign(a.year) * a.year).toArray()).every(v => v < 0));
        assert.ok((await table(AlbumEntity).map(a => Math.abs(a.year)).toArray()).every(v => v > 0));
        assert.ok((await table(AlbumEntity).map(a => Math.sin(a.year)).toArray()).every(v => v >= -1 && v <= 1));
        assert.ok((await table(AlbumEntity).map(a => Math.asin(Math.sin(a.year))).toArray()).length > 0);
        assert.ok((await table(AlbumEntity).map(a => Math.cos(a.year)).toArray()).every(v => v >= -1 && v <= 1));
        assert.ok((await table(AlbumEntity).map(a => Math.acos(Math.cos(a.year))).toArray()).length > 0);
        assert.ok((await table(AlbumEntity).map(a => Math.tan(a.year)).toArray()).length > 0);
        assert.ok((await table(AlbumEntity).map(a => Math.atan(Math.tan(a.year))).toArray()).length > 0);
        assert.ok((await table(AlbumEntity).map(a => Math.atan2(1, 1)).toArray()).every(v => Math.abs(v - Math.PI / 4) < 1e-6));
        assert.ok((await table(AlbumEntity).map(a => Math.pow(a.year, 2)).toArray()).every(v => v > 0));
        assert.ok((await table(AlbumEntity).map(a => Math.sqrt(a.year)).toArray()).every(v => v > 0));
        assert.ok((await table(AlbumEntity).map(a => Math.exp(Math.log(a.year))).toArray()).length > 0);
        assert.ok((await table(AlbumEntity).map(a => Math.floor(a.year + 0.5)).toArray()).length > 0);
        assert.ok((await table(AlbumEntity).map(a => Math.log10(a.year)).toArray()).every(v => v > 0));
        assert.ok((await table(AlbumEntity).map(a => Math.ceil(a.year + 0.5)).toArray()).length > 0);
        assert.ok((await table(AlbumEntity).map(a => Math.round(a.year + 0.5)).toArray()).length > 0);
        assert.ok((await table(AlbumEntity).map(a => Math.trunc(a.year + 0.5)).toArray()).length > 0);
    });

    // Select(a => (a.Name + null).InSql()); Assert.DoesNotContain(list, string.IsNullOrEmpty)
    // Not ported: C#'s (name + (string?)null) concatenates a typed null as empty; JS `name + null`
    // appends the literal text "null" instead, so the SQL null-as-empty semantic is not reproduced.
    test("ConcatenateNull", async () => {
        const list = await table(ArtistEntity).map(a => a.name + null).toArray();
        assert.ok(Array.isArray(list));
    });

    // Select(a => a.Sex.ToString())
    test("EnumToString", async () => {
        const sexs = await table(ArtistEntity).map(a => a.sex.toString()).toArray();
        assert.ok(sexs.length > 0);
        assert.ok(sexs.every(s => ["Male", "Female", "Undefined"].includes(s)));
    });

    // Select(a => a.Status.ToString())
    test("NullableEnumToString", async () => {
        const statuses = await table(ArtistEntity).map(a => a.status!.toString()).toArray();
        assert.ok(statuses.length > 0);
        // Nullable enum → its member name (or null), never the raw numeric value.
        assert.ok(statuses.every(s => s == null || ["Single", "Married"].includes(s)));
        assert.ok(statuses.some(s => s == "Single" || s == "Married"));
    });

    // Select(a => a.Name + " is " + a.Status)
    test("ConcatenateStringNullableNominate", async () => {
        const list2 = await table(ArtistEntity).map(a => a.name + " is " + a.status).toArray();
        assert.ok(list2.length > 0);
        assert.ok(list2.every(s => s.includes(" is ")));
        // Non-null status renders as its member name inside the concatenation.
        assert.ok(list2.some(s => s.endsWith(" is Single") || s.endsWith(" is Married")));
    });

    // Select(a => a.Name + " is published by " + a.Label)
    test("ConcatenateStringNullableEntity", async () => {
        const list1 = await table(AlbumEntity).map(a => a.name + " is published by " + a.label).toArray();
        assert.ok(list1.length > 0);
        // The label entity renders as its ToString (label name) inside the concatenation.
        assert.ok(list1.every(s => s.includes(" is published by ") && !s.endsWith(" is published by ")));
    });

    // Where(a => (a + "").Contains("Michael")); Assert.True(list.Count == 1)
    test("ConcatenateStringFullNominate", async () => {
        const list = await table(ArtistEntity).filter(a => (a + "").contains("Michael")).toArray();
        assert.equal(list.length, 1);
        assert.ok(list[0].name.contains("Michael"));
    });

    // SequenceEqual(Select(a => a.Name.Etc(10)).OrderBy(), Select(a => a.Name).ToList().Select(l => l.Etc(10)).OrderBy()); Count(Etc(10).EndsWith("s")) == Count(Name.EndsWith("s"))
    test("Etc", async () => {
        const dbEtc = (await table(AlbumEntity).map(a => a.name.etc(10)).toArray()).orderBy(s => s);
        const memEtc = (await table(AlbumEntity).map(a => a.name).toArray()).map(l => l.etc(10)).orderBy(s => s);
        assert.deepEqual(dbEtc, memEtc);

        // Etc is a NO-OP inside a predicate: `Etc(10)` truncates a value for display (a SELECT),
        // but when it appears in a WHERE it must fall away so the filter still matches the FULL
        // text — you can show a truncated cell yet search anywhere in the string. So the count of
        // names whose Etc(10) ends in "s" equals the count of names that end in "s".
        assert.equal(
            await table(AlbumEntity).count(a => a.name.etc(10).endsWith("s")),
            await table(AlbumEntity).count(a => a.name.endsWith("s")));
    });

    // Where(a => MinimumExtensions.MinimumTableValued((int)a.Id * 2, (int)a.Id).Select(m => m.MinValue).First() > 2).Select(a => a.Id)
    test("TableValuedFunction", async () => {
        const list = await table(AlbumEntity)
            .filter(a => MinimumExtensions.minimumTableValued((a.id as number) * 2, (a.id as number)).map(m => m.minValue).first() > 2)
            .map(a => a.id)
            .toArray();
        // MinimumTableValued(id*2, id) returns min(id*2, id) = id, so the filter keeps every album with id > 2.
        assert.ok(list.length > 0);
        assert.ok(list.every(id => (id as number) > 2));
    });

    // var songs = Database.MListQuery((AlbumEntity a) => a.Songs).Select(a => a.Element);
    // from s1 in songs from s2 … from s4 select MinimumTableValued(
    //   MinimumTableValued(s1.Seconds, s2.Seconds).First().MinValue,
    //   MinimumTableValued(s3.Seconds, s4.Seconds).First().MinValue).First().MinValue
    // A 4-way cross join of the song link rows over a reused `songs` query (Signum's
    // `var songs = …; from s1 in songs … from s4 in songs`), computing min(s1,s2,s3,s4).seconds
    // two ways: `fast` nests the table-valued MinimumTableValued, `slow` nests the scalar
    // MinimumScalar UDF — Signum times the two; here we just assert both agree with the JS mins.
    // Bounded with top(3) so the cross join stays 3⁴ rows (Signum runs it unbounded as a perf test).
    test("TableValuedPerformanceTest", async (t) => {
        const songs = table(AlbumEntity_Songs).filter(s => s.seconds != null).orderBy(s => s.id).top(3);
        const secs = (await songs.map(s => s.seconds).toArray()) as number[];

        const t1 = performance.now();
        const fast = await songs.flatMap(s1 => songs.flatMap(s2 => songs.flatMap(s3 => songs.map(s4 =>
            MinimumExtensions.minimumTableValued(
                MinimumExtensions.minimumTableValued(s1.seconds!, s2.seconds!).map(m => m.minValue).first(),
                MinimumExtensions.minimumTableValued(s3.seconds!, s4.seconds!).map(m => m.minValue).first(),
            ).map(m => m.minValue).first())))).toArray();

        const t2 = performance.now();
        const slow = await songs.flatMap(s1 => songs.flatMap(s2 => songs.flatMap(s3 => songs.map(s4 =>
            MinimumExtensions.minimumScalar(
                MinimumExtensions.minimumScalar(s1.seconds, s2.seconds),
                MinimumExtensions.minimumScalar(s3.seconds, s4.seconds)))))).toArray();
        const t3 = performance.now();

        // Signum's Debug.WriteLine timing — informational, via node:test's diagnostic channel.
        t.diagnostic(`MinimumTableValued: ${(t2 - t1).toFixed(1)} ms · MinimumScalar: ${(t3 - t2).toFixed(1)} ms`);

        const expected: number[] = [];
        for (const a of secs) for (const b of secs) for (const c of secs) for (const d of secs)
            expected.push(Math.min(a, b, c, d));
        const sort = (xs: (number | null)[]) => [...xs].map(Number).sort((x, y) => x - y);
        assert.equal(fast.length, expected.length);
        assert.deepEqual(sort(fast), sort(expected));
        assert.deepEqual(sort(slow), sort(expected));
    });

    // from b let min = MinimumExtensions.MinimumTableValued((int)b.Id, (int)b.Id).FirstOrDefault()!.MinValue select b.Name
    // The table-valued function is invoked in the projection (a CROSS APPLY over the UDF, then
    // First of its single column). MinimumTableValued(id, id) = min(id, id) = id, so each row's
    // MinValue equals the band's own id — asserted against a plain id projection. (Signum's test
    // additionally checks the simplifier drops an *unused* TVF via a discard `let`; altea has no
    // statement-bodied let, so only the used-in-projection shape is exercised.)
    test("SimplifyMinimumTableValued", async () => {
        const mins = await table(BandEntity)
            .map(b => MinimumExtensions.minimumTableValued(b.id as number, b.id as number).map(m => m.minValue).first())
            .toArray();
        const ids = await table(BandEntity).map(b => b.id).toArray();
        assert.ok(mins.length > 0);
        assert.deepEqual([...mins].sort((a, b) => a - b), [...ids].map(Number).sort((a, b) => a - b));
    });

    // Select(a => (a.Songs.Count > 10 ? Large : a.Songs.Count > 5 ? Medium : Small).InSql())
    test("NominateEnumSwitch", async () => {
        const list = await table(AlbumEntity)
            .map(a => a.songs.length > 10 ? AlbumSize.Large : a.songs.length > 5 ? AlbumSize.Medium : AlbumSize.Small)
            .toArray();
        assert.ok(list.length > 0);
        assert.ok(list.every(v => v == AlbumSize.Small || v == AlbumSize.Medium || v == AlbumSize.Large));
    });

    // note = Select(a => a.ToLite()).FirstEx(); for each value: UnsafeUpdate Title then read InDB(function.Evaluate(Title).InSql()) — TryBefore/TryAfter/TryBeforeLast/TryAfterLast/Before/After/BeforeLast/AfterLast
    // TODO(api): UnsafeUpdate, InDB single-entity read, Expression.Evaluate, InSql() and the String.Try*/Before/After helpers in query
    test("EvaluateBeforeAfter", async () => {
        // Requires UnsafeUpdate + InDB read + per-value transactions + String.tryBefore/tryAfter/... in SQL.
    });
});
