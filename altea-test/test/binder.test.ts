import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { table } from "@altea/altea/logic/table";
import { QueryBinder } from "@altea/altea/logic/linq/queryBinder";
import {
    ProjectionExpression, SelectExpression, TableExpression, ColumnExpression,
} from "@altea/altea/logic/linq/expressions.sql";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { expressionSimplifier } from "@altea/altea/logic/linq/visitors/expressionSimplifier";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { Connector } from "@altea/altea/logic/connection/connector";
import { MusicLogic } from "../logic/MusicLogic";
import { AlbumEntity, LabelEntity, SongEmbedded } from "../entities/music";

// A connector that returns canned rows instead of hitting a database, so the
// full format→execute→project pipeline can be tested offline.
class FakeConnector extends Connector {
    constructor(schema: any, public rows: unknown[]) { super(schema, false, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve(this.rows); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

// Step-2 smoke test: the QueryBinder turns the source Expression AST into a
// DbExpression ProjectionExpression. Runs WITHOUT a database — binding only
// reads the schema (no SQL executes). Builds the Music schema once in-memory.

const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();

function bind(query: { expression: any }): ProjectionExpression {
    const simplified = expressionSimplifier()(query.expression);
    return new QueryBinder(sb.schema, false).bindQuery(simplified);
}

describe("QueryBinder (step 2)", () => {
    test("bare table → Projection over a Select over the Table", () => {
        const proj = bind(table(AlbumEntity));
        assert.ok(proj instanceof ProjectionExpression);
        assert.ok(proj.select instanceof SelectExpression);
        assert.ok(proj.select.from instanceof TableExpression);
        assert.ok(proj.select.columns.length > 0, "table projection should declare columns");
    });

    test("filter → SELECT with a WHERE", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.year < 1995));
        assert.ok(proj instanceof ProjectionExpression);
        assert.notEqual(proj.select.where, undefined, "filter should produce a WHERE");
        assert.ok(proj.select.columns.length > 0);
    });

    test("map to a scalar → single projected column", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.year < 1995).map(a => a.name));
        assert.ok(proj instanceof ProjectionExpression);
        assert.equal(proj.select.columns.length, 1, "scalar projection has exactly one column");
        assert.ok(proj.projector instanceof ColumnExpression, "projector reads one column back");
    });

    test("map to an object literal → one column per member", () => {
        const proj = bind(table(AlbumEntity).map(a => ({ y: a.year, n: a.name })));
        assert.ok(proj instanceof ProjectionExpression);
        assert.equal(proj.select.columns.length, 2);
    });
});

describe("QueryFormatter (step 3)", () => {
    test("filter + map renders SELECT/FROM/WHERE with a parameter", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.year < 1995).map(a => a.name));
        const { sql, parameters } = QueryFormatter.format(proj.select, false);
        assert.match(sql, /SELECT/i);
        assert.match(sql, /FROM/i);
        assert.match(sql, /WHERE/i);
        assert.match(sql, /< @p0/); // SQL Server placeholder for the captured 1995
        assert.deepEqual(parameters, [1995]);
    });

    test("postgres dialect uses $1 placeholders", () => {
        const proj = bind(table(AlbumEntity).filter(a => a.year < 1995));
        const { sql } = QueryFormatter.format(proj.select, true);
        assert.match(sql, /\$1/);
        assert.match(sql, /"/); // identifiers double-quoted on postgres
    });
});

describe("ProjectionReader end-to-end (step 3, fake connector)", () => {
    test("scalar projection maps rows to values", async () => {
        const q = table(AlbumEntity).map(a => a.name);
        const colName = bind(q).select.columns[0].name; // the SELECT alias for `name`
        const fake = new FakeConnector(sb.schema, [{ [colName]: "Siamese Dream" }, { [colName]: "Zeitgeist" }]);
        const result = await Connector.withConnector(fake, () => q.toArray());
        assert.deepEqual(result, ["Siamese Dream", "Zeitgeist"]);
    });

    test("object projection maps rows to objects", async () => {
        const q = table(AlbumEntity).map(a => ({ y: a.year, n: a.name }));
        const cols = bind(q).select.columns;
        const yKey = cols[0].name, nKey = cols[1].name;
        const fake = new FakeConnector(sb.schema, [{ [yKey]: 1993, [nKey]: "Siamese Dream" }]);
        const result = await Connector.withConnector(fake, () => q.toArray());
        assert.deepEqual(result, [{ y: 1993, n: "Siamese Dream" }]);
    });
});

describe("Entity materialisation (step 4, Retriever)", () => {
    // The SELECT alias for the entity's id column, from the bound projector.
    function idColumnName(q: { expression: any }): string {
        return (bind(q).projector as any).externalId.value.name;
    }

    test("whole-entity projection builds instances with a clean snapshot", async () => {
        const q = table(AlbumEntity);
        const proj = bind(q);
        const row: any = {};
        for (const c of proj.select.columns) row[c.name] = null; // null everything…
        row[idColumnName(q)] = 42;                               // …except the id
        const fake = new FakeConnector(sb.schema, [row]);

        const [album] = await Connector.withConnector(fake, () => q.toArray()) as AlbumEntity[];
        assert.ok(album instanceof AlbumEntity, "row materialises to an AlbumEntity");
        assert.equal(album.id, 42);
        assert.equal(album.isNew, false);
        assert.equal(album.isDirty(), false, "a freshly-retrieved entity is not dirty");
    });

    test("reference field → stub entity; nullable embedded honours hasValue", async () => {
        const q = table(AlbumEntity);
        const proj = bind(q);
        const row: any = {};
        for (const c of proj.select.columns) row[c.name] = 7; // non-null everywhere
        row[idColumnName(q)] = 1;
        const fake = new FakeConnector(sb.schema, [row]);

        const [album] = await Connector.withConnector(fake, () => q.toArray()) as AlbumEntity[];
        assert.ok(album.label instanceof LabelEntity, "FK column → a LabelEntity stub");
        assert.equal(album.label.id, 7);
        assert.ok(album.bonusTrack instanceof SongEmbedded, "truthy hasValue → embedded built");
    });
});
