import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { view, bindAndOptimize } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals";
import { reflect } from "@altea/altea/entities/reflection";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { tableName, viewPrimaryKey } from "@altea/altea/entities/decorators";
import { int } from "@altea/altea/entities/basics";
import { generateSubscripts, arrayGet, PostgresFunctions } from "@altea/altea/logic/sync/postgres/postgresFunctions";

// The PostgresFunctions "mini LINQ provider": generate_subscripts (a set-returning function
// source), array subscripting (arrayGet → arr[i]), and the scalar pg_get_expr /
// _pg_char_max_length. These let the Postgres catalog reader build DiffTable in the query (the
// way SQL Server does). Bound + formatted offline — we only check the emitted SQL shape.

@reflect
@tableName("pg_catalog.pg_constraint")
class PgConstraint {
    @viewPrimaryKey oid!: int;
    conrelid!: int;
    conkey!: number[];
    confkey!: number[];
}

@reflect
@tableName("pg_catalog.pg_attrdef")
class PgAttrDef {
    @viewPrimaryKey oid!: int;
    adrelid!: int;
    adbin!: string;
}

const sb = new SchemaBuilder();
sb.settings.isPostgres = true;
sb.complete();

function sqlPg(query: { expression: any }): string {
    const proj = bindAndOptimize(query.expression, sb.schema, true);
    return QueryFormatter.format(proj.select, true).sql;
}

describe("PostgresFunctions", () => {
    test("generate_subscripts is a CROSS JOIN LATERAL source", () => {
        const sql = sqlPg(view(PgConstraint).flatMap(fk => generateSubscripts(fk.conkey, 1).map(_i => fk.oid)));
        assert.match(sql, /generate_subscripts\(/i, "emits generate_subscripts");
        assert.match(sql, /CROSS JOIN LATERAL/i, "correlates as a lateral source");
    });

    test("arrayGet lowers to an array subscript arr[i]", () => {
        const sql = sqlPg(view(PgConstraint).flatMap(fk => generateSubscripts(fk.conkey, 1).map(i => arrayGet(fk.conkey, i))));
        assert.match(sql, /\)\[/, "emits an array subscript (...)[...]");
        assert.match(sql, /conkey/, "indexes the conkey column");
    });

    test("pg_get_expr scalar function", () => {
        const sql = sqlPg(view(PgAttrDef).map(d => PostgresFunctions.pg_get_expr(d.adbin, d.adrelid)));
        assert.match(sql, /pg_get_expr\(/, "emits pg_get_expr(...)");
    });

    test("_pg_char_max_length scalar function", () => {
        const sql = sqlPg(view(PgConstraint).map(c => PostgresFunctions._pg_char_max_length(c.oid, c.conrelid)));
        assert.match(sql, /information_schema\._pg_char_max_length\(/, "emits the schema-qualified function");
    });
});
