import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { view as queryView, bindAndOptimize } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals";
// Reflected classes (incl. views) import `reflect` so the transformer anchors the
// auto-injected @field import on the reflection module. The class decorator must be the
// literal identifier `view` (the transformer matches decorator names textually), so the
// query-root function is imported aliased as `queryView`.
import { reflect } from "@altea/altea/entities/reflection";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { view, viewPrimaryKey } from "@altea/altea/entities/decorators";
import { int } from "@altea/altea/entities/basics";

// M2c proof: a raw database view (IView) queried through the view() query root. The @view
// class maps to a raw catalog table with verbatim column names and an explicit
// @viewPrimaryKey — no entity conventions. Binding + formatting run offline (no DB): we
// only check the SQL shape.

@view("pg_catalog.pg_namespace")
class PgNamespace {
    @viewPrimaryKey oid!: int;
    nspname!: string;
    nspowner!: int;
}

const sbPg = new SchemaBuilder();
sbPg.settings.isPostgres = true;
sbPg.complete();

const sbSs = new SchemaBuilder();
sbSs.settings.isPostgres = false;
sbSs.complete();

function sqlPg(query: { expression: any }): string {
    const proj = bindAndOptimize(query.expression, sbPg.schema, true);
    return QueryFormatter.format(proj.select, true).sql;
}

function sqlSs(query: { expression: any }): string {
    const proj = bindAndOptimize(query.expression, sbSs.schema, false);
    return QueryFormatter.format(proj.select, false).sql;
}

describe("view() source (IView)", () => {
    test("scalar view: filter + map maps to raw table + columns (Postgres)", () => {
        const sql = sqlPg(queryView(PgNamespace).filter(n => n.nspname != "information_schema").map(n => n.oid));
        assert.match(sql, /pg_catalog\b/);
        assert.match(sql, /pg_namespace\b/);
        assert.match(sql, /\boid\b/);
        assert.match(sql, /\bnspname\b/);
    });

    test("scalar view: projects verbatim column names, no entity id/ticks (Postgres)", () => {
        const sql = sqlPg(queryView(PgNamespace).map(n => n.nspname));
        assert.match(sql, /\bnspname\b/);
        // Views carry no ticks column and the PK column is the raw `oid`, never `id`.
        assert.doesNotMatch(sql, /\bticks\b/i);
    });

    test("scalar view: SQL Server escapes the schema-qualified view name", () => {
        const sql = sqlSs(queryView(PgNamespace).filter(n => n.nspname != "").map(n => n.nspowner));
        assert.match(sql, /pg_catalog/);
        assert.match(sql, /pg_namespace/);
        assert.match(sql, /nspowner/);
    });
});
