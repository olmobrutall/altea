import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import type { Schema } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import { CultureInfoEntity, CultureInfoMessage } from "@altea/altea/data/cultureInfoEntity";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import "@altea/altea/server/dynamicQuery/tokenExpressions";

// `CultureInfoEntity.isNeutral()` — the port of Signum's `IsNeutral => !Name.Contains("-")`, which
// CultureInfoLogic exposes as the `IsNeutral` query token.
//
// The point of the suite is durationExpression's beside it: a @quoted body that cannot be lowered fails
// at QUERY time, not at compile time, so only the generated statement proves the member is a real SQL
// predicate rather than an in-memory read. WHERE and ORDER BY are the FULL-TRANSLATE contexts — inside a
// plain `.map()` the provider may select `name` and evaluate the predicate client-side, which would pass
// while proving nothing — and they are what a search page does with the token.
//
// Offline: the SQL is captured off a fake connector, so nothing here needs the test database.
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
async function capture(isPostgres: boolean, query: () => Promise<unknown>): Promise<string> {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = isPostgres;
    sb.include(CultureInfoEntity);
    const connector = new CapturingConnector(sb.schema, isPostgres);
    await Connector.withConnector(connector, query);
    assert.ok(connector.captured.length > 0, "a statement was issued");
    const last = connector.captured[connector.captured.length - 1]!;
    if (process.env.SQL_DUMP === "1")
        console.log(`-- ${isPostgres ? "postgres" : "sqlserver"}\n${last}\n`);
    return last;
}

const bothProviders = [true, false];
const providerName = (isPostgres: boolean): string => isPostgres ? "postgres: " : "sqlserver: ";

// `name.includes("-")` is a string CONTAINS, which the nominator lowers to a position function rather
// than to a LIKE (the LIKE path is the explicit `.like(pattern)`): `strpos(haystack, needle) >= 1` on
// PostgreSQL, `CHARINDEX(needle, haystack) >= 1` on SQL Server. The dash is a PARAMETER, not inlined.
const CONTAINS_DASH = (isPostgres: boolean): RegExp => isPostgres
    ? /strpos\(\w+\.name, \$\d+\) >= 1/i
    : /CHARINDEX\(@\w+, \w+\.name\) >= 1/i;

describe("CultureInfoEntity.isNeutral (Signum's IsNeutral)", () => {
    test("filters in SQL, as a negated CONTAINS over `name`", async () => {
        for (const isPostgres of bothProviders) {
            const sql = await capture(isPostgres, () => table(CultureInfoEntity).filter(c => c.isNeutral()).toArray());
            const where = providerName(isPostgres);
            assert.match(sql, /WHERE/i, where + "the predicate reaches SQL");
            assert.match(sql, CONTAINS_DASH(isPostgres), where + "includes('-') is a position function");
            assert.match(sql, /NOT\s*\(/i, where + "the ! of !includes()");
        }
    });

    // The mirror a search page issues for `IsNeutral = false` — a region-specific culture ("es-AR").
    // The comparison must survive: collapsing it would invert the filter. PostgreSQL compares two
    // booleans; SQL Server, having no boolean type, compares the CASE's bit against the 0 literal.
    test("filtering for NOT neutral reaches SQL too", async () => {
        for (const isPostgres of bothProviders) {
            const sql = await capture(isPostgres, () => table(CultureInfoEntity).filter(c => c.isNeutral() === false).toArray());
            const where = providerName(isPostgres);
            assert.match(sql, /WHERE/i, where + "the predicate reaches SQL");
            assert.match(sql, CONTAINS_DASH(isPostgres), where);
            assert.match(sql, isPostgres ? /\) = \$\d+\)/ : /END = 0\)/, where + "compared, not collapsed");
        }
    });

    // ORDER BY is a VALUE position, not a predicate. PostgreSQL has a real boolean type and takes the
    // comparison as it stands; SQL Server has none, so the ConditionsRewriter wraps it in a CASE.
    test("orders in SQL — a bare boolean on postgres, a CASE on sqlserver", async () => {
        for (const isPostgres of bothProviders) {
            const sql = await capture(isPostgres, () => table(CultureInfoEntity).orderBy(c => c.isNeutral()).toArray());
            const where = providerName(isPostgres);
            assert.match(sql, /ORDER BY/i, where + "the expression reaches SQL");
            assert.match(sql, CONTAINS_DASH(isPostgres), where);
            if (isPostgres)
                assert.doesNotMatch(sql, /CASE\s+WHEN/i, where + "a native boolean needs no CASE");
            else
                assert.match(sql, /CASE\s+WHEN/i, where + "no boolean type — a CASE");
        }
    });
});

// The registration itself — without it the predicate above is reachable only from handwritten server
// code, and a culture search can neither filter nor column by it, which is the one reason the member is
// kept at all.
describe("the IsNeutral token", () => {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = false;
    CultureInfoLogic.start(sb);

    test("is a sub-token of a CultureInfoEntity query", () => {
        const keys = new RootToken(CultureInfoEntity).subTokens(SubTokensOptionsAll).map(t => t.key);
        assert.ok(keys.includes("IsNeutral"), `IsNeutral is offered: ${keys.join(", ")}`);
    });

    // Its caption is `CultureInfoMessage.IsNeutral`, the only member a translation can land on.
    test("captions itself from CultureInfoMessage, not from the member name", () => {
        const token = new RootToken(CultureInfoEntity).subTokens(SubTokensOptionsAll).find(t => t.key === "IsNeutral");
        assert.ok(token != null, "the token is registered");
        assert.equal(token.niceName(), CultureInfoMessage.IsNeutral.niceToString());
    });
});
