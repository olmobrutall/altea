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
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { MusicLogic } from "../logic/MusicLogic";
import { AlbumEntity } from "../entities/music";

// Phase-5: DQueryable.groupBy — group by key tokens, compute aggregate tokens over each group
// (Signum's DQueryable.GroupBy), onto altea's `groupBy(key).map(g => …over g.elements…)`.

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
const base = () => { const q = table(AlbumEntity); return DQueryable.fromEntity(q.elementType, q.expression); };
const groupSql = (keys: any[], aggs: AggregateToken[]) =>
    Connector.withConnector(fake, () =>
        QueryFormatter.format(base().groupBy(keys, aggs).select([...keys, ...aggs]).bindProjection().select, false)
            .sql.replace(/\s+/g, " ").toLowerCase());

describe("DQueryable.groupBy → GROUP BY + aggregates", () => {
    test("group by state, count + sum(year)", () => {
        const s = groupSql([tok("state")], [
            new AggregateToken(AggregateFunction.Count, undefined, AlbumEntity),
            new AggregateToken(AggregateFunction.Sum, tok("year")),
        ]);
        assert.match(s, /group by a\.stateid/);
        assert.match(s, /count\(\*\)/);
        assert.match(s, /sum\(a\.year\)/);
    });

    test("min + max over the group", () => {
        const s = groupSql([tok("state")], [
            new AggregateToken(AggregateFunction.Min, tok("year")),
            new AggregateToken(AggregateFunction.Max, tok("year")),
        ]);
        assert.match(s, /min\(a\.year\)/);
        assert.match(s, /max\(a\.year\)/);
    });

    test("multi-key group (state, year)", () => {
        const s = groupSql([tok("state"), tok("year")], [
            new AggregateToken(AggregateFunction.Count, undefined, AlbumEntity),
        ]);
        assert.match(s, /group by/);
        assert.match(s, /stateid/);
        assert.match(s, /year/);
    });
});

describe("grouped context resolves key + aggregate tokens", () => {
    test("select after groupBy reads the key and the aggregate slots", () => {
        const stateTok = tok("state");
        const countAgg = new AggregateToken(AggregateFunction.Count, undefined, AlbumEntity);
        const grouped = base().groupBy([stateTok], [countAgg]);
        const proj = Connector.withConnector(fake, () => grouped.select([stateTok, countAgg]).bindProjection());
        assert.equal(proj.select.columns.length, 2);
    });
});
