import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { reflect } from "@altea/altea/data/reflection";
import { ModelEntity } from "@altea/altea/data/entity";
import { type int, toInt } from "@altea/altea/data/basics";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { AutoDynamicQueryCore, ManualDynamicQueryCore } from "@altea/altea/server/dynamicQuery/dynamicQueryCore";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { rowEntityToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { ResultTable, ResultColumn } from "@altea/altea/server/dynamicQuery/resultTable";
import { Column, QueryRequest, Pagination } from "@altea/altea/server/dynamicQuery/requests";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../MusicLogic";
import { AlbumEntity } from "../../data/music";

// Query flavors beyond the plain WithQuery (Type 1). Type 2 = a manually-registered Query<T> factory
// that filters/joins/projects (still LINQ-translated, still auto metadata from reflection). Type 3 =
// a manual imperative `request → ResultTable` core. Both register into QueryLogic.queries.
//
// A query is NAMED BY A TYPE (QueryName is Type<BaseEntity>), and MusicLogic already registered the
// plain Album query — so each extra view of an album is named by its own model, which is the rule an
// application follows too. Note the name and the SHAPE are separate: the name supplies the key (and
// the page title), while the row type comes from the core, so a model may name a query that yields
// full AlbumEntity rows.

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
@reflect
class RecentAlbumModel extends ModelEntity { }

const RECENT = RecentAlbumModel;
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
    entity: AlbumEntity = null!;  // the row identity
    id: string = "";             // the MODEL's own id — not the Entity base's
    name: string = "";
    year: int = toInt(0);
}

const MODELQ = AlbumRowModel;
QueryLogic.queries.register(MODELQ, () => new AutoDynamicQueryCore(
    () => table(AlbumEntity).map(a => AlbumRowModel.create({ entity: a, name: a.name, year: a.year })),
));

describe("Type 2 — manual auto query (projected ModelEntity)", () => {
    test("the shape is the ModelEntity; its fields are the navigable tokens", () => {
        assert.equal(QueryLogic.queries.getCore(MODELQ).getRootType(), AlbumRowModel);
        const keys = QueryLogic.getRootToken(MODELQ).subTokens(O).map(t => t.key);
        for (const f of ["entity", "id", "name", "year"])
            assert.ok(keys.includes(f), `missing model field token ${f}`);
    });

    test("a model's own `id` member is an ordinary field, not the Entity base's", () => {
        // `id`/`ticks` are skipped only for an ENTITY, where subTokensBase adds the synthetic id token
        // back. A row model inherits neither, so its declared `id` has to survive — it used to be
        // dropped, leaving that column unreachable as a column, a filter and an order.
        const idToken = QueryLogic.getRootToken(MODELQ).subToken("id", O);
        assert.ok(idToken != undefined);
        assert.equal(idToken.type.typeName, "String");   // the MODEL's string id, not an entity PK
    });

    test("the model's `entity` member is the row IDENTITY, and stays navigable", () => {
        const root = QueryLogic.getRootToken(MODELQ);
        const member = root.subToken("entity", O);
        assert.ok(member != undefined);
        assert.equal(member.isEntity(), true);
        assert.equal(rowEntityToken(root), member);
        // LISTED like any other member: it is the entry point for navigating INTO the row's entity
        // ("entity.name"), which is the whole point of projecting a lite into the row.
        assert.ok(root.subTokens(O).map(t => t.key).includes("entity"));
        assert.ok(member.subToken("name", O) != undefined);
    });

    test("the query core adds the row-entity column, and the ResultTable hides it", async () => {
        const root = QueryLogic.getRootToken(MODELQ);
        const request = new QueryRequest(MODELQ, [], [], [new Column(root.subToken("name", O)!)]);
        const rt = await Connector.withConnector(fake, () => QueryLogic.queries.executeQueryAsync(request));
        assert.equal(rt.hasEntities, true, "the row carries its entity");
        assert.deepEqual(rt.columns.map(c => c.token.fullKey()), ["name"], "…and it is not a visible column");
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
@reflect
class ManualAlbumModel extends ModelEntity { }

const MANUALQ = ManualAlbumModel;
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
