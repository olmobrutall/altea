import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TreeRoute } from "../server/TreeRoute.server";

// The route arithmetic is where this port replaces a database TYPE (SQL Server's hierarchyid) with code,
// so it is the one part that carries its own suite. Needs no database: TreeRoute is pure.

describe("TreeRoute — levels and ancestors", () => {

    test("getLevel counts the labels", () => {
        assert.equal(TreeRoute.getLevel("/"), 0);
        assert.equal(TreeRoute.getLevel("/1/"), 1);
        assert.equal(TreeRoute.getLevel("/1/3/"), 2);
        assert.equal(TreeRoute.getLevel("/1/3.1/2/"), 3);
    });

    test("getAncestor walks up, and stops at the root", () => {
        assert.equal(TreeRoute.getAncestor("/1/3/2/", 1), "/1/3/");
        assert.equal(TreeRoute.getAncestor("/1/3/2/", 2), "/1/");
        assert.equal(TreeRoute.getAncestor("/1/3/2/", 3), "/");
        assert.equal(TreeRoute.getAncestor("/1/3/2/", 99), "/");
    });

    test("isDescendantOf is INCLUSIVE, as hierarchyid's is", () => {
        assert.equal(TreeRoute.isDescendantOf("/1/3/", "/1/"), true);
        assert.equal(TreeRoute.isDescendantOf("/1/3/", "/1/3/"), true);
        assert.equal(TreeRoute.isDescendantOf("/1/3/", "/2/"), false);
        assert.equal(TreeRoute.isDescendantOf("/1/3/", "/"), true);
    });

    test("getReparentedValue swaps the prefix", () => {
        assert.equal(TreeRoute.getReparentedValue("/1/3/2/", "/1/", "/9/"), "/9/3/2/");
        assert.equal(TreeRoute.getReparentedValue("/1/", "/1/", "/9/4/"), "/9/4/");
        assert.throws(() => TreeRoute.getReparentedValue("/2/", "/1/", "/9/"));
    });
});

describe("TreeRoute — depth-first order", () => {

    test("orders numerically per label, NOT lexicographically", () => {
        const routes = ["/2/", "/10/", "/1/", "/1/2/", "/1/10/", "/1/1/"];
        assert.deepEqual(routes.slice().sort(TreeRoute.compare),
            ["/1/", "/1/1/", "/1/2/", "/1/10/", "/2/", "/10/"]);

        // The reason the sort cannot be delegated to SQL: as strings, "/10/" sorts before "/2/".
        assert.ok("/10/" < "/2/");
    });

    test("a parent sorts before its children", () => {
        assert.ok(TreeRoute.compare("/1/", "/1/1/") < 0);
        assert.ok(TreeRoute.compare("/1/9/", "/2/") < 0);
    });

    test("a dotted label sorts between the integers it splits", () => {
        assert.ok(TreeRoute.compare("/3/", "/3.1/") < 0);
        assert.ok(TreeRoute.compare("/3.1/", "/4/") < 0);
    });
});

describe("TreeRoute — getDescendant", () => {

    test("the first child of a parent", () => {
        assert.equal(TreeRoute.getDescendant("/", null, null), "/1/");
        assert.equal(TreeRoute.getDescendant("/5/", null, null), "/5/1/");
    });

    test("appending after the last child", () => {
        assert.equal(TreeRoute.getDescendant("/", "/1/", null), "/2/");
        assert.equal(TreeRoute.getDescendant("/5/", "/5/3/", null), "/5/4/");
    });

    test("inserting before the first child", () => {
        // Room below: 3 → 2.
        assert.equal(TreeRoute.getDescendant("/", null, "/3/"), "/2/");
        // No room below 1: go deeper rather than renumber the siblings.
        const before1 = TreeRoute.getDescendant("/", null, "/1/");
        assert.ok(TreeRoute.compare(before1, "/1/") < 0, `${before1} should sort before /1/`);
    });

    test("inserting between two siblings that have room", () => {
        assert.equal(TreeRoute.getDescendant("/", "/1/", "/5/"), "/2/");
    });

    test("inserting between ADJACENT siblings — the density invariant", () => {
        const mid = TreeRoute.getDescendant("/", "/3/", "/4/");
        assert.equal(mid, "/3.1/");
        assert.ok(TreeRoute.compare("/3/", mid) < 0);
        assert.ok(TreeRoute.compare(mid, "/4/") < 0);
    });

    test("inserting repeatedly between the same pair always succeeds", () => {
        // The property that makes the order dense: whatever two adjacent siblings you name, a position
        // between them exists — so a tree can be rearranged indefinitely without renumbering.
        let lower = "/3/";
        const upper = "/4/";

        for (let i = 0; i < 25; i++) {
            const mid = TreeRoute.getDescendant("/", lower, upper);
            assert.ok(TreeRoute.compare(lower, mid) < 0, `${lower} < ${mid}`);
            assert.ok(TreeRoute.compare(mid, upper) < 0, `${mid} < ${upper}`);
            lower = mid;
        }
    });

    test("inserting repeatedly just BEFORE the same sibling always succeeds", () => {
        let upper = "/4/";

        for (let i = 0; i < 25; i++) {
            const mid = TreeRoute.getDescendant("/", null, upper);
            assert.ok(TreeRoute.compare(mid, upper) < 0, `${mid} < ${upper}`);
            upper = mid;
        }
    });

    test("rejects a child that is not a direct child of the parent", () => {
        assert.throws(() => TreeRoute.getDescendant("/1/", "/2/", null));
        assert.throws(() => TreeRoute.getDescendant("/1/", "/1/2/3/", null));
    });

    test("rejects two bounds that are out of order", () => {
        assert.throws(() => TreeRoute.getDescendant("/", "/5/", "/2/"));
    });
});

describe("TreeRoute — between (the label-level primitive)", () => {

    test("keeps strict order for every adjacent pair it produces", () => {
        const pairs: [number[], number[]][] = [
            [[1], [2]],
            [[1], [1, 1]],
            [[3, 1], [4]],
            [[3], [3, 1]],
            [[1, 2], [1, 3]],
            [[1], [5]],
        ];

        for (const [a, b] of pairs) {
            const mid = TreeRoute.between(a, b);
            assert.ok(TreeRoute.compareLabel(a, mid) < 0, `${a} < ${mid}`);
            assert.ok(TreeRoute.compareLabel(mid, b) < 0, `${mid} < ${b}`);
        }
    });

    test("compareLabel puts a prefix before what extends it", () => {
        assert.ok(TreeRoute.compareLabel([3], [3, 1]) < 0);
        assert.ok(TreeRoute.compareLabel([3, 1], [3, 2]) < 0);
        assert.equal(TreeRoute.compareLabel([3, 1], [3, 1]), 0);
    });
});
