// Client surface for the query-token layer. The token MODEL — the `QueryToken` class, its sub-token
// generation, and the `filterType` / `niceTypeName` / `isGroupable` classification — now lives in
// entities/dynamicQuery/tokens and is generated LOCALLY on the client (server-only tokens arrive via
// QueryClient). This file is a thin re-export of that model plus the CLIENT-only bits Signum kept in
// QueryToken.ts: the token-tree colour (CSS) and the parent-walking helpers.
//
// Where Signum's client used a `queryTokenType` string discriminator (its client token was a flat
// DTO with no class identity), altea categorizes with `instanceof` against the real token subclasses.

import { QueryToken, AggregateToken, CollectionElementToken, CollectionAnyAllToken, CollectionAnyAllType, CollectionToArrayToken } from '../entities/dynamicQuery/tokens';
import type { FilterType } from '../entities/dynamicQueries';
import { QueryTokenString } from './QueryTokenString';

export { QueryToken, SubTokensOptions, SubTokensOptionsAll } from '../entities/dynamicQuery/tokens';

// ---- Presentation: the token-tree colour (CSS variables) -------------------------------------

export function getQueryTokenColor(token: QueryToken): string {
  // Aggregate / collection-navigation tokens (Signum's Aggregate/AnyOrAll/Element/ToArray/Nested).
  if (token instanceof AggregateToken || token instanceof CollectionAnyAllToken ||
    token instanceof CollectionElementToken || token instanceof CollectionToArrayToken)
    return "var(--qt-keyword)" /*#0000FF*/;
  // TODO(phase3+): Nested/Indexer/Manual/Operation/Snippet/TimeSeries tokens → "var(--qt-exotic)".

  if (token.type.array)
    return "var(--qt-collection)"; /*#CE6700*/

  // The query's entity root (altea's rootless RootToken has no parent and key "").
  if (token.parent == undefined)
    return "var(--qt-main-entity)" /*#2B78AF*/;

  switch (token.filterType) {
    case "Integer":
    case "Decimal":
    case "String":
    case "Guid":
    case "Boolean":
      return "var(--qt-value)";

    case "DateTime":
      return "var(--qt-date)" /*#5100A1*/;
    case "Time":
      return "var(--qt-time)" /*#9956db*/;
    case "Enum":
      return "var(--qt-enum)" /*#800046*/;
    case "Lite":
      return "var(--qt-lite)" /* #2B91AF*/;
    case "Embedded":
      return "var(--qt-embedded)" /* #156F8A*/;
    default:
      return "var(--qt-exotic)" /*  #7D7D7D */;
  }
}

// ---- Tree walkers (Signum's QueryToken.ts free functions), over the entities class -----------
// `fullKey` is a METHOD on the altea class; a token's category is its subclass, tested by instanceof.

function getFullKey(token: QueryToken | QueryTokenString<any> | string): string {
  if (token instanceof QueryTokenString)
    return token.token;
  if (typeof token == "object")
    return token.fullKey();
  return token;
}

export function tokenStartsWith(token: QueryToken | QueryTokenString<any> | string, tokenStart: QueryToken | QueryTokenString<any> | string): boolean {
  const t = getFullKey(token);
  const s = getFullKey(tokenStart); // ALTEA: fixed Signum bug (it re-computed from `token`, not `tokenStart`)
  return t == s || t.startsWith(s + ".");
}

export function getTokenParents(token: QueryToken | null | undefined): QueryToken[] {
  const result: QueryToken[] = [];
  while (token) {
    result.insertAt(0, token);
    token = token.parent;
  }
  return result;
}

export function isPrefix(prefix: QueryToken, token: QueryToken): boolean {
  return prefix.fullKey() == token.fullKey() || token.fullKey().startsWith(prefix.fullKey() + ".");
}

export function hasAnyOrAll(token: QueryToken | undefined, recursive: boolean = true): boolean {
  if (token == undefined)
    return false;
  if (token instanceof CollectionAnyAllToken)
    return true;
  return recursive && hasAnyOrAll(token.parent);
}

export function hasAny(token: QueryToken | undefined): boolean {
  if (token == undefined)
    return false;
  if (token instanceof CollectionAnyAllToken && token.anyAllType == CollectionAnyAllType.Any)
    return true;
  return hasAny(token.parent);
}

export function hasAggregate(token: QueryToken | undefined): boolean {
  return token instanceof AggregateToken;
}

export function hasElement(token: QueryToken | undefined): boolean {
  if (token == undefined)
    return false;
  if (token instanceof CollectionElementToken)
    return true;
  return hasElement(token.parent);
}

// The nearest CollectionToArray ancestor, or undefined. altea's class already implements this
// (walking parents) — the free function is kept for Signum call-site parity.
export function hasToArray(token: QueryToken | undefined): QueryToken | undefined {
  return token?.hasToArray();
}

// TODO(phase3+): hasOperation / hasManual / hasNested / hasTimeSeries / hasSnippet — the
// corresponding token subclasses (OperationContainer / Manual / Nested / TimeSeries / Snippet) are
// not ported yet, so these always return false for now.
export function hasOperation(_token: QueryToken | undefined): boolean { return false; }
export function hasManual(_token: QueryToken | undefined): boolean { return false; }
export function hasNested(_token: QueryToken | undefined): boolean { return false; }
export function hasTimeSeries(_token: QueryToken | undefined): boolean { return false; }
export function hasSnippet(_token: QueryToken | undefined): boolean { return false; }

// Signum's `Writable<T>` — strips `readonly` (used to mutate a token/DTO while building it).
export type Writable<T> = { -readonly [P in keyof T]: T[P]; };

// Signum's `completeToken` fills a flat DTO's derived fields (fullKey/niceName/colour/filterType).
// altea's QueryToken is a class that computes those lazily, so a client token is always complete —
// this is a no-op kept for Signum call-site parity.
export function completeToken(token: QueryToken): QueryToken { return token; }
