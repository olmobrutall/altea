import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table } from "@altea/altea/logic/table";
import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { ClassType } from "@altea/altea/entities/runtimeTypes";
import { Implementations } from "@altea/altea/entities/implementations";
import { ColumnDescription, QueryDescription } from "@altea/altea/logic/dynamicQuery/queryDescription";
import { SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { ColumnToken } from "@altea/altea/logic/dynamicQuery/tokens/columnToken";
import { DQueryable } from "@altea/altea/logic/dynamicQuery/dQueryable";
import {
    Filter, FilterCondition, FilterOperation, Order, OrderType, Column, Pagination, QueryRequest,
} from "@altea/altea/logic/dynamicQuery/requests";
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../logic/MusicLogic";
import { AlbumEntity } from "../entities/music";

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
    const col = new ColumnDescription("Entity", new ClassType(AlbumEntity), "Album");
    col.implementations = Implementations.by(AlbumEntity);
    return new ColumnToken(col, AlbumEntity);
};
const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), entityToken());
const sql = (dq: DQueryable) => QueryFormatter.format(dq.bindProjection().select, false).sql.toLowerCase();

describe("DQueryable pipeline builds the query", () => {
    const base = () => { const q = table(AlbumEntity); return DQueryable.fromEntity(q.elementType, q.expression); };

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
        const built = DQueryable.fromEntity(q.elementType, q.expression).allQueryOperations(request);
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
        const built = DQueryable.fromEntity(q.elementType, q.expression).allQueryOperations(request);
        const s = Connector.withConnector(fake, () => sql(built));
        assert.match(s, /song/);       // CROSS APPLY into Album_Songs
        assert.match(s, /cross apply|join/);
    });
});
