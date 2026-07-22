import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table } from "@altea/altea/logic/table";
import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { ClassType } from "@altea/altea/entities/runtimeTypes";
import { Implementations } from "@altea/altea/entities/implementations";
import { SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/logic/dynamicQuery/tokens/rootToken";
import { AggregateToken, AggregateFunction } from "@altea/altea/logic/dynamicQuery/tokens/aggregateToken";
import { DQueryable } from "@altea/altea/logic/dynamicQuery/dQueryable";
import {
    Column, Order, OrderType, FilterCondition, FilterOperation, Pagination, QueryRequest,
} from "@altea/altea/logic/dynamicQuery/requests";
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../../logic/MusicLogic";
import { AlbumEntity } from "../../entities/music";

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
const base = () => { const q = table(AlbumEntity); return DQueryable.fromEntity(q.elementType, q.expression); };
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
