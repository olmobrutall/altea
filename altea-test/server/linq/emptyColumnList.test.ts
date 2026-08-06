import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { SelectExpression, ColumnExpression } from "@altea/altea/server/linq/expressions.sql";
import { Alias } from "@altea/altea/server/linq/aliasGenerator";
import { LiteralType } from "@altea/altea/server/runtimeTypes";

// Regression: an empty SELECT column list (every column pruned by UnusedColumnRemover — e.g. a
// `COUNT(*)` over a grouped subquery references none of the subquery's columns) must render as
// Signum's `0 AS Dummy`, NEVER a bare `SELECT *`. A `SELECT *` over a GROUP BY is illegal
// ("column must appear in the GROUP BY clause"), which broke "group by this column" pagination.
describe("empty SELECT column list", () => {
    for (const isPostgres of [true, false]) {
        test(`renders '0 AS Dummy' (not '*') over a GROUP BY — ${isPostgres ? "postgres" : "sqlserver"}`, () => {
            const alias = Alias.named("s0", isPostgres);
            const keyCol = new ColumnExpression(LiteralType.number, alias, "x");
            // A grouped select whose column list has been fully pruned (empty), still grouping by a key.
            const select = new SelectExpression(alias, false, undefined, [], undefined, undefined, [], [keyCol]);

            const sql = QueryFormatter.format(select, isPostgres).sql;

            assert.match(sql, /0 AS Dummy/, "empty column list should render as '0 AS Dummy'");
            assert.doesNotMatch(sql, /SELECT\s+\*/, "must not emit a bare 'SELECT *'");
            assert.match(sql, /GROUP BY/, "the GROUP BY is preserved");
        });
    }
});
