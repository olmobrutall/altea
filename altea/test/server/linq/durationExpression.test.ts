import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import type { Schema } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { OperationLogEntity } from "@altea/altea/data/operationLog";
import { Temporal } from "@altea/altea/data/basics";
import type { Entity, Type } from "@altea/altea/data/entity";
import { AlbumEntity_Song } from "../../data/album";

// Temporal's own unit type — every spelling it accepts, singular and plural, which is exactly the set
// this suite has to cover.
type TotalUnit = Temporal.TotalUnit<Temporal.DateTimeUnit>;

// `OperationLogEntity.durationMilliseconds()` — the port of Signum's
// `[ExpressionField("DurationExpression"), Unit("ms")] public double? Duration` (End - Start), which
// OperationLogic exposes as the `Duration` query token — and, below it, the whole
// `since()/until().total(unit)` lowering those columns run through (DbExpressionNominator's
// translateDurationMethod, the port of Signum's TrySqlDifference).
//
// The point of the suite is that the member is a real SQL COLUMN and not an in-memory read: a `@quoted`
// body that cannot be lowered fails at QUERY time, not at compile time, so only the generated statement
// proves it. The assertions are over ORDER BY and WHERE rather than a bare projection, because those are
// the FULL-TRANSLATE contexts — inside a plain `.map()` the provider may select the two operands and let
// the reader divide them client-side (CLIENT_PROJECTOR_OPS in DbExpressionNominator), which would pass
// while proving nothing. They are also exactly what a search page does with the token.
//
// Offline: the SQL is captured off a fake connector, so nothing here needs the test database (which has
// no operation_log table) and neither dialect is skipped.
class CapturingConnector extends Connector {
    readonly captured: string[] = [];
    constructor(schema: Schema, isPostgres: boolean) { super(schema, isPostgres, 128); }
    override executeQuery(sql: string): Promise<unknown[]> { this.captured.push(sql); return Promise.resolve([]); }
    openConnection(): Promise<never> { throw new Error("no DB in this offline test"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

// Runs `query` against a fake connector and hands back the LAST statement it issued — the schema's own
// bootstrap probe ("does basics.type exist") comes first and is not what is under test. SQL_DUMP=1 prints
// it, the same switch the LINQ suites use.
async function capture(isPostgres: boolean, query: () => Promise<unknown>, include: Type<Entity> = OperationLogEntity): Promise<string> {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = isPostgres;
    sb.include(include);
    const connector = new CapturingConnector(sb.schema, isPostgres);
    await Connector.withConnector(connector, query);
    assert.ok(connector.captured.length > 0, "a statement was issued");
    const last = connector.captured[connector.captured.length - 1]!;
    if (process.env.SQL_DUMP === "1")
        console.log(`-- ${isPostgres ? "postgres" : "sqlserver"}\n${last}\n`);
    return last;
}

const orderByDuration = (isPostgres: boolean): Promise<string> =>
    capture(isPostgres, () => table(OperationLogEntity).orderBy(o => o.durationMilliseconds()).toArray());

const filterByDuration = (isPostgres: boolean): Promise<string> =>
    capture(isPostgres, () => table(OperationLogEntity).filter(o => o.durationMilliseconds()! > 1000).toArray());

// `unit` is a captured variable, so the same body serves every unit: the binder folds it into the
// constant the nominator reads. `since` and `until` are mirrors of each other — `end.since(start)` and
// `start.until(end)` are both `end - start` — so both helpers must emit the SAME statement.
const orderBySince = (isPostgres: boolean, unit: TotalUnit): Promise<string> =>
    capture(isPostgres, () => table(OperationLogEntity).orderBy(o => o.end!.since(o.start).total({ unit: unit })).toArray());

const orderByUntil = (isPostgres: boolean, unit: TotalUnit): Promise<string> =>
    capture(isPostgres, () => table(OperationLogEntity).orderBy(o => o.start.until(o.end!).total({ unit: unit })).toArray());

async function rejects(isPostgres: boolean, query: () => Promise<string>): Promise<string> {
    try {
        await query();
    } catch (e) {
        return (e as Error).message;
    }
    throw new assert.AssertionError({ message: `expected the ${isPostgres ? "postgres" : "sqlserver"} translation to be refused` });
}

const bothProviders = [true, false];
const providerName = (isPostgres: boolean): string => isPostgres ? "postgres: " : "sqlserver: ";

describe("OperationLogEntity.durationMilliseconds (Signum's Duration)", () => {
    // Postgres has no DATEDIFF: the nominator subtracts the two timestamps and divides the epoch seconds
    // by the unit's own length (0.001 s for a millisecond) — DbExpressionNominator.translateDurationMethod.
    test("orders in SQL, as EXTRACT(EPOCH …) — postgres", async () => {
        const sql = await orderByDuration(true);
        assert.match(sql, /ORDER BY/i);
        assert.match(sql, /EXTRACT\(EPOCH/i, "the difference reaches SQL");
        assert.match(sql, /0\.001/, "epoch seconds divided into milliseconds");
        assert.doesNotMatch(sql, /__timespan__/, "the since() marker must never survive into SQL");
    });

    test("orders in SQL, as DATEDIFF_BIG(millisecond, …) — sqlserver", async () => {
        const sql = await orderByDuration(false);
        assert.match(sql, /ORDER BY/i);
        assert.match(sql, /CAST\(DATEDIFF_BIG\(millisecond, [^)]+\) AS float\)/i);
        assert.doesNotMatch(sql, /__timespan__/);
    });

    // `end` is nullable, so the body is a ternary and it must stay a CASE WHEN in SQL. Without the guard
    // the difference would be taken against NULL and a still-running operation would read as some number
    // instead of as "unknown".
    test("the null guard on `end` is a CASE WHEN in the filter", async () => {
        for (const isPostgres of bothProviders) {
            const sql = await filterByDuration(isPostgres);
            const where = providerName(isPostgres);
            assert.match(sql, /WHERE/i, where + "the predicate reaches SQL");
            assert.match(sql, /CASE\s+WHEN/i, where + "nullable end → CASE");
            assert.match(sql, /IS NOT NULL/i, where + "the guard itself");
            assert.doesNotMatch(sql, /__timespan__/, where + "no marker in SQL");
        }
    });
});

// The five units Signum's TrySqlDifference accepts, and the statement each must produce.
//
// The SQL Server column is the one that matters: DATEDIFF counts BOUNDARIES CROSSED, so
// `DATEDIFF(hour, '01:59', '02:01')` is 1 where `.total({ unit: "hours" })` must be 0.0333. Every unit
// therefore asks for a FINER part and divides — which is why the assertion is on the part asked for, not
// just on "a DATEDIFF appeared". The CAST to float is load-bearing too: without it `… / 60` would be
// integer division on SQL Server.
const UNITS: { unit: TotalUnit; postgres: RegExp; sqlserver: RegExp }[] = [
    { unit: "days", postgres: /EXTRACT\(EPOCH from \([^)]+\)\) \/ 86400/i, sqlserver: /CAST\(DATEDIFF_BIG\(minute, [^)]+\) AS float\) \/ 1440/i },
    { unit: "hours", postgres: /EXTRACT\(EPOCH from \([^)]+\)\) \/ 3600/i, sqlserver: /CAST\(DATEDIFF_BIG\(minute, [^)]+\) AS float\) \/ 60/i },
    { unit: "minutes", postgres: /EXTRACT\(EPOCH from \([^)]+\)\) \/ 60/i, sqlserver: /CAST\(DATEDIFF_BIG\(second, [^)]+\) AS float\) \/ 60/i },
    { unit: "seconds", postgres: /EXTRACT\(EPOCH from \([^)]+\)\) \/ 1\b/i, sqlserver: /CAST\(DATEDIFF_BIG\(millisecond, [^)]+\) AS float\) \/ 1000/i },
    { unit: "milliseconds", postgres: /EXTRACT\(EPOCH from \([^)]+\)\) \/ 0\.001/i, sqlserver: /CAST\(DATEDIFF_BIG\(millisecond, [^)]+\) AS float\)/i },
];

describe("since()/until().total(unit) — the port of Signum's TrySqlDifference", () => {
    for (const { unit, postgres, sqlserver } of UNITS) {
        test(`total({ unit: "${unit}" }) lowers on both providers`, async () => {
            for (const isPostgres of bothProviders) {
                const expected = isPostgres ? postgres : sqlserver;
                const where = `${providerName(isPostgres)}${unit}: `;
                const since = await orderBySince(isPostgres, unit);
                assert.match(since, /ORDER BY/i, where + "the difference reaches SQL");
                assert.match(since, expected, where + "the requested unit is taken from a finer DATEDIFF part / the epoch");
                assert.doesNotMatch(since, /__timespan__/, where + "no marker in SQL");
                // `start.until(end)` is `end.since(start)`: the same statement, operands swapped back.
                assert.equal(await orderByUntil(isPostgres, unit), since, where + "until() mirrors since()");
            }
        });

        // Temporal takes the singular and the plural interchangeably, and `CaseActivityEntity
        // .durationRealTime()` is written with the singular. It used to resolve to `undefined`, which
        // silently meant "not translatable".
        test(`the SINGULAR "${unit.replace(/s$/, "")}" lowers identically`, async () => {
            for (const isPostgres of bothProviders) {
                assert.equal(
                    await orderBySince(isPostgres, unit.replace(/s$/, "") as TotalUnit),
                    await orderBySince(isPostgres, unit),
                    providerName(isPostgres) + "singular and plural are the same unit");
            }
        });
    }

    // The bare-string overload, Temporal's other spelling of the same argument.
    test(`total("seconds") — the bare-string overload — lowers too`, async () => {
        for (const isPostgres of bothProviders) {
            const sql = await capture(isPostgres, () => table(OperationLogEntity).orderBy(o => o.end!.since(o.start).total("seconds")).toArray());
            assert.match(sql, isPostgres ? UNITS[3]!.postgres : UNITS[3]!.sqlserver, providerName(isPostgres));
        }
    });

    // `{ largestUnit }` only decides how the Duration is BALANCED into components, so it cannot change
    // what total() answers — this is the shape `CaseActivityEntity.durationRealTime()` is written in.
    test("until(other, { largestUnit }) is accepted and ignored", async () => {
        for (const isPostgres of bothProviders) {
            const sql = await capture(isPostgres, () => table(OperationLogEntity)
                .orderBy(o => o.start.until(o.end!, { largestUnit: "minute" }).total({ unit: "minute" })).toArray());
            assert.equal(sql, await orderByUntil(isPostgres, "minutes"), providerName(isPostgres) + "largestUnit changes nothing");
        }
    });
});

// Everything this function cannot lower must say WHICH unit and over WHICH difference, rather than
// returning undefined and surfacing two frames up as "The method 'total' cannot be translated to SQL".
describe("since()/until().total(unit) — what it refuses, and how loudly", () => {
    // Signum's switch rejects the calendar units outright: Postgres would divide epoch seconds by an
    // AVERAGE year while SQL Server counts calendar boundaries, so the two providers would disagree by
    // design. Rejecting is the behaviour; being told why is the point.
    for (const unit of ["years", "months", "weeks"] as TotalUnit[]) {
        test(`the calendar unit "${unit}" is refused, naming it`, async () => {
            for (const isPostgres of bothProviders) {
                const message = await rejects(isPostgres, () => orderBySince(isPostgres, unit));
                const where = providerName(isPostgres);
                assert.match(message, new RegExp(`"${unit}"`), where + "the message names the unit");
                assert.match(message, /CALENDAR unit/, where + "and why it is not a rounding difference");
                assert.match(message, /the difference \S+end\S* - \S+start/i, where + "and the difference it was asked over");
            }
        });
    }

    test("an unknown unit is refused, naming it and the ones that work", async () => {
        for (const isPostgres of bothProviders) {
            const message = await rejects(isPostgres, () => orderBySince(isPostgres, "microseconds"));
            assert.match(message, /"microseconds"/, providerName(isPostgres) + "the message names the unit");
            assert.match(message, /days, hours, minutes, seconds, milliseconds/, providerName(isPostgres) + "and the supported set");
        }
    });

    // `smallestUnit` ROUNDS the difference, so dropping it would answer a different number than the same
    // body evaluated in memory. `largestUnit` (above) is the only option that cannot.
    test("a rounding option on since()/until() is refused rather than dropped", async () => {
        for (const isPostgres of bothProviders) {
            const message = await rejects(isPostgres, () => capture(isPostgres, () => table(OperationLogEntity)
                .orderBy(o => o.start.until(o.end!, { smallestUnit: "hour" }).total({ unit: "minutes" })).toArray()));
            assert.match(message, /smallestUnit/, providerName(isPostgres) + "the message names the option");
        }
    });

    // A STORED Duration column is not a difference, so there is nothing to DATEDIFF — Signum's
    // TrySqlDifference walks the expression looking for a subtraction and gives up the same way.
    // AlbumEntity_Song.duration is such a column, and the message has to say which shape is missing
    // rather than leave the reader thinking total() is unimplemented.
    test("total() over a STORED Duration column says which shape is missing", async () => {
        for (const isPostgres of bothProviders) {
            const message = await rejects(isPostgres, () => capture(isPostgres, () => table(AlbumEntity_Song)
                .orderBy(s => s.duration!.total({ unit: "minutes" })).toArray(), AlbumEntity_Song));
            assert.match(message, /since\(\)\/until\(\) difference/, providerName(isPostgres) + "the message names the shape it needs");
        }
    });
});
