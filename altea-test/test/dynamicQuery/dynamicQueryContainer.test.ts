import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { QueryLogic } from "@altea/altea/logic/dynamicQuery/queryLogic";
import { Column, QueryRequest, Pagination } from "@altea/altea/logic/dynamicQuery/requests";
import { ResultTable } from "@altea/altea/logic/dynamicQuery/resultTable";
import { SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import "@altea/altea/logic/dynamicQuery/fluentIncludeQuery"; // activates FluentInclude.withQuery
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../../logic/MusicLogic";
import { AlbumEntity } from "../../entities/music";

// DynamicQueryContainer: the registry backing QueryLogic.queries. withQuery() (parameterless)
// registers a lazy AutoDynamicQueryCore keyed by the entity type; the container exposes the query
// names, resolves the (lazily-built, cached) core, and executes a QueryRequest into a ResultTable.

const O = SubTokensOptionsAll;
const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb); // AlbumEntity is opted into a parameterless query
sb.complete();

class FakeConnector extends Connector {
    constructor() { super(sb.schema, false, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}
const fake = new FakeConnector();

describe("DynamicQueryContainer", () => {
    const Queries = QueryLogic.queries;

    test("withQuery registers the query under the entity type", () => {
        assert.ok(Queries.getQueryNames().includes(AlbumEntity));
    });

    test("tryGetCore resolves and caches the core (built once)", () => {
        const first = Queries.tryGetCore(AlbumEntity);
        assert.ok(first != undefined);
        assert.equal(Queries.tryGetCore(AlbumEntity), first, "same instance on the second call (ResetLazy)");
    });

    test("tryGetCore of an unregistered query is undefined; getCore throws", () => {
        class Unregistered {}
        assert.equal(Queries.tryGetCore(Unregistered), undefined);
        assert.throws(() => Queries.getCore(Unregistered));
    });

    test("rootToken delegates to the core (the entity root, key \"\")", () => {
        const root = Queries.rootToken(AlbumEntity);
        assert.equal(root.fullKey(), "");
        assert.equal(root.isEntity(), true);
        assert.equal(root.fullKey(), QueryLogic.getRootToken(AlbumEntity).fullKey(), "same root QueryLogic exposes");
    });

    test("executeQueryAsync runs the request through the pipeline into a ResultTable", async () => {
        // Navigate value tokens rootlessly off the entity-root token (key "").
        const root = Queries.rootToken(AlbumEntity);
        const tok = (name: string) => root.subToken(name, O)!;
        const request = new QueryRequest(
            AlbumEntity,
            [],
            [],
            [new Column(tok("name")), new Column(tok("year"))],
            new Pagination.Firsts(10),
        );
        // The fake connector returns no rows; we assert the pipeline runs and the ResultTable is
        // shaped by the request (the entity is the row identity, not a value column).
        const rt = await Connector.withConnector(fake, () => Queries.executeQueryAsync(request));
        assert.ok(rt instanceof ResultTable);
        assert.deepEqual(rt.columns.map(c => c.token.fullKey()), ["name", "year"]);
        assert.equal(rt.rows.length, 0);
    });
});
