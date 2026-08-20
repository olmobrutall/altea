import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { ClassType } from "@altea/altea/server/runtimeTypes";
import { Implementations } from "@altea/altea/data/implementations";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { AggregateToken, AggregateFunction } from "@altea/altea/data/dynamicQuery/tokens/aggregateToken";
import { DQueryable } from "@altea/altea/server/dynamicQuery/dQueryable";
import {
    Column, Order, OrderType, FilterCondition, FilterOperation, Pagination, QueryRequest,
} from "@altea/altea/server/dynamicQuery/requests";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../MusicLogic";
import { AlbumEntity } from "../../data/music";

// Phase-5: QueryRequest.groupResults wired into allQueryOperations. A request with aggregate columns
// automatically GROUPs BY the non-aggregate columns; aggregate filters become HAVING.

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

const et = () => {
    return new RootToken(AlbumEntity);
};
const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), et());
const base = () => { const q = table(AlbumEntity); return q.toDQueryable(); };
const requestSql = (req: QueryRequest) =>
    Connector.withConnector(fake, () =>
        QueryFormatter.format(base().allQueryOperations(req).bindProjection().select, false).sql.replace(/\s+/g, " ").toLowerCase());

describe("groupResults wired into allQueryOperations", () => {
    test("aggregate columns → GROUP BY the non-aggregate columns", () => {
        const req = new QueryRequest(AlbumEntity, [], [],
            [new Column(tok("state")), new Column(new AggregateToken(AggregateFunction.Count, undefined, { queryName: AlbumEntity }))],
            new Pagination.All(), /* groupResults */ true);
        const s = requestSql(req);
        assert.match(s, /group by a\.stateid/);
        assert.match(s, /count\(\*\)/);
    });

    test("simple filter → WHERE before the group; aggregate filter → HAVING (outer WHERE on the aggregate)", () => {
        const count = new AggregateToken(AggregateFunction.Count, undefined, { queryName: AlbumEntity });
        const req = new QueryRequest(AlbumEntity,
            [
                new FilterCondition(tok("year"), FilterOperation.GreaterThan, 1900),        // WHERE
                new FilterCondition(count, FilterOperation.GreaterThanOrEqual, 2),          // HAVING
            ],
            [new Order(count, OrderType.Descending)],
            [new Column(tok("state")), new Column(count)],
            new Pagination.All(), true);
        const s = requestSql(req);
        assert.match(s, /where \(a\.year > @p/);   // simple filter inside the grouped subquery
        assert.match(s, /group by a\.stateid/);
        assert.match(s, /where \(s\d+\.agg\d+ >= @p/); // aggregate filter applied after the group
        assert.match(s, /order by s\d+\.agg\d+ desc/); // order by the aggregate
    });

    test("groupResults false → no GROUP BY (plain select)", () => {
        const req = new QueryRequest(AlbumEntity, [], [], [new Column(tok("state")), new Column(tok("name"))], new Pagination.All(), false);
        const s = requestSql(req);
        assert.doesNotMatch(s, /group by/);
    });

    test("isAggregate classifies filters", () => {
        const count = new AggregateToken(AggregateFunction.Count, undefined, { queryName: AlbumEntity });
        assert.equal(new FilterCondition(count, FilterOperation.GreaterThan, 1).isAggregate(), true);
        assert.equal(new FilterCondition(tok("year"), FilterOperation.GreaterThan, 1).isAggregate(), false);
    });
});
