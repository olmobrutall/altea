import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { Temporal, Decimal } from "@altea/altea/data/basics";

// The ordering helpers compare through a key, and `<` / `>` are not a comparison every value supports.
//
// A Temporal value has no usable `valueOf`: `a < b` throws "Cannot use valueOf" rather than answering
// wrong quietly — so `orderBy(a => a.someDate)` used to THROW, which is the shape half of altea's date
// fields have. A decimal.js value has the opposite failure: its `valueOf` returns the STRING, so `<`
// ordered "10" before "9". Both carry a real comparison of their own.

const date = (s: string): Temporal.PlainDate => Temporal.PlainDate.from(s);
const dateTime = (s: string): Temporal.PlainDateTime => Temporal.PlainDateTime.from(s);

describe("array ordering over values `<` cannot compare", () => {

    test("orderBy / orderByDescending over Temporal keys", () => {
        const rows = [{ k: date("2021-06-01") }, { k: date("2020-01-01") }, { k: date("2022-03-05") }];

        assert.deepEqual(rows.orderBy(r => r.k).map(r => r.k.toString()),
            ["2020-01-01", "2021-06-01", "2022-03-05"]);
        assert.deepEqual(rows.orderByDescending(r => r.k).map(r => r.k.toString()),
            ["2022-03-05", "2021-06-01", "2020-01-01"]);
    });

    test("minBy / maxBy / min / max over Temporal", () => {
        const rows = [{ k: dateTime("2021-06-01T10:00") }, { k: dateTime("2021-06-01T09:00") }];
        assert.equal(rows.minBy(r => r.k)!.k.toString(), "2021-06-01T09:00:00");
        assert.equal(rows.maxBy(r => r.k)!.k.toString(), "2021-06-01T10:00:00");

        const times = [dateTime("2021-06-01T10:00"), dateTime("2021-06-01T09:00")];
        assert.equal(times.min()!.toString(), "2021-06-01T09:00:00");
        assert.equal(times.max()!.toString(), "2021-06-01T10:00:00");
    });

    test("a Duration orders by length, not by its text", () => {
        // "PT2H" < "PT10M" as strings; as durations the opposite.
        const rows = [{ d: Temporal.Duration.from({ hours: 2 }) }, { d: Temporal.Duration.from({ minutes: 10 }) }];
        assert.deepEqual(rows.orderBy(r => r.d).map(r => r.d.total({ unit: "minutes" })), [10, 120]);
    });

    test("a Decimal orders numerically, not as its string", () => {
        const rows = [{ n: new Decimal(9) }, { n: new Decimal(10) }];
        assert.deepEqual(rows.orderBy(r => r.n).map(r => r.n.toNumber()), [9, 10]);
        assert.equal(rows.minBy(r => r.n)!.n.toNumber(), 9);
        assert.equal(rows.maxBy(r => r.n)!.n.toNumber(), 10);
    });

    test("nulls sort first, as a database orders them ascending", () => {
        // `<` and `>` both answered false for a null, so it compared EQUAL to everything and the result
        // depended on the input order.
        const rows = [{ k: date("2021-01-01") }, { k: null }, { k: date("2020-01-01") }];
        assert.deepEqual(rows.orderBy(r => r.k).map(r => r.k?.toString() ?? "null"),
            ["null", "2020-01-01", "2021-01-01"]);
    });

    test("numbers and strings are unaffected", () => {
        assert.deepEqual([3, 1, 2].orderBy(n => n), [1, 2, 3]);
        assert.deepEqual([3, 1, 2].orderByDescending(n => n), [3, 2, 1]);
        assert.deepEqual(["b", "a"].orderBy(s => s), ["a", "b"]);
        assert.equal([3, 1, 2].min(), 1);
        assert.equal([3, 1, 2].max(), 3);
    });
});
