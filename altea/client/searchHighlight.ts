import { TextHighlighter } from "./Components/Typeahead";
import type { QueryToken } from "./QueryToken";
import type { FilterOptionParsed, FilterConditionOptionParsed } from "./FindOptions";
import { isFilterCondition, isFilterGroup } from "./FindOptions";
import type { FilterOperation } from "../data/dynamicQueries";
import type SearchControlLoaded from "./SearchControl/SearchControlLoaded";
import type { Quoted } from "quote-transformer/quoted";

// Search-result highlighting (Signum's FinderRules getKeywords + similarTokenToStr + TextHighlighter),
// extracted from FinderRules.tsx. The string cell formatters there bold the search terms that matched, so
// a result column shows WHY it matched: `getKeywords(columnToken, activeFilters)` collects the string
// values filtered on THIS column (the pinned search box's words for a splitValue group, or a plain
// Contains/StartsWith/EqualTo value), and a TextHighlighter wraps each occurrence in <strong>. Negative
// operators (NotContains/…) don't highlight. ALTEA: no "Entity." prefix (rootless tokens) and token keys
// compared case-insensitively.

// ---- Expression-dependency extraction (@quoted toString / calculated properties) -----------------

// Two tokens are "similar" for highlighting purposes (Signum's similarTokenToStr) when they refer to the
// same searchable text — INCLUDING an EXPRESSION token vs the column(s) its @quoted body reads. That is
// what lets a search on `ToStr` highlight `CompanyName` (Supplier.toString → companyName), or a search on
// a calculated `FullName` highlight `FirstName`/`LastName` (fullName → firstName + lastName), and vice
// versa. Not limited to toString — any @quoted member (a calculated property) participates.
export function similarTokenToStr(tokenF: QueryToken | undefined, tokenC: QueryToken): boolean {
  if (tokenF == undefined)
    return false;

  if (keyEq(tokenF.fullKey(), tokenC.fullKey()))
    return true;

  // Either side may be an expression token whose @quoted body reads other columns — match against those.
  return matchesExpressionDep(tokenF, tokenC) || matchesExpressionDep(tokenC, tokenF);
}

function keyEq(a: string | undefined, b: string | undefined): boolean {
  return a != undefined && b != undefined && a.toLowerCase() == b.toLowerCase();
}

// Does `other` name one of the columns that `exprToken`'s @quoted expression reads? Each dependency is
// joined onto the expression's parent path (rootless → the dep IS the full key).
function matchesExpressionDep(exprToken: QueryToken, other: QueryToken): boolean {
  const steps = getExpressionDependencies(exprToken);
  if (steps == null)
    return false;

  const parentKey = exprToken.parent?.fullKey() ?? "";
  return steps.some(dep => keyEq(parentKey ? parentKey + "." + dep : dep, other.fullKey()));
}

// The columns a token's @quoted expression reads, or null when the token is a plain column with no quoted
// expression (then only exact-key highlighting applies). Resolves the token's expression member on the
// OWNER entity type (`token.parent.type`): `toString` for a ToString token, otherwise the token's own key
// (a calculated @quoted property — e.g. a `fullName` method). Deps from every implementation are merged
// (polymorphic references).
export function getExpressionDependencies(token: QueryToken): string[] | null {
  const owner = token.parent;
  if (owner == null)
    return null;

  const memberName = token.key == "ToString" ? "toString" : token.key;

  const all: string[] = [];
  let any = false;
  for (const ti of owner.type.typeInfos()) {
    const fn = (ti.ctor?.prototype as Record<string, unknown> | undefined)?.[memberName];
    if (typeof fn != "function")
      continue;
    const deps = quotedDependencies(fn);
    if (deps != null) {
      any = true;
      all.push(...deps);
    }
  }
  return any ? all.distinctBy(a => a) : null;
}

// The member-path dependencies of ANY quoted function — the properties its body reads off the lambda
// parameter (Supplier.toString → ["companyName"], a FullName expression → ["firstName","lastName"]). Signum
// parses the serialized expression with a regex; altea walks the quote-transformer's `__quoted` AST — exact
// and minification-proof. Null when the function carries no `__quoted` (a plain, non-quoted method). Cached
// per function reference.
const quotedDepsCache = new Map<Function, string[] | null>();

function quotedDependencies(fn: Function): string[] | null {
  const cached = quotedDepsCache.get(fn);
  if (cached !== undefined)
    return cached;

  const ex = (fn as Quoted<Function>).__quoted?.();
  let result: string[] | null = null;
  if (Array.isArray(ex) && ex[0] === "=>") {
    const paramName = ex[1]?.[0]?.[1];              // ExLambda = ["=>", [["p", name]], body]
    const out: string[] = [];
    collectParamMemberPaths(ex[2], paramName, out);
    result = out.distinctBy(a => a);
  }
  quotedDepsCache.set(fn, result);
  return result;
}

// Walk a quote-transformer QuotedEx tree, collecting every maximal member chain rooted at the lambda
// parameter (`this.companyName` → "companyName", `this.address.city` → "address.city"). Recurses through
// binary/call/template nodes so a concatenation like `firstName + " " + lastName` yields both fields.
function collectParamMemberPaths(node: any, paramName: string, out: string[]): void {
  if (!Array.isArray(node) || node.length == 0)
    return;

  const tag = node[0];
  if (tag == "c" || tag == "p")                     // constant / bare parameter — no member path
    return;

  if (tag == "." || tag == "?.") {
    const path = memberChainToParam(node, paramName);
    if (path != null) {                             // a maximal chain rooted at the param — captured whole
      out.push(path);
      return;
    }
  }

  for (let i = 1; i < node.length; i++) {
    const child = node[i];
    if (Array.isArray(child)) {
      if (typeof child[0] == "string")
        collectParamMemberPaths(child, paramName, out);           // a nested QuotedEx node
      else
        for (const e of child) collectParamMemberPaths(e, paramName, out); // an array of nodes (call args / [])
    } else if (child != null && typeof child == "object") {
      for (const v of Object.values(child)) collectParamMemberPaths(v, paramName, out); // {} property values
    }
  }
}

// If `node` is a `.`/`?.` chain (through `as` casts) that bottoms out at the lambda parameter, return the
// dotted member path (root-first); otherwise null (the chain roots at a call result, indexer, etc.).
function memberChainToParam(node: any, paramName: string): string | null {
  const parts: string[] = [];
  let n = node;
  while (Array.isArray(n)) {
    const tag = n[0];
    if (tag == "." || tag == "?.") { parts.unshift(n[2]); n = n[1]; }
    else if (tag == "as") { n = n[1]; }
    else if (tag == "p") { return n[1] == paramName ? parts.join(".") : null; }
    else return null;
  }
  return null;
}

// ---- Keyword collection + the highlighter constructor --------------------------------------------

function isNegativeOp(op: FilterOperation): boolean {
  return op == "NotStartsWith" || op == "NotContains" || op == "NotEndsWith" || op == "NotLike" || op == "IsNotIn";
}

function splitKeywords(value: unknown, splitValue: boolean | undefined, operation: FilterOperation): string[] {
  if (typeof value == "string" && (splitValue || operation == "FreeText"))
    return value.split(/\s+/).filter(a => a.length > 0);

  if (typeof value == "string")
    return value.length ? [value] : [];

  if (typeof value == "number")
    return [value.toString()];

  if ((operation == "IsIn" || operation == "IsNotIn") && Array.isArray(value))
    return value.map(a => typeof a == "string" ? a : typeof a == "number" ? a.toString() : null).notNull();

  return [];
}

export function getKeywords(token: QueryToken, filters: FilterOptionParsed[] | undefined): string[] | undefined {
  if (filters == null)
    return undefined;

  function getFiltersKeywords(fo: FilterOptionParsed): string[] {
    if (isFilterGroup(fo)) {
      // A pinned splitValue group holds ONE search string in `fo.value`; split it and attribute it to any
      // subfilter whose token matches the column being rendered (the id+text / search-box case).
      if (fo.value != null && fo.pinned && typeof fo.value == "string") {
        const conds = fo.filters.notNull().filter(sf => isFilterCondition(sf) && sf.token != null) as FilterConditionOptionParsed[];
        return conds
          .filter(sf => similarTokenToStr(sf.token, token) && sf.operation != null && !isNegativeOp(sf.operation))
          .flatMap(sf => splitKeywords(fo.value, fo.pinned?.splitValue, sf.operation!));
      }
      return fo.filters.notNull().flatMap(getFiltersKeywords).distinctBy(a => a);
    }

    if (fo.token != null && fo.operation != null && !isNegativeOp(fo.operation) && similarTokenToStr(fo.token, token))
      return splitKeywords(fo.value, fo.pinned?.splitValue, fo.operation);

    return [];
  }

  return filters.notNull().flatMap(getFiltersKeywords).distinctBy(a => a);
}

// A highlighter for `token`'s cells, built from the SearchControl's ACTIVE (result) filters. Empty when
// nothing was searched on this column, in which case `.highlight()` returns the text unchanged.
export function cellHighlighter(token: QueryToken, sc: SearchControlLoaded | undefined): TextHighlighter {
  return new TextHighlighter(getKeywords(token, sc?.state.resultFindOptions?.filterOptions));
}
