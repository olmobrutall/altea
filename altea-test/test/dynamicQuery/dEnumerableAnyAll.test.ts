import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table } from "@altea/altea/logic/table";
import { ClassType } from "@altea/altea/entities/runtimeTypes";
import { SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { RootToken } from "@altea/altea/logic/dynamicQuery/tokens/rootToken";
import { Implementations } from "@altea/altea/entities/implementations";
import { DQueryable } from "@altea/altea/logic/dynamicQuery/dQueryable";
import { DEnumerable } from "@altea/altea/logic/dynamicQuery/dEnumerable";
import { FilterGroup, FilterGroupOperation, FilterCondition, FilterOperation } from "@altea/altea/logic/dynamicQuery/requests";
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { AlbumEntity } from "../../entities/music";

// Phase-5: in-memory quantifier eval. The DEnumerable interpreter (evalExpr) runs a FilterGroup
// any/all as a native `.some`/`.every` with the element parameter bound — so an element condition
// and an outer condition correlate in memory, matching the SQL EXISTS form.

const O = SubTokensOptionsAll;
const et = () => {
    return new RootToken(AlbumEntity);
};
const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), et());

// A context whose "Entity" column is the row itself; rows are album-like objects.
const context = DQueryable.fromEntity(new ClassType(AlbumEntity), table(AlbumEntity).expression).context;

const rows = () => [
    { year: 20, songs: [{ name: "X" }, { name: "Y" }] }, // has song X AND year 20  → match
    { year: 20, songs: [{ name: "Z" }] },                // year 20 but no song X   → no
    { year: 99, songs: [{ name: "X" }] },                // song X but year 99      → no
];

describe("in-memory FilterGroup any/all", () => {
    test("Any: a.songs.some(s => s.name=='X' && a.year==20) correlates element + outer in memory", () => {
        const group = new FilterGroup(FilterGroupOperation.And, tok("songs.Any"), [
            new FilterCondition(tok("songs.Any.name"), FilterOperation.EqualTo, "X"),
            new FilterCondition(tok("year"), FilterOperation.EqualTo, 20),
        ]);
        const filtered = new DEnumerable(rows(), context).where([group]);
        assert.equal(filtered.collection.length, 1);
        assert.equal((filtered.collection[0] as any).year, 20);
    });

    test("All: every song matches", () => {
        const group = new FilterGroup(FilterGroupOperation.And, tok("songs.All"), [
            new FilterCondition(tok("songs.All.name"), FilterOperation.EqualTo, "X"),
        ]);
        // Only row 3 ({songs:[X]}) has ALL songs named X.
        const filtered = new DEnumerable(rows(), context).where([group]);
        assert.deepEqual(filtered.collection.map((r: any) => r.year), [99]);
    });

    test("NotAny: no song matches", () => {
        const group = new FilterGroup(FilterGroupOperation.And, tok("songs.NotAny"), [
            new FilterCondition(tok("songs.NotAny.name"), FilterOperation.EqualTo, "X"),
        ]);
        // Only row 2 ({songs:[Z]}) has NO song named X.
        const filtered = new DEnumerable(rows(), context).where([group]);
        assert.deepEqual(filtered.collection.map((r: any) => JSON.stringify(r.songs)), ['[{"name":"Z"}]']);
    });

    test("outer condition alone still filters (element param unused)", () => {
        const group = new FilterGroup(FilterGroupOperation.And, tok("songs.Any"), [
            new FilterCondition(tok("songs.Any.name"), FilterOperation.EqualTo, "X"),
        ]);
        // Rows with any song named X: rows 1 and 3.
        const filtered = new DEnumerable(rows(), context).where([group]);
        assert.deepEqual(filtered.collection.map((r: any) => r.year), [20, 99]);
    });
});
