import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/dynamicQuery/tokens/factories"; // register the token factories → local sub-token generation
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import type { Schema } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { Temporal } from "@altea/altea/data/basics";
import { QueryTokenDateMessage } from "@altea/altea/data/dynamicQueries";
import type { Entity, Type } from "@altea/altea/data/entity";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { NoteWithDateEntity } from "../../data/note";
import { AlbumEntity_Song } from "../../data/album";

// The date/time sub-tokens a search page offers on a PlainDateTime / PlainDate / Duration column — the
// port of Signum's DateTimeProperties / DateOnlyProperties / TimeSpanProperties (QueryToken.cs).
//
// Each token is one member call on the row, so the SQL it produces is exactly the SQL of that member —
// which is what this suite asserts, on BOTH dialects, because the two DIVERGE here more than anywhere
// else in the provider: EXTRACT does not count like DATEPART in three separate ways (ISO weeks,
// fractional seconds, sub-minute milliseconds), and a token that lowered on both without AGREEING would
// answer a different number depending on which database the app runs on.
//
// The assertions are over ORDER BY, not a projection: inside a `.map()` the provider may select the raw
// operands and compute client-side (CLIENT_PROJECTOR_OPS), which passes while proving nothing. Every
// lambda is written INLINE at its `.orderBy` for the same kind of reason — the quote-transformer only
// rewrites a lambda it can see at the call site, so one passed in through a parameter is never quoted.
class CapturingConnector extends Connector {
    readonly captured: string[] = [];
    constructor(schema: Schema, isPostgres: boolean) { super(schema, isPostgres, 128); }
    override executeQuery(sql: string): Promise<unknown[]> { this.captured.push(sql); return Promise.resolve([]); }
    openConnection(): Promise<never> { throw new Error("no DB in this offline test"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

async function capture(isPostgres: boolean, query: () => Promise<unknown>, include: Type<Entity>): Promise<string> {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = isPostgres;
    sb.include(include);
    const connector = new CapturingConnector(sb.schema, isPostgres);
    await Connector.withConnector(connector, query);
    const last = connector.captured[connector.captured.length - 1]!;
    if (process.env.SQL_DUMP === "1")
        console.log(`-- ${isPostgres ? "postgres" : "sqlserver"}\n${last}\n`);
    return last;
}

const bothProviders = [true, false];
const providerName = (isPostgres: boolean): string => isPostgres ? "postgres: " : "sqlserver: ";

/** Asserts the ORDER BY key of `sql(provider)` against the per-dialect pattern, on both dialects. */
async function assertBoth(
    sql: (isPostgres: boolean) => Promise<string>,
    expected: { postgres: RegExp; sqlserver: RegExp },
    what: string,
): Promise<void> {
    for (const isPostgres of bothProviders) {
        const statement = await sql(isPostgres);
        assert.match(statement, /ORDER BY/i, providerName(isPostgres) + what + ": the key reaches SQL");
        assert.match(statement, isPostgres ? expected.postgres : expected.sqlserver, providerName(isPostgres) + what);
    }
}

describe("WeekNumber — ISO on both providers and in memory", () => {
    // Signum answers three different numbers for this one token: its in-memory WeekNumber() asks the
    // CURRENT CULTURE's CalendarWeekRule, its SQL Server SQL is DATEPART(week) (week 1 holds Jan 1,
    // weeks start Sunday) and its PostgreSQL SQL is EXTRACT(week) (ISO). altea is ISO in all three,
    // which is also the Monday-first convention `weekStart` already uses.
    test("lowers as EXTRACT(week …) / DATEPART(iso_week, …) on a PlainDateTime", () =>
        assertBoth(p => capture(p, () => table(NoteWithDateEntity).orderBy(n => n.creationTime.weekNumber()).toArray(), NoteWithDateEntity), {
            postgres: /ORDER BY EXTRACT\(week from nwd\.creation_time\) ASC/i,
            sqlserver: /ORDER BY DATEPART\(iso_week, NWD\.CreationTime\) ASC/i,
        }, "weekNumber"));

    test("and on a PlainDate", () =>
        assertBoth(p => capture(p, () => table(NoteWithDateEntity).orderBy(n => n.creationDate.weekNumber()).toArray(), NoteWithDateEntity), {
            postgres: /ORDER BY EXTRACT\(week from nwd\.creation_date\) ASC/i,
            sqlserver: /ORDER BY DATEPART\(iso_week, NWD\.CreationDate\) ASC/i,
        }, "weekNumber on a date"));

    // The in-memory body has to agree with that SQL, or the same `@quoted` method answers one number in
    // a query and another in a preSaving hook. 2026-01-01 is a Thursday, so it is ISO week 1 of 2026;
    // 2027-01-01 is a Friday, so it belongs to ISO week 53 of 2026 — the case a naive dayOfYear/7 gets
    // wrong, and the one where Signum's SQL Server DATEPART(week) answers 1.
    test("the in-memory body is the same ISO week", () => {
        assert.equal(Temporal.PlainDate.from("2026-01-01").weekNumber(), 1);
        assert.equal(Temporal.PlainDate.from("2027-01-01").weekNumber(), 53);
        assert.equal(Temporal.PlainDate.from("2026-09-18").weekNumber(), 38);
        assert.equal(Temporal.PlainDateTime.from("2026-09-18T13:45:12").weekNumber(), 38);
    });
});

describe("the sub-minute parts — where EXTRACT is not DATEPART", () => {
    // PostgreSQL's EXTRACT(second …) carries the fraction (12.789) and EXTRACT(milliseconds …) is the
    // whole sub-minute expressed in milliseconds (12789), while SQL Server's DATEPART and Temporal's own
    // members are the integer COMPONENT (12 and 789).
    test("Second is the integer component on both", () =>
        assertBoth(p => capture(p, () => table(NoteWithDateEntity).orderBy(n => n.creationTime.second).toArray(), NoteWithDateEntity), {
            postgres: /ORDER BY FLOOR\(EXTRACT\(second from nwd\.creation_time\)\) ASC/i,
            sqlserver: /ORDER BY DATEPART\(second, NWD\.CreationTime\) ASC/i,
        }, "second"));

    test("Millisecond is the sub-second component on both", () =>
        assertBoth(p => capture(p, () => table(NoteWithDateEntity).orderBy(n => n.creationTime.millisecond).toArray(), NoteWithDateEntity), {
            postgres: /ORDER BY \(FLOOR\(EXTRACT\(milliseconds from nwd\.creation_time\)\) % 1000\) ASC/i,
            sqlserver: /ORDER BY DATEPART\(millisecond, NWD\.CreationTime\) ASC/i,
        }, "millisecond"));
});

describe("the Every N … steps (Signum's stepped DatePartStartToken)", () => {
    // "truncate the part, then shift back by its remainder". Signum's own SQL Server form counts the
    // part from year 0 (`DATEDIFF(part, 0, x) / step * step`, an `int` that a millisecond step
    // overflows) and its PostgreSQL branch drops the step entirely, answering the UNSTEPPED
    // truncation — so this deliberately is not a transcription of it.
    test("Every 6 Hours", () =>
        assertBoth(p => capture(p, () => table(NoteWithDateEntity).orderBy(n => n.creationTime.truncHours(6)).toArray(), NoteWithDateEntity), {
            postgres: /ORDER BY \(date_trunc\('hour', nwd\.creation_time\) - \(CAST\(\(FLOOR\(EXTRACT\(hour from nwd\.creation_time\)\) % 6\) AS int\) \* INTERVAL '1 hour'\)\) ASC/i,
            sqlserver: /ORDER BY DATEADD\(hour, \(0 - \(DATEPART\(hour, NWD\.CreationTime\) % 6\)\), DATETRUNC\(hour, NWD\.CreationTime\)\) ASC/i,
        }, "truncHours(6)"));

    test("Every 10 Minutes", () =>
        assertBoth(p => capture(p, () => table(NoteWithDateEntity).orderBy(n => n.creationTime.truncMinutes(10)).toArray(), NoteWithDateEntity), {
            postgres: /ORDER BY \(date_trunc\('minute', nwd\.creation_time\) - \(CAST\(\(FLOOR\(EXTRACT\(minute from nwd\.creation_time\)\) % 10\) AS int\) \* INTERVAL '1 minute'\)\) ASC/i,
            sqlserver: /ORDER BY DATEADD\(minute, \(0 - \(DATEPART\(minute, NWD\.CreationTime\) % 10\)\), DATETRUNC\(minute, NWD\.CreationTime\)\) ASC/i,
        }, "truncMinutes(10)"));

    test("Every 30 Seconds", () =>
        assertBoth(p => capture(p, () => table(NoteWithDateEntity).orderBy(n => n.creationTime.truncSeconds(30)).toArray(), NoteWithDateEntity), {
            postgres: /ORDER BY \(date_trunc\('second', nwd\.creation_time\) - \(CAST\(\(FLOOR\(EXTRACT\(second from nwd\.creation_time\)\) % 30\) AS int\) \* INTERVAL '1 second'\)\) ASC/i,
            sqlserver: /ORDER BY DATEADD\(second, \(0 - \(DATEPART\(second, NWD\.CreationTime\) % 30\)\), DATETRUNC\(second, NWD\.CreationTime\)\) ASC/i,
        }, "truncSeconds(30)"));

    // Every step Signum offers here (500 / 200 / 100) divides 1000, so PostgreSQL's whole-sub-minute
    // EXTRACT leaves the same remainder as the sub-second component would — the extra whole seconds
    // cancel in the modulo.
    test("Every 100 Milliseconds", () =>
        assertBoth(p => capture(p, () => table(NoteWithDateEntity).orderBy(n => n.creationTime.truncMilliseconds(100)).toArray(), NoteWithDateEntity), {
            postgres: /ORDER BY \(date_trunc\('millisecond', nwd\.creation_time\) - \(CAST\(\(FLOOR\(EXTRACT\(millisecond from nwd\.creation_time\)\) % 100\) AS int\) \* INTERVAL '1 millisecond'\)\) ASC/i,
            sqlserver: /ORDER BY DATEADD\(millisecond, \(0 - \(DATEPART\(millisecond, NWD\.CreationTime\) % 100\)\), DATETRUNC\(millisecond, NWD\.CreationTime\)\) ASC/i,
        }, "truncMilliseconds(100)"));

    // Without a step the same member is the plain HourStart token, unchanged by this port.
    test("no step is still the plain truncation", () =>
        assertBoth(p => capture(p, () => table(NoteWithDateEntity).orderBy(n => n.creationTime.truncHours()).toArray(), NoteWithDateEntity), {
            postgres: /ORDER BY date_trunc\('hour', nwd\.creation_time\) ASC/i,
            sqlserver: /ORDER BY DATETRUNC\(hour, NWD\.CreationTime\) ASC/i,
        }, "truncHours()"));

    // A step read off the ROW has no SQL form — the bucket size would vary per row. Saying so beats
    // "the method cannot be translated".
    test("a non-constant step is refused, saying why", async () => {
        for (const isPostgres of bothProviders)
            await assert.rejects(
                () => capture(isPostgres, () => table(NoteWithDateEntity).orderBy(n => n.creationTime.truncHours(n.title.length)).toArray(), NoteWithDateEntity),
                /CONSTANT number/,
                providerName(isPostgres));
    });

    // In memory the step floors the part, which is what Signum's `TruncHours(dt, step)` does.
    test("the in-memory body buckets the same way", () => {
        const t = Temporal.PlainDateTime.from("2026-09-18T13:45:12.789");
        assert.equal(t.truncHours(6).toString(), "2026-09-18T12:00:00");
        assert.equal(t.truncMinutes(10).toString(), "2026-09-18T13:40:00");
        assert.equal(t.truncSeconds(30).toString(), "2026-09-18T13:45:00");
        assert.equal(t.truncMilliseconds(100).toString(), "2026-09-18T13:45:12.7");
        assert.equal(t.truncHours().toString(), "2026-09-18T13:00:00");
    });
});

// Signum's TimeSpanProperties over a stored Duration column (`AlbumEntity_Song.duration`, a `time` on
// both providers). The `Total…` half is covered by durationExpression.test.ts; this is the COMPONENT
// half, which is a different question — `PT1H30M` has Minutes 30 but TotalMinutes 90.
describe("Duration components (Signum's TimeSpan.Hours / .Minutes / .Days)", () => {
    test("Hours and Minutes are a plain DATEPART over the time column", async () => {
        await assertBoth(p => capture(p, () => table(AlbumEntity_Song).orderBy(s => s.duration!.hours).toArray(), AlbumEntity_Song), {
            postgres: /ORDER BY EXTRACT\(hour from "as"\.duration\) ASC/i,
            sqlserver: /ORDER BY DATEPART\(hour, \[AS\]\.Duration\) ASC/i,
        }, "duration.hours");
        await assertBoth(p => capture(p, () => table(AlbumEntity_Song).orderBy(s => s.duration!.minutes).toArray(), AlbumEntity_Song), {
            postgres: /ORDER BY EXTRACT\(minute from "as"\.duration\) ASC/i,
            sqlserver: /ORDER BY DATEPART\(minute, \[AS\]\.Duration\) ASC/i,
        }, "duration.minutes");
    });

    test("Seconds and Milliseconds take the component correction too", async () => {
        await assertBoth(p => capture(p, () => table(AlbumEntity_Song).orderBy(s => s.duration!.seconds).toArray(), AlbumEntity_Song), {
            postgres: /ORDER BY FLOOR\(EXTRACT\(second from "as"\.duration\)\) ASC/i,
            sqlserver: /ORDER BY DATEPART\(second, \[AS\]\.Duration\) ASC/i,
        }, "duration.seconds");
        await assertBoth(p => capture(p, () => table(AlbumEntity_Song).orderBy(s => s.duration!.milliseconds).toArray(), AlbumEntity_Song), {
            postgres: /ORDER BY \(FLOOR\(EXTRACT\(milliseconds from "as"\.duration\)\) % 1000\) ASC/i,
            sqlserver: /ORDER BY DATEPART\(millisecond, \[AS\]\.Duration\) ASC/i,
        }, "duration.milliseconds");
    });

    // Signum's `TimeSpan.Days` is FLOOR of the total days, NOT a DATEPART — SQL Server refuses
    // `DATEPART(day, <time>)` outright ("the datepart day is not supported … for data type time").
    test("Days is the floor of the total days, not a DATEPART", () =>
        assertBoth(p => capture(p, () => table(AlbumEntity_Song).orderBy(s => s.duration!.days).toArray(), AlbumEntity_Song), {
            postgres: /ORDER BY floor\(\(EXTRACT\(EPOCH from \("as"\.duration - TIME '00:00:00'\)\) \/ 86400\)\) ASC/i,
            sqlserver: /ORDER BY FLOOR\(\(CAST\(DATEDIFF_BIG\(minute, CAST\('00:00:00' AS time\), \[AS\]\.Duration\) AS float\) \/ 1440\)\) ASC/i,
        }, "duration.days"));
});

// The token LIST and its captions. Every one of these captions used to be `capitalize(<member name>)`,
// an English literal that no culture could change and that the translation sync had no member to carry —
// so the assertion that matters is not the text but that the text IS the message's.
describe("the date sub-token list, and where its captions come from", () => {
    const O = SubTokensOptionsAll;
    const subTokens = (type: Type<Entity>, field: string) => new RootToken(type).subToken(field, O)!.subTokens(O);
    const keysOf = (type: Type<Entity>, field: string) => subTokens(type, field).map(t => t.key);
    const captionOf = (type: Type<Entity>, field: string, key: string) =>
        subTokens(type, field).single(t => t.key === key).toString();

    test("a PlainDateTime offers every part, the Starts, and one token per Every-N bucket", () => {
        const keys = keysOf(NoteWithDateEntity, "creationTime");
        for (const k of ["Year", "Quarter", "Month", "WeekNumber", "DayOfYear", "Day", "DayOfWeek",
            "Hour", "Minute", "Second", "Millisecond", "Date",
            "QuarterStart", "MonthStart", "WeekStart", "HourStart", "MinuteStart", "SecondStart"])
            assert.ok(keys.includes(k), `creationTime should offer ${k}`);
        // Signum's own bucket sizes, and the KEY carries the step (its `Name.Replace("0", step)`).
        for (const k of ["Every12Hours", "Every6Hours", "Every4Hours", "Every3Hours", "Every2Hours",
            "Every30Minutes", "Every20Minutes", "Every10Minutes", "Every5Minutes", "Every4Minutes",
            "Every3Minutes", "Every2Minutes", "Every30Seconds", "Every2Seconds",
            "Every500Milliseconds", "Every200Milliseconds", "Every100Milliseconds"])
            assert.ok(keys.includes(k), `creationTime should offer ${k}`);
        assert.equal(new Set(keys).size, keys.length, "no two tokens share a key");
    });

    // A DATE has nothing to truncate below the day, so Signum's DateOnlyProperties stops at WeekStart.
    test("a PlainDate offers the date parts only", () => {
        const keys = keysOf(NoteWithDateEntity, "creationDate");
        for (const k of ["Year", "Quarter", "Month", "WeekNumber", "DayOfYear", "Day", "DayOfWeek",
            "QuarterStart", "MonthStart", "WeekStart"])
            assert.ok(keys.includes(k), `creationDate should offer ${k}`);
        for (const k of ["Hour", "Minute", "Second", "Millisecond", "Date", "HourStart", "Every6Hours"])
            assert.ok(!keys.includes(k), `creationDate should NOT offer ${k}`);
    });

    // Signum's TimeSpanProperties: the components keep Temporal's PLURAL member names as their keys
    // (Signum's are the TimeSpan property names, which are plural too), the totals are their own tokens.
    test("a Duration offers the components and the totals", () => {
        const keys = keysOf(AlbumEntity_Song, "duration");
        for (const k of ["Days", "Hours", "Minutes", "Seconds", "Milliseconds",
            "TotalDays", "TotalHours", "TotalMinutes", "TotalSeconds", "TotalMilliseconds"])
            assert.ok(keys.includes(k), `duration should offer ${k}`);
        for (const k of ["Year", "Month", "Date", "MonthStart"])
            assert.ok(!keys.includes(k), `duration should NOT offer ${k}`);
    });

    // The caption is the MESSAGE's text, never the member name — which is what lets a culture change it.
    // The pairing is not always the obvious one: a Duration's `Hours` component is captioned by the
    // SINGULAR `Hour`, exactly as Signum captions `TimeSpan.Hours`.
    test("each caption is its QueryTokenDateMessage member's text", () => {
        for (const [key, member] of [
            ["Year", "Year"], ["Quarter", "Quarter"], ["Month", "Month"], ["WeekNumber", "WeekNumber"],
            ["DayOfYear", "DayOfYear"], ["Day", "Day"], ["DayOfWeek", "DayOfWeek"],
            ["Hour", "Hour"], ["Minute", "Minute"], ["Second", "Second"], ["Millisecond", "Millisecond"],
            ["Date", "Date"], ["MonthStart", "MonthStart"], ["HourStart", "HourStart"],
        ] as [string, keyof typeof QueryTokenDateMessage][])
            assert.equal(captionOf(NoteWithDateEntity, "creationTime", key),
                QueryTokenDateMessage[member].niceToString(), `the caption of ${key}`);

        for (const [key, member] of [
            ["Days", "Days"], ["Hours", "Hour"], ["Minutes", "Minute"], ["Seconds", "Second"],
            ["Milliseconds", "Millisecond"], ["TotalDays", "TotalDays"], ["TotalMinutes", "TotalMinutes"],
        ] as [string, keyof typeof QueryTokenDateMessage][])
            assert.equal(captionOf(AlbumEntity_Song, "duration", key),
                QueryTokenDateMessage[member].niceToString(), `the caption of ${key}`);
    });

    // The stepped ones take the step as {0}, which is the whole reason they are one message and not
    // seventeen.
    test("a stepped caption substitutes the step", () => {
        assert.equal(captionOf(NoteWithDateEntity, "creationTime", "Every6Hours"), "Every 6 Hours");
        assert.equal(captionOf(NoteWithDateEntity, "creationTime", "Every100Milliseconds"), "Every 100 Milliseconds");
    });
});
