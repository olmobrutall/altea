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
import { DQueryable } from "@altea/altea/server/dynamicQuery/dQueryable";
import {
    FilterGroup, FilterGroupOperation, FilterCondition, FilterOperation,
} from "@altea/altea/server/dynamicQuery/requests";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { seedTypeCachesForTest } from "../seedTypeCaches";
import { MusicLogic } from "../MusicLogic";
import { AlbumEntity } from "../../data/music";

// Phase-5: FilterGroup + nested (any/all) filters. A FilterGroup whose token passes through a
// CollectionAnyAllToken becomes a correlated some/every subquery, combining element-level and
// outer-level conditions — `a.songs.some(s => s.name == "X" && a.year == 20)`.

const O = SubTokensOptionsAll;
const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();
seedTypeCachesForTest(sb.schema); // offline: deterministic type↔id cache for @implementedByAll binding
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
const whereSql = (group: FilterGroup) =>
    Connector.withConnector(fake, () =>
        QueryFormatter.format(base().where([group]).select([tok("name")]).bindProjection().select, false).sql.replace(/\s+/g, " ").toLowerCase());
const body = (group: FilterGroup) => group.getExpression(base().context).toString();

describe("collections expose the quantifier tokens", () => {
    test("songs → Any / All / NotAny / NotAll", () => {
        const keys = tok("songs").subTokens(O).map((t: any) => t.key);
        for (const k of ["Any", "All", "NotAny", "NotAll"])
            assert.ok(keys.includes(k), `missing ${k}`);
    });

    test("songs.Any exposes the element's fields", () => {
        const keys = tok("songs.Any").subTokens(O).map((t: any) => t.key);
        assert.ok(keys.includes("name"));
    });
});

describe("FilterGroup without a token → AND / OR of conditions", () => {
    test("OR group", () => {
        const g = new FilterGroup(FilterGroupOperation.Or, undefined, [
            new FilterCondition(tok("year"), FilterOperation.EqualTo, 1990),
            new FilterCondition(tok("year"), FilterOperation.EqualTo, 2000),
        ]);
        assert.equal(body(g), "((e.year == 1990) || (e.year == 2000))");
        assert.match(whereSql(g), /where.*or/);
    });

    test("AND group", () => {
        const g = new FilterGroup(FilterGroupOperation.And, undefined, [
            new FilterCondition(tok("year"), FilterOperation.GreaterThan, 1990),
            new FilterCondition(tok("name"), FilterOperation.StartsWith, "A"),
        ]);
        assert.match(body(g), /&&/);
    });
});

describe("FilterGroup with an Any/All token → correlated subquery", () => {
    // The headline case: element condition AND outer condition inside one quantifier.
    test("Any: a.songs.some(s => s.name == 'X' && a.year == 20)", () => {
        const g = new FilterGroup(FilterGroupOperation.And, tok("songs.Any"), [
            new FilterCondition(tok("songs.Any.name"), FilterOperation.EqualTo, "X"),
            new FilterCondition(tok("year"), FilterOperation.EqualTo, 20),
        ]);
        assert.equal(body(g), "e.songs.some(_a => ((_a.name == X) && (e.year == 20)))");
        const sql = whereSql(g);
        assert.match(sql, /where exists\(select .* from dbo\.album_songs/);
        assert.match(sql, /albumid = a\.id/);   // correlated to the outer album
        assert.match(sql, /\.name = @p/);        // element condition
        assert.match(sql, /a\.year = @p/);       // outer condition, same subquery
    });

    test("All → every, NotAny → !some, NotAll → some(!body)", () => {
        const cond = () => new FilterCondition(tok("songs.Any.name"), FilterOperation.EqualTo, "X");
        const g = (path: string) => new FilterGroup(FilterGroupOperation.And, tok(path), [cond()]);
        // The element token key is always "Any" in these navigations; only the quantifier differs.
        assert.match(body(new FilterGroup(FilterGroupOperation.And, tok("songs.All"), [
            new FilterCondition(tok("songs.All.name"), FilterOperation.EqualTo, "X")])), /\.every\(/);
        assert.match(body(new FilterGroup(FilterGroupOperation.And, tok("songs.NotAny"), [
            new FilterCondition(tok("songs.NotAny.name"), FilterOperation.EqualTo, "X")])), /^\(!e\.songs\.some\(/);
        assert.match(body(new FilterGroup(FilterGroupOperation.And, tok("songs.NotAll"), [
            new FilterCondition(tok("songs.NotAll.name"), FilterOperation.EqualTo, "X")])), /some\(_a => \(!/);
        void g;
    });
});
