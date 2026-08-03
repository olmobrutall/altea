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
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../../logic/MusicLogic";
import { AlbumEntity } from "../../entities/music";

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
    return new RootToken(AlbumEntity);
};
const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), et());
const base = () => { const q = table(AlbumEntity); return q.toDQueryable(); };
const groupSql = (keys: any[], aggs: AggregateToken[]) =>
    Connector.withConnector(fake, () =>
        QueryFormatter.format(base().groupBy(keys, aggs).select([...keys, ...aggs]).bindProjection().select, false)
            .sql.replace(/\s+/g, " ").toLowerCase());

describe("DQueryable.groupBy → GROUP BY + aggregates", () => {
    test("group by state, count + sum(year)", () => {
        const s = groupSql([tok("state")], [
            new AggregateToken(AggregateFunction.Count, undefined, { queryName: AlbumEntity }),
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
            new AggregateToken(AggregateFunction.Count, undefined, { queryName: AlbumEntity }),
        ]);
        assert.match(s, /group by/);
        assert.match(s, /stateid/);
        assert.match(s, /year/);
    });
});

describe("grouped context resolves key + aggregate tokens", () => {
    test("select after groupBy reads the key and the aggregate slots", () => {
        const stateTok = tok("state");
        const countAgg = new AggregateToken(AggregateFunction.Count, undefined, { queryName: AlbumEntity });
        const grouped = base().groupBy([stateTok], [countAgg]);
        const proj = Connector.withConnector(fake, () => grouped.select([stateTok, countAgg]).bindProjection());
        assert.equal(proj.select.columns.length, 2);
    });
});
