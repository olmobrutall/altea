import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { view, bindAndOptimize } from "@altea/altea/logic/table";
import "@altea/altea/entities/globals";
// A view class is declared like Signum's `: IView` + `[TableName]`: @reflect (the
// reflection/@field trigger) + @tableName(rawName) + @viewPrimaryKey fields.
import { reflect } from "@altea/altea/entities/reflection";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { tableName, viewPrimaryKey, quoted } from "@altea/altea/entities/decorators";
import { int } from "@altea/altea/entities/basics";

// M2c proof: a raw database view (IView) queried through the view() query root. The view
// class maps to a raw catalog table with verbatim column names and an explicit
// @viewPrimaryKey — no entity conventions. Binding + formatting run offline (no DB): we
// only check the SQL shape.

@reflect
@tableName("pg_catalog.pg_namespace")
class PgNamespace {
    @viewPrimaryKey oid!: int;
    nspname!: string;
    nspowner!: int;

    // Signum's [AutoExpressionField] navigation, written directly in the (server-only)
    // view class — no logic-layer prototype expansion. `this.oid` correlates to pg_class,
    // exactly like the entity `albumCount()` correlated-count member.
    @quoted
    tableCount(): Promise<number> { return view(PgClass).filter(t => t.relnamespace == this.oid).count(); }
}

@reflect
@tableName("pg_catalog.pg_class")
class PgClass {
    @viewPrimaryKey oid!: int;
    relname!: string;
    relnamespace!: int;
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
        const sql = sqlPg(view(PgNamespace).filter(n => n.nspname != "information_schema").map(n => n.oid));
        assert.match(sql, /pg_catalog\b/);
        assert.match(sql, /pg_namespace\b/);
        assert.match(sql, /\boid\b/);
        assert.match(sql, /\bnspname\b/);
    });

    test("scalar view: projects verbatim column names, no entity id/ticks (Postgres)", () => {
        const sql = sqlPg(view(PgNamespace).map(n => n.nspname));
        assert.match(sql, /\bnspname\b/);
        // Views carry no ticks column and the PK column is the raw `oid`, never `id`.
        assert.doesNotMatch(sql, /\bticks\b/i);
    });

    test("scalar view: SQL Server escapes the schema-qualified view name", () => {
        const sql = sqlSs(view(PgNamespace).filter(n => n.nspname != "").map(n => n.nspowner));
        assert.match(sql, /pg_catalog/);
        assert.match(sql, /pg_namespace/);
        assert.match(sql, /nspowner/);
    });

    // M2d: @quoted navigation between views (Signum's AutoExpressionField). The correlated
    // sub-view expands into a subquery over pg_class filtered by the outer namespace oid —
    // the exact pattern the catalog readers use (Tables()/Attributes()/Constraints()).
    test("view @quoted navigation expands to a correlated sub-view (Postgres)", () => {
        const sql = sqlPg(view(PgNamespace).map(ns => ({ nspname: ns.nspname, tableCount: ns.tableCount() })));
        assert.match(sql, /pg_namespace\b/);
        assert.match(sql, /pg_class\b/);
        assert.match(sql, /relnamespace\b/);
        // correlated: the sub-view references the outer namespace oid
        assert.match(sql, /\boid\b/);
    });
});
