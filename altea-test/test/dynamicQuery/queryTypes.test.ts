import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { reflect } from "@altea/altea/entities/reflection";
import { ModelEntity } from "@altea/altea/entities/entity";
import { type int, toInt } from "@altea/altea/entities/basics";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { AutoDynamicQueryCore, ManualDynamicQueryCore } from "@altea/altea/server/dynamicQuery/dynamicQueryCore";
import { SubTokensOptionsAll } from "@altea/altea/entities/dynamicQuery/tokens/queryToken";
import { ResultTable, ResultColumn } from "@altea/altea/server/dynamicQuery/resultTable";
import { Column, QueryRequest, Pagination } from "@altea/altea/server/dynamicQuery/requests";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../../logic/MusicLogic";
import { AlbumEntity } from "../../entities/music";

// Query flavors beyond the plain WithQuery (Type 1). Type 2 = a manually-registered Query<T> factory
// that filters/joins/projects (still LINQ-translated, still auto metadata from reflection). Type 3 =
// a manual imperative `request → ResultTable` core. Both register into QueryLogic.queries.

const O = SubTokensOptionsAll;
const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();

// A SQL-capturing fake connector (records the last executed SQL, returns no rows).
class FakeConnector extends Connector {
    lastSql = "";
    constructor() { super(sb.schema, false, 128); }
    override executeQuery(sql: string): Promise<unknown[]> { this.lastSql = sql.toLowerCase(); return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}
const fake = new FakeConnector();

// ---- Type 2: a filtered full-entity query (manually registered) ---------------------------------
const RECENT = "RecentAlbums";
QueryLogic.queries.register(RECENT, () => new AutoDynamicQueryCore(() => table(AlbumEntity).filter(a => a.year > 1990)));

describe("Type 2 — manual auto query (filtered, full entity)", () => {
    test("the shape/root type is inferred from the query's element type", () => {
        assert.equal(QueryLogic.queries.getCore(RECENT).getRootType(), AlbumEntity);
        const root = QueryLogic.getRootToken(RECENT);
        assert.equal(root.fullKey(), "");
        assert.equal(root.isEntity(), true);
    });

    test("executeQueryAsync runs the FILTERED source (WHERE reaches the SQL)", async () => {
        const root = QueryLogic.getRootToken(RECENT);
        const request = new QueryRequest(RECENT, [], [], [new Column(root.subToken("name", O)!)]);
        const rt = await Connector.withConnector(fake, () => QueryLogic.queries.executeQueryAsync(request));
        assert.ok(rt instanceof ResultTable);
        assert.deepEqual(rt.columns.map(c => c.token.fullKey()), ["name"]);
        assert.match(fake.lastSql, /where/);       // the registered filter (year > 1990) survived
        assert.match(fake.lastSql, /a\.year > @p/); // parameterised, not a literal
    });
});

// ---- Type 2: a projected ModelEntity query ------------------------------------------------------
@reflect
class AlbumRowModel extends ModelEntity {
    entity: AlbumEntity = null!; // the row identity
    name: string = "";
    year: int = toInt(0);
}

const MODELQ = "AlbumRows";
QueryLogic.queries.register(MODELQ, () => new AutoDynamicQueryCore(
    () => table(AlbumEntity).map(a => AlbumRowModel.create({ entity: a, name: a.name, year: a.year })),
));

describe("Type 2 — manual auto query (projected ModelEntity)", () => {
    test("the shape is the ModelEntity; its fields are the navigable tokens", () => {
        assert.equal(QueryLogic.queries.getCore(MODELQ).getRootType(), AlbumRowModel);
        const keys = QueryLogic.getRootToken(MODELQ).subTokens(O).map(t => t.key);
        for (const f of ["entity", "name", "year"])
            assert.ok(keys.includes(f), `missing model field token ${f}`);
    });

    test("executeQueryAsync projects the model's columns", async () => {
        const root = QueryLogic.getRootToken(MODELQ);
        const request = new QueryRequest(MODELQ, [], [], [new Column(root.subToken("name", O)!), new Column(root.subToken("year", O)!)]);
        const rt = await Connector.withConnector(fake, () => QueryLogic.queries.executeQueryAsync(request));
        assert.ok(rt instanceof ResultTable);
        assert.deepEqual(rt.columns.map(c => c.token.fullKey()), ["name", "year"]);
        assert.match(fake.lastSql, /album/);
    });
});

// ---- Type 3: a manual imperative query ----------------------------------------------------------
const MANUALQ = "ManualAlbums";
QueryLogic.queries.register(MANUALQ, () => new ManualDynamicQueryCore(AlbumEntity, async (request) => {
    // Hand-build a ResultTable: one value column for each requested column, three fixed rows.
    const cols = request.columns.map(c => new ResultColumn(c.token, ["x", "y", "z"]));
    return new ResultTable(cols, 3, request.pagination);
}));

describe("Type 3 — manual imperative query", () => {
    test("shape type comes from the declared model; the executor builds the ResultTable directly", async () => {
        assert.equal(QueryLogic.queries.getCore(MANUALQ).getRootType(), AlbumEntity);
        const root = QueryLogic.getRootToken(MANUALQ);
        const request = new QueryRequest(MANUALQ, [], [], [new Column(root.subToken("name", O)!)], new Pagination.All());
        const rt = await QueryLogic.queries.executeQueryAsync(request);
        assert.ok(rt instanceof ResultTable);
        assert.equal(rt.totalElements, 3);
        assert.equal(rt.rows.length, 3);
        assert.equal(rt.rows[0].getValue(root.subToken("name", O)!), "x");
    });
});
