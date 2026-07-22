import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { bindAndOptimize } from "@altea/altea/logic/table";
import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { ProjectionExpression } from "@altea/altea/logic/linq/expressions.sql";
import { LiteralType, LiteType, ClassType } from "@altea/altea/entities/runtimeTypes";
import { QueryLogic } from "@altea/altea/logic/dynamicQuery/queryLogic";
import { SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { DQueryable } from "@altea/altea/logic/dynamicQuery/dQueryable";
import { Column, QueryRequest } from "@altea/altea/logic/dynamicQuery/requests";
import { table } from "@altea/altea/logic/table";
import "@altea/altea/logic/dynamicQuery/fluentIncludeQuery"; // activates FluentInclude.withQuery
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../../logic/MusicLogic";
import { AlbumEntity, LabelEntity, ArtistEntity, BandEntity } from "../../entities/music";

// The redesigned WithQuery: PARAMETERLESS. `sb.include(T).withQuery()` registers `table(T)`; the
// query's shape is the entity itself — a single entity-root token keyed "" — and every column is a
// rootless navigation off it ("name", "author", "label.name", …). No projection, no "Entity." prefix.

const O = SubTokensOptionsAll;
const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb); // opts AlbumEntity (and the rest) into a parameterless query
sb.complete();

class FakeConnector extends Connector {
    constructor() { super(sb.schema, false, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}
const fake = new FakeConnector();

describe("withQuery() → entity-root token", () => {
    test("QueryLogic.getRootToken returns the entity root (key \"\", entity type + implementations)", () => {
        const root = QueryLogic.getRootToken(AlbumEntity);
        assert.equal(root.fullKey(), "");
        assert.equal(root.isEntity(), true);
        assert.equal(root.getImplementations()!.only(), AlbumEntity);
        assert.equal(root.type instanceof ClassType && root.type.constructorFunction, AlbumEntity);
    });
});

describe("tokens are navigated rootlessly off the entity", () => {
    // The entity-root token (key "") is what QueryLogic exposes; navigations hang off it.
    const root = () => QueryLogic.getRootToken(AlbumEntity);
    const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), root());

    test("the entity root has fullKey \"\"; value/reference columns are rootless", () => {
        assert.equal(root().fullKey(), "");
        assert.equal(tok("name").fullKey(), "name");        // NOT "Entity.name"
        assert.equal(tok("label").fullKey(), "label");
        assert.equal(tok("label.name").fullKey(), "label.name");
    });

    test("value/reference tokens carry the right type + property route", () => {
        assert.equal(tok("name").type, LiteralType.string);
        assert.equal(tok("name").getPropertyRoute()!.toString(), "(Album).name");
        assert.equal(tok("year").type, LiteralType.number);
        assert.ok(tok("label").type instanceof LiteType);
        assert.equal(tok("label").getImplementations()!.only(), LabelEntity);
    });

    test("polymorphic reference token → all implementations", () => {
        assert.deepEqual(new Set(tok("author").getImplementations()!.types), new Set([ArtistEntity, BandEntity]));
    });
});

describe("the query executes off table(T), navigating tokens (no projection)", () => {
    const root = () => QueryLogic.getRootToken(AlbumEntity);
    const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), root());

    test("select the name column off the entity query", () => {
        const sql = Connector.withConnector(fake, () => {
            const dq = DQueryable.forEntityQuery(table(AlbumEntity)).select([tok("name")]);
            const proj = bindAndOptimize(dq.query, sb.schema, false, true) as ProjectionExpression;
            assert.ok(proj instanceof ProjectionExpression);
            return QueryFormatter.format(proj.select, false).sql.toLowerCase();
        });
        assert.match(sql, /name/);
        assert.match(sql, /from\s+\w*\.?\[?album/i);
    });

    test("executeQueryAsync runs a request through the container into a ResultTable", async () => {
        const request = new QueryRequest(AlbumEntity, [], [], [new Column(tok("name")), new Column(tok("year"))]);
        const rt = await Connector.withConnector(fake, () => QueryLogic.queries.executeQueryAsync(request));
        assert.deepEqual(rt.columns.map(c => c.token.fullKey()), ["name", "year"]);
    });
});
