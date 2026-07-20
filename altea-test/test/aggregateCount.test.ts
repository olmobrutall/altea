import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table } from "@altea/altea/logic/table";
import { Connector } from "@altea/altea/logic/connection/connector";
import { SchemaBuilder } from "@altea/altea/logic/schema";
import { QueryFormatter } from "@altea/altea/logic/linq/queryFormatter";
import { ClassType } from "@altea/altea/entities/runtimeTypes";
import { Implementations } from "@altea/altea/entities/implementations";
import { ColumnDescription } from "@altea/altea/logic/dynamicQuery/queryDescription";
import { SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { ColumnToken } from "@altea/altea/logic/dynamicQuery/tokens/columnToken";
import { AggregateToken, AggregateFunction } from "@altea/altea/logic/dynamicQuery/tokens/aggregateToken";
import { DQueryable } from "@altea/altea/logic/dynamicQuery/dQueryable";
import { FilterOperation } from "@altea/altea/logic/dynamicQuery/requests";
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../logic/MusicLogic";
import { AlbumEntity } from "../entities/music";

// Phase-5: Count variants — Count where <token> <op> <value> and Count distinct.

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
    const col = new ColumnDescription("Entity", new ClassType(AlbumEntity), "Album");
    col.implementations = Implementations.by(AlbumEntity);
    return new ColumnToken(col, AlbumEntity);
};
const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), et());
const groupSql = (agg: AggregateToken) =>
    Connector.withConnector(fake, () =>
        QueryFormatter.format(
            DQueryable.fromEntity(table(AlbumEntity).elementType, table(AlbumEntity).expression)
                .groupBy([tok("state")], [agg]).select([tok("state"), agg]).bindProjection().select, false)
            .sql.replace(/\s+/g, " ").toLowerCase());

describe("Count variants", () => {
    test("plain Count → COUNT(*)", () => {
        const s = groupSql(new AggregateToken(AggregateFunction.Count, undefined, { queryName: AlbumEntity }));
        assert.match(s, /count\(\*\)/);
    });

    test("Count where year > 1990 → filtered count (CASE)", () => {
        const s = groupSql(new AggregateToken(AggregateFunction.Count, tok("year"), { filterOperation: FilterOperation.GreaterThan, value: 1990 }));
        assert.match(s, /count\(case when \(a\.year > @p/);
    });

    test("Count distinct year → COUNT(DISTINCT …) (not a subquery)", () => {
        const s = groupSql(new AggregateToken(AggregateFunction.Count, tok("year"), { distinct: true }));
        // The LINQ provider's disassembleAggregate lowers map(sel).distinct().filter(notNull).count()
        // to a real COUNT(DISTINCT sel) — no `SELECT DISTINCT` subquery.
        assert.match(s, /count\(distinct a\.year\)/);
        assert.doesNotMatch(s, /select distinct/);
    });

    test("distinct vs filtered Counts have distinct keys", () => {
        const plain = new AggregateToken(AggregateFunction.Count, undefined, { queryName: AlbumEntity });
        const distinct = new AggregateToken(AggregateFunction.Count, tok("year"), { distinct: true });
        const where = new AggregateToken(AggregateFunction.Count, tok("year"), { filterOperation: FilterOperation.GreaterThan, value: 1990 });
        assert.notEqual(plain.key, distinct.key);
        assert.notEqual(distinct.key, where.key);
        assert.equal(plain.key, "Count");
        assert.equal(distinct.key, "CountDistinct");
    });
});
