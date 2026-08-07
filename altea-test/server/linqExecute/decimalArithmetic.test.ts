import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/server"; // installs the Decimal.* __resultType metadata (server/decimalFunctions) + table methods
import "@altea/altea/data/globals";
import { table, bindAndOptimize } from "@altea/altea/server/table";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import type { ProjectionExpression } from "@altea/altea/server/linq/expressions.sql";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { Connector } from "@altea/altea/server/connection/connector";
import { MusicLogic } from "../MusicLogic";
import { AlbumEntity } from "../../data/music";
import { inSql, Decimal } from "@altea/altea/data/basics";
import { hasDb, start } from "../setup";

// Exercises the decimal.js `Decimal.*` static arithmetic in queries — the SQL the nominator generates
// (both dialects, offline) AND the runtime values (live). The contrast is the point: the plain-`number`
// path is float / integer division, while `Decimal.*` runs exact decimal arithmetic in SQL and
// materialises a `Decimal`. `inSql(...)` forces the subtree into SQL (a projected operator would
// otherwise be evaluated client-side by the lazy projector).

// A no-DB connector so binding + formatting run offline (mirrors binder.test.ts).
class FakeConnector extends Connector {
    constructor(schema: any, isPostgres = false) { super(schema, isPostgres, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

function makeSqlGen(isPostgres: boolean): (q: { expression: any }) => string {
    const sb = new SchemaBuilder();
    sb.settings.isPostgres = isPostgres;
    MusicLogic.start(sb);
    sb.complete();
    const fake = new FakeConnector(sb.schema, isPostgres);
    return (q) => Connector.withConnector(fake, () => {
        const proj = bindAndOptimize(q.expression, sb.schema, isPostgres) as ProjectionExpression;
        return QueryFormatter.format(proj.select, isPostgres).sql.replace(/\s+/g, " ").toLowerCase();
    });
}

describe("Decimal arithmetic — SQL generation", () => {
    for (const isPostgres of [true, false]) {
        const dialect = isPostgres ? "postgres" : "sqlserver";
        const numeric = isPostgres ? "numeric" : "decimal";
        const sql = makeSqlGen(isPostgres);

        describe(dialect, () => {
            test("binary ops lower to the SQL operators, cast to " + numeric, () => {
                // constants are parameterised (@p0 / @0), so match the operator + the outer numeric cast
                assert.match(sql(table(AlbumEntity).map(a => inSql(Decimal.add(a.year, 10)))), new RegExp(`cast\\(\\(.*\\+.*\\) as ${numeric}\\)`));
                assert.match(sql(table(AlbumEntity).map(a => inSql(Decimal.sub(a.year, 10)))), new RegExp(`cast\\(\\(.*-.*\\) as ${numeric}\\)`));
                assert.match(sql(table(AlbumEntity).map(a => inSql(Decimal.mul(a.year, 2)))), new RegExp(`cast\\(\\(.*\\*.*\\) as ${numeric}\\)`));
                assert.match(sql(table(AlbumEntity).map(a => inSql(Decimal.mod(a.year, 7)))), new RegExp(`cast\\(\\(.*%.*\\) as ${numeric}\\)`));
            });

            test("div casts the dividend so it is DECIMAL (not integer) division", () => {
                const s = sql(table(AlbumEntity).map(a => inSql(Decimal.div(a.year, 100))));
                // dividend cast to numeric, THEN divided → real division that keeps the fraction
                assert.match(s, new RegExp(`cast\\(.*as ${numeric}\\) /`));
            });

            test("scalar functions lower to their SQL function", () => {
                assert.match(sql(table(AlbumEntity).map(a => inSql(Decimal.abs(a.year)))), /abs\(/);
                assert.match(sql(table(AlbumEntity).map(a => inSql(Decimal.round(a.year)))), /round\(/);
                assert.match(sql(table(AlbumEntity).map(a => inSql(Decimal.max(a.year, 100)))), /greatest\(/);
                assert.match(sql(table(AlbumEntity).map(a => inSql(Decimal.min(a.year, 100)))), /least\(/);
            });

            test("the plain-number path is NOT cast to decimal (contrast)", () => {
                const s = sql(table(AlbumEntity).map(a => inSql((a.year as number) / 100)));
                assert.doesNotMatch(s, new RegExp(`cast\\(.*as ${numeric}\\)`));
            });
        });
    }
});

describe("Decimal arithmetic — execution", { skip: !hasDb }, () => {
    before(async () => { await start(); });

    test("Decimal.div runs decimal division and materialises a Decimal (vs integer division)", async () => {
        const decimals = await table(AlbumEntity).map(a => inSql(Decimal.div(a.year, 100))).toArray();
        assert.ok(decimals.length > 0);
        assert.ok(decimals.every(d => d instanceof Decimal), "each result is a Decimal");
        assert.ok(decimals.some(d => !d.mod(1).isZero()), "decimal division keeps the fraction (e.g. 1993/100 = 19.93)");

        // the plain-number path: forced into SQL, int/int truncates
        const numbers = await table(AlbumEntity).map(a => inSql((a.year as number) / 100)).toArray();
        assert.ok(numbers.every(n => typeof n === "number" && Number.isInteger(n)), "SQL integer division truncates");
    });

    test("Decimal.add / mul are exact and typed Decimal", async () => {
        const rows = await table(AlbumEntity).map(a => ({ y: a.year, sum: inSql(Decimal.add(a.year, a.year)), prod: inSql(Decimal.mul(a.year, 2)) })).toArray();
        assert.ok(rows.length > 0);
        assert.ok(rows.every(r => r.sum instanceof Decimal && r.prod instanceof Decimal));
        assert.ok(rows.every(r => r.sum.eq(new Decimal(r.y).mul(2)) && r.prod.eq(new Decimal(r.y).mul(2))));
    });

    test("Decimal.sub / mod compute exactly in SQL", async () => {
        const rows = await table(AlbumEntity).map(a => ({ y: a.year, diff: inSql(Decimal.sub(a.year, 3)), rem: inSql(Decimal.mod(a.year, 7)) })).toArray();
        assert.ok(rows.every(r => r.diff instanceof Decimal && r.diff.eq(new Decimal(r.y).minus(3))));
        assert.ok(rows.every(r => r.rem instanceof Decimal && r.rem.eq(new Decimal(r.y).mod(7))));
    });
});
