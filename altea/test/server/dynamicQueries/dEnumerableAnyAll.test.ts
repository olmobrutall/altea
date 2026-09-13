import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { table } from "@altea/altea/server/table";
import { Connector } from "@altea/altea/server/connection/connector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { ClassType } from "@altea/altea/server/runtimeTypes";
import { SubTokensOptionsAll } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/data/dynamicQuery/tokens/rootToken";
import { Implementations } from "@altea/altea/data/implementations";
import { DQueryable } from "@altea/altea/server/dynamicQuery/dQueryable";
import { DEnumerable } from "@altea/altea/server/dynamicQuery/dEnumerable";
import { FilterGroup, FilterGroupOperationKeys, FilterCondition, FilterOperationKeys } from "@altea/altea/server/dynamicQuery/requests";
import "@altea/altea/server/dynamicQuery/tokenExpressions";
import { MusicLogic } from "../MusicLogic";
import { AlbumEntity } from "../../data/music";

// Phase-5: in-memory quantifier eval. The DEnumerable interpreter (evalExpr) runs a FilterGroup
// any/all as a native `.some`/`.every` with the element parameter bound — so an element condition
// and an outer condition correlate in memory, matching the SQL EXISTS form.

const O = SubTokensOptionsAll;

const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();
// Building a STRING filter's expression asks the ACTIVE CONNECTOR for its dialect (requests.ts's
// `toLowerStringFilter` — altea's dialect is per-connection, where Signum's is process-wide), so even a
// DB-free case needs one in scope. Same fixture every sibling suite in this folder declares.
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

// A context whose "Entity" column is the row itself; rows are album-like objects.
const context = table(AlbumEntity).toDQueryable().context;

const rows = () => [
    { year: 20, songs: [{ name: "X" }, { name: "Y" }] }, // has song X AND year 20  → match
    { year: 20, songs: [{ name: "Z" }] },                // year 20 but no song X   → no
    { year: 99, songs: [{ name: "X" }] },                // song X but year 99      → no
];

describe("in-memory FilterGroup any/all", () => {
    test("Any: a.songs.some(s => s.name=='X' && a.year==20) correlates element + outer in memory", () => {
        const group = new FilterGroup(FilterGroupOperationKeys.And, tok("songs.Any"), [
            new FilterCondition(tok("songs.Any.name"), FilterOperationKeys.EqualTo, "X"),
            new FilterCondition(tok("year"), FilterOperationKeys.EqualTo, 20),
        ]);
        const filtered = Connector.withConnector(fake, () => new DEnumerable(rows(), context).where([group]));
        assert.equal(filtered.collection.length, 1);
        assert.equal((filtered.collection[0] as any).year, 20);
    });

    test("All: every song matches", () => {
        const group = new FilterGroup(FilterGroupOperationKeys.And, tok("songs.All"), [
            new FilterCondition(tok("songs.All.name"), FilterOperationKeys.EqualTo, "X"),
        ]);
        // Only row 3 ({songs:[X]}) has ALL songs named X.
        const filtered = Connector.withConnector(fake, () => new DEnumerable(rows(), context).where([group]));
        assert.deepEqual(filtered.collection.map((r: any) => r.year), [99]);
    });

    test("NotAny: no song matches", () => {
        const group = new FilterGroup(FilterGroupOperationKeys.And, tok("songs.NotAny"), [
            new FilterCondition(tok("songs.NotAny.name"), FilterOperationKeys.EqualTo, "X"),
        ]);
        // Only row 2 ({songs:[Z]}) has NO song named X.
        const filtered = Connector.withConnector(fake, () => new DEnumerable(rows(), context).where([group]));
        assert.deepEqual(filtered.collection.map((r: any) => JSON.stringify(r.songs)), ['[{"name":"Z"}]']);
    });

    test("outer condition alone still filters (element param unused)", () => {
        const group = new FilterGroup(FilterGroupOperationKeys.And, tok("songs.Any"), [
            new FilterCondition(tok("songs.Any.name"), FilterOperationKeys.EqualTo, "X"),
        ]);
        // Rows with any song named X: rows 1 and 3.
        const filtered = Connector.withConnector(fake, () => new DEnumerable(rows(), context).where([group]));
        assert.deepEqual(filtered.collection.map((r: any) => r.year), [20, 99]);
    });
});
