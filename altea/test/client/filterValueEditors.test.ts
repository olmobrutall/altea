import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import {
  isFullTextSearch, isComplexFullTextSearch, hasMixedListOperations, getFilterOperations,
} from "@altea/altea/client/FindOptions";
import type { FilterConditionOptionParsed, FilterGroupOptionParsed } from "@altea/altea/client/FindOptions";
import { SearchMessage } from "@altea/altea/data/uiMessages";

// The three questions the filter-value editors ask before choosing a control (FinderRules'
// "TextArea" / "VectorSmartSearch" / "FilterGroup" rules) — plus the messages those rules say it with.
// Pure predicates, so they are tested here rather than through a rendered SearchControl.

const cond = (operation: FilterConditionOptionParsed["operation"]): FilterConditionOptionParsed =>
  ({ token: undefined, operation, value: undefined, frozen: false } as unknown as FilterConditionOptionParsed);

const group = (filters: (FilterConditionOptionParsed | FilterGroupOptionParsed)[], splitValue?: boolean): FilterGroupOptionParsed =>
  ({ groupOperation: "And", filters, value: undefined, frozen: false, pinned: splitValue ? { splitValue: true } : undefined } as unknown as FilterGroupOptionParsed);

describe("full-text filter operations", () => {

  // The operations whose VALUE is a query in the dialect's own syntax: they get a textarea and a syntax
  // cheat-sheet, everything else a one-line editor.
  test("isFullTextSearch covers the SQL Server and Postgres sets, and nothing else", () => {
    for (const op of ["ComplexCondition", "FreeText", "TsQuery", "TsQuery_Plain", "TsQuery_Phrase", "TsQuery_WebSearch"] as const)
      assert.equal(isFullTextSearch(op), true, op);

    for (const op of ["EqualTo", "Contains", "IsIn", "SmartSearch"] as const)
      assert.equal(isFullTextSearch(op), false, op);

    assert.equal(isFullTextSearch(undefined), false);
  });

  // Only the two with a real grammar defer the search while the user is still typing the expression.
  test("isComplexFullTextSearch is the grammar-carrying subset", () => {
    assert.equal(isComplexFullTextSearch("ComplexCondition"), true);
    assert.equal(isComplexFullTextSearch("TsQuery"), true);
    assert.equal(isComplexFullTextSearch("FreeText"), false);
    assert.equal(isComplexFullTextSearch("TsQuery_Plain"), false);
    assert.equal(isComplexFullTextSearch(undefined), false);
  });

  // `SmartSearch` is a VECTOR operation, not a full-text one: it is the only operation a Vector column
  // offers, and it has no syntax at all — which is what SearchMessage.SmartSearchDescription says.
  test("a Vector column offers SmartSearch alone", () => {
    const ops = getFilterOperations({ filterType: "Vector" } as any);
    assert.deepEqual(ops, ["SmartSearch"]);
    assert.equal(isFullTextSearch("SmartSearch"), false);
    assert.ok(SearchMessage.SmartSearchDescription.niceToString().length > 0);
  });
});

describe("filter group mixed list/non-list operations", () => {

  // A group holds ONE value for all its conditions, so `is in` (an array) and `equals` (a scalar) cannot
  // share it. FinderRules renders SearchMessage.Error + the explanation instead of an editor.
  test("a mixture is rejected", () => {
    assert.equal(hasMixedListOperations(group([cond("IsIn"), cond("EqualTo")])), true);
    assert.equal(hasMixedListOperations(group([cond("EqualTo"), cond("IsNotIn")])), true);
  });

  test("a consistent group is fine, either way round", () => {
    assert.equal(hasMixedListOperations(group([cond("IsIn"), cond("IsNotIn")])), false);
    assert.equal(hasMixedListOperations(group([cond("EqualTo"), cond("Contains")])), false);
    assert.equal(hasMixedListOperations(group([])), false);
  });

  // `splitValue` splits the typed value per condition, so each gets the shape it wants.
  test("splitValue is the escape hatch", () => {
    assert.equal(hasMixedListOperations(group([cond("IsIn"), cond("EqualTo")], true)), false);
  });

  // The scan goes all the way down: a nested group's conditions share the OUTER group's value too.
  test("nested groups are scanned", () => {
    assert.equal(hasMixedListOperations(group([cond("IsIn"), group([cond("EqualTo")])])), true);
    assert.equal(hasMixedListOperations(group([cond("IsIn"), group([cond("IsNotIn")])])), false);
  });

  // An operation-less condition (the user has picked a token but not an operation yet) is not evidence
  // either way — it must not make a well-formed group look mixed.
  test("a condition with no operation yet is ignored", () => {
    assert.equal(hasMixedListOperations(group([cond("IsIn"), cond(undefined)])), false);
  });

  test("both messages the guard renders exist and are localizable", () => {
    assert.ok(SearchMessage.FilterGroupInvalidMixedOperations.niceToString().includes("'Split'"));
    assert.equal(SearchMessage.Error.niceToString(), "Error");
  });
});

describe("the SearchMessage members behind the ported UI", () => {

  test("SelectRow0_ formats the row's position", () => {
    assert.equal(SearchMessage.SelectRow0_.niceToString(3), "Select row 3");
  });

  test("GroupPrefix labels a filter group's own token", () => {
    assert.equal(SearchMessage.GroupPrefix.niceToString(), "Group prefix");
  });

  test("_0Rows_N is the export row count, distinct from _0Results_N", () => {
    assert.notEqual(SearchMessage._0Rows_N.niceToString(), SearchMessage._0Results_N.niceToString());
    assert.equal(SearchMessage._0Rows_N.niceToString().formatWith(25), "25 rows");
  });

  test("the two query-auditor refusals take their placeholders in Signum's order", () => {
    assert.equal(
      SearchMessage.NoResultsFoundBecauseTheRule0DoesNotAllowedToExplore1WithoutFilteringFirst
        .niceToString().formatWith("FilteringByTarget", "Operation logs"),
      "No results found because the rule FilteringByTarget does not allow exploring Operation logs without filtering first");
    assert.equal(
      SearchMessage.NoResultsFoundBecauseYouAreNotAllowedToExplore0WithoutFilteringBy1First
        .niceToString().formatWith("Operation logs", "Target"),
      "No results found because you are not allowed to explore Operation logs without filtering by Target first");
  });

  test("Query0NotAllowed names the refused query", () => {
    assert.equal(SearchMessage.Query0NotAllowed.niceToString("OperationLog"), "Query OperationLog is not allowed");
  });
});
