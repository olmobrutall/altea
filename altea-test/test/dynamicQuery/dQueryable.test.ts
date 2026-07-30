import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { ClassType } from "@altea/altea/server/runtimeTypes";
import { Implementations } from "@altea/altea/entities/implementations";
import { SubTokensOptionsAll } from "@altea/altea/entities/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/entities/dynamicQuery/tokens/rootToken";
import { DQueryable } from "@altea/altea/server/dynamicQuery/dQueryable";
import {
    Filter, FilterCondition, FilterOperation, Order, OrderType, Column, Pagination, QueryRequest,
} from "@altea/altea/server/dynamicQuery/requests";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../../logic/MusicLogic";
import { AlbumEntity } from "../../entities/music";

// Phase-5 DynamicQuery port: the DQueryable authoring API (Signum's DQueryable.cs) — a query paired
// with its token context, threaded through where / orderBy / select / tryPaginate, as app code uses
// it (cf. Southwind CustomersLogic).

const O = SubTokensOptionsAll;

const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();
class FakeConnector extends Connector {
    constructor() { super(sb.schema, false, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve([]); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}
const fake = new FakeConnector();

// The "Album" query description (one Entity column). Tokens are navigated off it.
const entityToken = () => {
    return new RootToken(AlbumEntity);
};
const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), entityToken());
const sql = (dq: DQueryable) => QueryFormatter.format(dq.bindProjection().select, false).sql.toLowerCase();

describe("DQueryable pipeline builds the query", () => {
    const base = () => { const q = table(AlbumEntity); return q.toDQueryable(); };

    test("where → filter (year > 1990)", () => {
        const dq = base().where([new FilterCondition(tok("year"), FilterOperation.GreaterThan, 1990)]).select([tok("name")]);
        assert.match(Connector.withConnector(fake, () => sql(dq)), /where/);
    });

    test("orderBy → ORDER BY name DESC", () => {
        const dq = base().orderBy([new Order(tok("name"), OrderType.Descending)]).select([tok("name")]);
        assert.match(Connector.withConnector(fake, () => sql(dq)), /order by[^)]*desc/is);
    });

    test("tryPaginate Firsts(5) → TOP 5", () => {
        const dq = base().select([tok("name")]).tryPaginate(new Pagination.Firsts(5));
        assert.match(Connector.withConnector(fake, () => sql(dq)), /top\s*\(?\s*5/);
    });

    test("select projects the chosen columns", () => {
        const dq = base().select([tok("name"), tok("year")]);
        const proj = Connector.withConnector(fake, () => dq.bindProjection());
        assert.equal(proj.select.columns.length, 2);
    });
});

describe("DQueryable.allQueryOperations (QueryRequest-driven, cf. CustomersLogic)", () => {
    test("filter + order + columns + pagination compose into one query", () => {
        const q = table(AlbumEntity);
        const request = new QueryRequest(
            AlbumEntity,
            [new FilterCondition(tok("year"), FilterOperation.GreaterThanOrEqual, 1990)],
            [new Order(tok("name"), OrderType.Ascending)],
            [new Column(tok("name")), new Column(tok("year"))],
            new Pagination.Firsts(10),
        );
        const built = q.toDQueryable().allQueryOperations(request);
        const s = Connector.withConnector(fake, () => sql(built));
        assert.match(s, /where/);
        assert.match(s, /order by/);
        assert.match(s, /top\s*\(?\s*10/);
        assert.match(s, /name/);
    });

    test("a collection column multiplies the rows via selectMany", () => {
        const q = table(AlbumEntity);
        const request = new QueryRequest(
            AlbumEntity,
            [],
            [],
            [new Column(tok("songs.Element.name"))],
            new Pagination.All(),
        );
        const built = q.toDQueryable().allQueryOperations(request);
        const s = Connector.withConnector(fake, () => sql(built));
        assert.match(s, /song/);       // OUTER APPLY into Album_Songs (Signum's SelectMany + DefaultIfEmpty)
        assert.match(s, /outer apply|left join lateral/); // keeps empty-collection owners
    });
});
