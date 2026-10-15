import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { Decimal } from "@altea/altea/data/basics";
import { parseNumberFilterValue } from "@altea/altea/client/FindOptions";
import type { QueryToken } from "@altea/altea/client/QueryToken";

// A number filter value as its column holds it. Result cells and URL filters carry numbers as STRINGS (JSON
// has no decimal or bigint), and the old parse truncated a decimal through parseInt: "49.90" was sent as 49.

const token = (filterType: string, typeName: string): Pick<QueryToken, "filterType" | "type"> =>
  ({ filterType, type: { typeName } } as unknown as Pick<QueryToken, "filterType" | "type">);

describe("number filter values", () => {

  test("a decimal stays exact", () => {
    const v = parseNumberFilterValue(token("Decimal", "Decimal"), "49.90");
    assert.ok(v instanceof Decimal);
    assert.equal(v.toString(), "49.9");

    const long = parseNumberFilterValue(token("Decimal", "Decimal"), "12345678901234567890.123456789");
    assert.equal(String(long), "12345678901234567890.123456789");
  });

  test("a bigint keeps every digit", () => {
    assert.equal(parseNumberFilterValue(token("Integer", "BigInt"), "9007199254740993"), "9007199254740993");
    assert.equal(parseNumberFilterValue(token("Integer", "BigInt"), "-42"), "-42");
    assert.equal(parseNumberFilterValue(token("Integer", "BigInt"), "4.5"), undefined);
  });

  test("a plain number column keeps its fraction", () => {
    assert.equal(parseNumberFilterValue(token("Integer", "Number"), "7"), 7);
    assert.equal(parseNumberFilterValue(token("Integer", "Number"), "1.5"), 1.5);
  });

  test("what is not a number is no value, and a typed value passes through", () => {
    assert.equal(parseNumberFilterValue(token("Integer", "Number"), "abc"), undefined);
    assert.equal(parseNumberFilterValue(token("Decimal", "Decimal"), "abc"), undefined);
    assert.equal(parseNumberFilterValue(token("Decimal", "Decimal"), "  "), undefined);

    const d = new Decimal("3.25");
    assert.equal(parseNumberFilterValue(token("Decimal", "Decimal"), d), d);
    assert.equal(parseNumberFilterValue(token("Integer", "Number"), 3), 3);
  });
});
