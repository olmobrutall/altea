import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "@altea/altea/entities/globals";
import { table } from "@altea/altea/logic/table";
import { ClassType } from "@altea/altea/entities/runtimeTypes";
import { Implementations } from "@altea/altea/entities/implementations";
import { ColumnDescription } from "@altea/altea/logic/dynamicQuery/queryDescription";
import { SubTokensOptionsAll } from "@altea/altea/logic/dynamicQuery/tokens/queryToken";
import { ColumnToken } from "@altea/altea/logic/dynamicQuery/tokens/columnToken";
import { DQueryable } from "@altea/altea/logic/dynamicQuery/dQueryable";
import { DEnumerable, DEnumerableCount } from "@altea/altea/logic/dynamicQuery/dEnumerable";
import {
    FilterCondition, FilterOperation, Order, OrderType, Column, Pagination,
} from "@altea/altea/logic/dynamicQuery/requests";
import "@altea/altea/logic/dynamicQuery/tokens/factories";
import { AlbumEntity } from "../entities/music";

// Phase-5 (in-memory arm): DEnumerable / DEnumerableCount + ResultTable. Tests run DB-free by
// constructing DEnumerables from fixed materialised rows over a real (post-select) tuple context —
// exactly the shape AllQueryOperationsAsync produces before Concat/OrderBy/TryPaginate.

const O = SubTokensOptionsAll;
const et = () => {
    const col = new ColumnDescription("Entity", new ClassType(AlbumEntity), "Album");
    col.implementations = Implementations.by(AlbumEntity);
    return new ColumnToken(col, AlbumEntity);
};
const tok = (path: string) => path.split(".").reduce<any>((t, s) => t.subToken(s, O), et());

const nameTok = tok("name");
const yearTok = tok("year");

// A post-select tuple context (name → _s.c0, year → _s.c1), reused for both fixed-row sources.
const q = table(AlbumEntity);
const context = DQueryable.fromEntity(q.elementType, q.expression).select([nameTok, yearTok]).context;

// Rows as they'd look after materialisation of that select.
const rowsA = () => new DEnumerableCount([{ c0: "Brahms", c1: 1870 }, { c0: "Adele", c1: 2015 }], context, 2);
const rowsB = () => new DEnumerableCount([{ c0: "Chopin", c1: 1840 }, { c0: "Bjork", c1: 1993 }], context, 2);

describe("DEnumerable in-memory operations", () => {
    test("orderBy sorts by the token's column", () => {
        const ordered = rowsA().orderBy([new Order(nameTok, OrderType.Ascending)]);
        assert.deepEqual(ordered.collection.map((r: any) => r.c0), ["Adele", "Brahms"]);
    });

    test("orderBy descending", () => {
        const ordered = rowsA().orderBy([new Order(yearTok, OrderType.Descending)]);
        assert.deepEqual(ordered.collection.map((r: any) => r.c1), [2015, 1870]);
    });

    test("where filters by a condition on the token", () => {
        const filtered = rowsA().where([new FilterCondition(yearTok, FilterOperation.GreaterThan, 1990)]);
        assert.deepEqual(filtered.collection.map((r: any) => r.c0), ["Adele"]);
    });

    test("where with a string Contains", () => {
        const filtered = rowsA().where([new FilterCondition(nameTok, FilterOperation.StartsWith, "B")]);
        assert.deepEqual(filtered.collection.map((r: any) => r.c0), ["Brahms"]);
    });

    test("tryPaginate Firsts takes the first n", () => {
        const page = rowsA().tryPaginate(new Pagination.Firsts(1));
        assert.equal(page.collection.length, 1);
        assert.ok(page instanceof DEnumerableCount);
    });
});

describe("Concat two sources then order + paginate (CustomersLogic pattern)", () => {
    test("concat combines rows and sums the totals", () => {
        const combined = rowsA().concat(rowsB());
        assert.equal(combined.collection.length, 4);
        assert.equal((combined as DEnumerableCount).totalElements, 4);
    });

    test("concat → orderBy → tryPaginate → ResultTable", () => {
        const combined: DEnumerable = rowsA().concat(rowsB());
        const ordered = combined.orderBy([new Order(nameTok, OrderType.Ascending)]);
        const pagination = new Pagination.Paginate(2, 1);
        const page = ordered.tryPaginate(pagination);
        const rt = page.toResultTable([new Column(nameTok), new Column(yearTok)], pagination);

        // First page of 2, alphabetical by name.
        assert.equal(rt.rows.length, 2);
        assert.deepEqual(rt.columns.map(c => c.token.key), ["name", "year"]);
        assert.equal(rt.getColumn(nameTok).values[0], "Adele");
        assert.equal(rt.rows[0].getValue(nameTok), "Adele");
        assert.equal(rt.rows[1].getValue(nameTok), "Bjork");
        assert.equal(rt.totalElements, 4);
        assert.equal(rt.totalPages, 2); // 4 elements / 2 per page
    });
});

describe("ResultTable shape", () => {
    test("columns carry per-row values; rows read them back by token and index", () => {
        const rt = rowsA().toResultTable([new Column(nameTok), new Column(yearTok)]);
        assert.deepEqual(rt.getColumn(nameTok).values, ["Brahms", "Adele"]);
        assert.equal(rt.rows[1].value(0), "Adele");
        assert.equal(rt.rows[0].value(1), 1870);
        assert.equal(rt.hasEntities, false);
    });
});
