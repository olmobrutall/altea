// Client surface for the query-token layer. The token MODEL — the `QueryToken` class, its sub-token
// generation, and the `filterType` / `niceTypeName` / `isGroupable` classification — now lives in
// entities/dynamicQuery/tokens and is generated LOCALLY on the client (server-only tokens arrive via
// QueryClient). This file is a thin re-export of that model plus the CLIENT-only bits Signum kept in
// QueryToken.ts: the token-tree colour (CSS) and the parent-walking helpers.
//
// Where Signum's client used a `queryTokenType` string discriminator (its client token was a flat
// DTO with no class identity), altea categorizes with `instanceof` against the real token subclasses.

import { QueryToken } from '../data/dynamicQuery/tokens';
import { QueryTokenString } from './QueryTokenString';

export { QueryToken, SubTokensOptions, SubTokensOptionsAll } from '../data/dynamicQuery/tokens';

// Signum's react `ManualToken` / `ManualCellDto` (QueryToken.ts). `ManualToken` (here) is the lightweight
// DESCRIPTOR a `registerManualSubTokens` provider returns — the QueryTokenBuilder turns each into a real
// `ManualToken` token-class instance (data/dynamicQuery/tokens/manualToken). `ManualCellDto` is the
// per-row value a manual column projects; the QuickLinkClient's CellQuickLink formatter reads it.
export interface ManualToken {
  toStr: string;
  niceName: string;
  key: string;
  typeColor?: string;
  niceTypeName: string;
  subToken?: Promise<ManualToken[]>;
}
export type { ManualCellDto } from '../data/dynamicQuery/tokens/manualToken';

// The token-CATEGORY predicates (isAggregate/isAnyOrAll/isElement/isToArray), the parent-walking
// `has*` checks (hasAnyOrAll/hasAny/hasAggregate/hasElement/hasToArray/hasOperation/hasManual/…) and
// the token-tree colour (`queryTokenColor`) are now INSTANCE METHODS on the entities QueryToken class
// (base returns false; the collection/aggregate subclasses override). Signum kept them as free
// functions over a flat DTO; altea calls `token.isAnyOrAll()` / `token.queryTokenColor` directly.
// Only the genuinely multi-argument / null-tolerant utilities stay free here.

export function tokenStartsWith(token: QueryToken | QueryTokenString<any> | string, tokenStart: QueryToken | QueryTokenString<any> | string): boolean {

  function getFullKey(token: QueryToken | QueryTokenString<any> | string): string {
    if (token instanceof QueryTokenString)
      return token.token;
    if (token instanceof QueryToken)
      return token.fullKey();
    return token;
  }

  const t = getFullKey(token);
  const s = getFullKey(tokenStart); // ALTEA: fixed Signum bug (it re-computed from `token`, not `tokenStart`)
  return t == s || t.startsWith(s + ".");
}

// Signum's `Writable<T>` — strips `readonly` (used to mutate a token/DTO while building it).
export type Writable<T> = { -readonly [P in keyof T]: T[P]; };

// Signum's `completeToken` filled a flat DTO's derived fields (fullKey/niceName/colour/filterType).
// altea's QueryToken is a class that computes those lazily, so a client token is always complete —
// this is a no-op kept for Signum call-site parity.
export function completeToken(token: QueryToken): QueryToken { return token; }
