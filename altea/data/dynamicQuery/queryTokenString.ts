// Signum.React/Reflection.ts QueryTokenString<T>, extracted to its own file. A typed, chainable
// query-token STRING builder — `T` is PHANTOM (the class only carries `token: string`; the type
// parameter drives the fluent return types). Used to write query tokens in a strongly-typed way,
// e.g. `Type.token(a => a.name)` → "Name".
//
// It lives in DATA, not client, because naming a column is not a UI concern: the server executes stored
// user queries, and a test arranges a search the same way the SearchControl does. Signum has it in its
// React project alone, which is why its own test suites address a column by string.

import type { Entity, BaseEntity, MixinEntity, Type } from '../entity';
import type { Lite } from '../lite';
import type { FilterOperationKeys, OrderTypeKeys, FilterGroupOperationKeys } from '../dynamicQueries';
import { getLambdaMembers } from '../lambdaMembers';
import { cleanTypeName } from '../registration';
import type { Quoted } from 'quote-transformer/quoted';
import type {
  FilterConditionOption, FilterGroupOption, FilterOption, OrderOption, ColumnOption,
  ExtraFilterConditionOptions, ExtraFilterGroupOptions, ColumnDisplayOptions,
} from './queryOptions';

// The element type of a collection token (Signum stripped MListElement here; altea has no
// MListElement — a `@part` collection is a plain array — so it is simply the array element).
type ArrayElement<A> = A extends (infer E)[] ? E : never;

// Turns a property lambda into a dotted, PascalCased token path (Signum's tokenSequence). The
// leading "entity" hop of a `Lite<T>` navigation is dropped for convenience; `toStr` maps to the
// query column "ToString".
export function tokenSequence(lambdaToProperty: Quoted<Function>, isFirst: boolean): string {
  return getLambdaMembers(lambdaToProperty)
    .filter((a, i) => a.name !== "entity" || (i === 0 && isFirst))
    .map(a => a.name === "toStr" ? "ToString" : a.name.firstUpper())
    .join(".");
}

export class QueryTokenString<T> {
  token: string;
  constructor(token: string) { this.token = token; }

  toString(): string { return this.token; }

  static entity<T extends Entity = Entity>(): QueryTokenString<T> { return new QueryTokenString<T>("Entity"); }
  static readonly count: QueryTokenString<number> = new QueryTokenString<number>("Count");
  static readonly timeSeries: QueryTokenString<string> = new QueryTokenString<string>("TimeSeries");

  // The two system-time tokens of a @systemVersioned type. Signum's are built-in sub-tokens of its
  // `Entity` root token ("Entity.SystemValidFrom"); altea has no `Entity` root token at all, and these are
  // registered EXPRESSIONS over `systemPeriod()` (see OperationLogic.registerSystemValidTokens) — so the
  // key is the bare one, whatever this builder was chained off. Kept as instance methods so Signum's
  // `QueryTokenString.entity().systemValidFrom()` reads across unchanged.
  systemValidFrom(): QueryTokenString<unknown> { return new QueryTokenString<unknown>("SystemValidFrom"); }
  systemValidTo(): QueryTokenString<unknown> { return new QueryTokenString<unknown>("SystemValidTo"); }
  getToString(): QueryTokenString<string> { return new QueryTokenString<string>(this.token + ".ToString"); }

  // ALTEA: a `Type<R>`-typed value doesn't expose the static `typeName` through its construct
  // signature, so the clean name comes from cleanTypeName(t) (Signum used `t.typeName` directly).
  cast<R extends Entity>(t: Type<R>): QueryTokenString<R> { return new QueryTokenString<R>(this.token + ".(" + cleanTypeName(t) + ")"); }

  append<S>(lambdaToProperty: Quoted<(v: T) => S>): QueryTokenString<S> {
    const seq = tokenSequence(lambdaToProperty, !this.token);
    return new QueryTokenString<S>(this.token + (this.token && seq ? "." : "") + seq);
  }

  mixin<M extends MixinEntity>(_t: Type<M>): QueryTokenString<M> { return new QueryTokenString<M>(this.token); }

  expression<S>(expressionName: string): QueryTokenString<S> { return new QueryTokenString<S>(this.token + (this.token ? "." : "") + expressionName); }

  // A quantifier over a collection. The optional lambda is what a `@valueField` row makes worth having:
  // altea's collection element is a `@part` ROW where Signum's `MList<string>` element is the string
  // itself, so the value Signum filters as `Telephones.Any` is `Telephones.Any.Telephone` here. Both
  // spellings of that hop are supported and mean the same thing —
  //
  //     token(a => a.telephones).any().append(a => a.telephone).filter("EqualsTo", "213234")
  //     token(a => a.telephones).any(a => a.telephone).filter("EqualsTo", "213234")
  //
  // — and there is no third: the typed builder never produces the bare `Telephones.Any` as a value,
  // because that token IS the row. (LEGACY MODE accepts it when READING a Signum-stored token, which is
  // `appendLegacyValueField`, one direction only.)
  any(): QueryTokenString<ArrayElement<T>>;
  any<S>(lambdaToProperty: Quoted<(v: ArrayElement<T>) => S>): QueryTokenString<S>;
  any(lambdaToProperty?: Quoted<(v: any) => any>): QueryTokenString<any> { return this.quantifier("Any", lambdaToProperty); }

  all(): QueryTokenString<ArrayElement<T>>;
  all<S>(lambdaToProperty: Quoted<(v: ArrayElement<T>) => S>): QueryTokenString<S>;
  all(lambdaToProperty?: Quoted<(v: any) => any>): QueryTokenString<any> { return this.quantifier("All", lambdaToProperty); }

  notAll(): QueryTokenString<ArrayElement<T>>;
  notAll<S>(lambdaToProperty: Quoted<(v: ArrayElement<T>) => S>): QueryTokenString<S>;
  notAll(lambdaToProperty?: Quoted<(v: any) => any>): QueryTokenString<any> { return this.quantifier("NotAll", lambdaToProperty); }

  notAny(): QueryTokenString<ArrayElement<T>>;
  notAny<S>(lambdaToProperty: Quoted<(v: ArrayElement<T>) => S>): QueryTokenString<S>;
  notAny(lambdaToProperty?: Quoted<(v: any) => any>): QueryTokenString<any> { return this.quantifier("NotAny", lambdaToProperty); }

  private quantifier(kind: string, lambdaToProperty?: Quoted<(v: any) => any>): QueryTokenString<any> {
    const q = new QueryTokenString<any>(this.token + "." + kind);
    return lambdaToProperty == undefined ? q : q.append(lambdaToProperty);
  }

  separatedByComma(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".SeparatedByComma"); }
  separatedByCommaDistinct(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".SeparatedByCommaDistinct"); }
  separatedByNewLine(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".SeparatedByNewLine"); }
  separatedByNewLineDistinct(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".SeparatedByNewLineDistinct"); }

  nested(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".Nested"); }
  nestedMap<S>(selector: (n: QueryTokenString<ArrayElement<T>>) => S): S { return selector(new QueryTokenString<ArrayElement<T>>(this.token + ".Nested")); }

  // As the quantifiers above: the optional lambda reaches the element's `@valueField` in one call.
  element(index?: number): QueryTokenString<ArrayElement<T>>;
  element<S>(index: number, lambdaToProperty: Quoted<(v: ArrayElement<T>) => S>): QueryTokenString<S>;
  element(index = 1, lambdaToProperty?: Quoted<(v: any) => any>): QueryTokenString<any> {
    const e = new QueryTokenString<any>(this.token + (this.token ? "." : "") + "Element" + (index === 1 ? "" : index));
    return lambdaToProperty == undefined ? e : e.append(lambdaToProperty);
  }

  count(option?: "Distinct" | "Null" | "NotNull"): QueryTokenString<number> { return new QueryTokenString<number>(this.token + (this.token ? "." : "") + "Count" + (option == undefined ? "" : option)); }

  min(): QueryTokenString<T> { return new QueryTokenString<T>(this.token + ".Min"); }
  max(): QueryTokenString<T> { return new QueryTokenString<T>(this.token + ".Max"); }
  sum(): QueryTokenString<T> { return new QueryTokenString<T>(this.token + ".Sum"); }
  average(): QueryTokenString<T> { return new QueryTokenString<T>(this.token + ".Average"); }

  hasValue(): QueryTokenString<boolean> { return new QueryTokenString<boolean>(this.token + ".HasValue"); }
  matchSnippet(): QueryTokenString<string> { return new QueryTokenString<string>(this.token + ".Snippet"); }
  matchRank(): QueryTokenString<number> { return new QueryTokenString<number>(this.token + ".Rank"); }
  tsvector(column = "tsvector"): QueryTokenString<string> { return new QueryTokenString<string>(this.token + "." + column); }
  translated(): QueryTokenString<string> { return new QueryTokenString<string>(this.token + ".Translated"); }
  indexer<S>(prefix: string, key: string): QueryTokenString<S> { return new QueryTokenString<S>(this.token + ".[" + prefix + "].[" + key + "]"); }

  mlistElementProperty(property: "RowId" | "RowOrder" | "RowPartitionId"): QueryTokenString<string | number> {
    return new QueryTokenString<string | number>(this.token + "." + property);
  }

  // ---- FindOptions builders (Signum) — filter / order / column / filterGroup on this token -----

  /** Builds a filter condition option on this token. The value type depends on the operation. */
  filter(operation: "IsIn" | "IsNotIn", value: FilterValue<T>[] | null | undefined, options?: ExtraFilterConditionOptions): FilterConditionOption;
  filter(operation: "Between" | "BetweenNoEnd", value: [FilterValue<T>, FilterValue<T>], options?: ExtraFilterConditionOptions): FilterConditionOption;
  filter(operation: FilterOperationKeys, value: FilterValue<T>, options?: ExtraFilterConditionOptions): FilterConditionOption;
  filter(operation: FilterOperationKeys, value: any, options?: ExtraFilterConditionOptions): FilterConditionOption {
    return { token: this, operation, value, ...options };
  }

  /** Builds an order option on this token. */
  order(orderType: OrderTypeKeys): OrderOption {
    return { token: this, orderType };
  }

  /** Builds a column option on this token. */
  column(displayName?: string | (() => string), options?: ColumnDisplayOptions): ColumnOption;
  column(options: ColumnDisplayOptions & { displayName?: string | (() => string) }): ColumnOption;
  column(displayNameOrOptions?: string | (() => string) | (ColumnDisplayOptions & { displayName?: string | (() => string) }), options?: ColumnDisplayOptions): ColumnOption {
    if (displayNameOrOptions != null && typeof displayNameOrOptions == "object")
      return { token: this, ...displayNameOrOptions };
    return { token: this, displayName: displayNameOrOptions, ...options };
  }

  /**
   * Builds a filter group anchored on this token; the inner filters are scoped to this token's value
   * through the `t` factory (typically used after `.any()` / `.all()` / `.element()`).
   */
  filterGroup(groupOperation: FilterGroupOperationKeys, options: ExtraFilterGroupOptions, selector: (t: TokenFunction<T>) => (FilterOption | null | undefined)[]): FilterGroupOption {
    return {
      token: this,
      groupOperation,
      filters: selector(createTokenFunction<T>(this)),
      ...options,
    };
  }
}

/** Accepted filter value for a token of type `T`: a `Lite<E>` token also accepts the entity `E`, and vice-versa. */
export type FilterValue<T> =
  T extends Lite<infer E> ? Lite<E> | E | null | undefined :
  T extends Entity ? Lite<T> | T | null | undefined :
  T | null | undefined;

/** The query row for `T`: the entity's columns, plus the `Entity` column (Signum's Anonymous<T>). */
export type Anonymous<T> = T & {
  /** Represents the 'Entity' column in the query selector. */
  entity: T;
};

type AnonymousOf<T> = T extends BaseEntity ? Anonymous<T> : T;

/** A {@link QueryTokenString} factory scoped to `T`, provided by `Type.findOptions` and anchored filter groups. */
export interface TokenFunction<T> {
  /** `token()` — the token this factory is rooted at (the entity, or the collection element after any()/all()/element()). */
  (): QueryTokenString<T>;
  /** `token(a => a.name)` — navigates the entity graph; the accessed property path becomes the token. */
  <S>(lambdaToColumn: Quoted<(v: AnonymousOf<T>) => S>): QueryTokenString<S>;
  /** `token<V>("Key")` — escape hatch for a query-only column with no entity-graph home. */
  <S = unknown>(columnName: string): QueryTokenString<S>;
}

export function createTokenFunction<T>(base: QueryTokenString<any>): TokenFunction<T> {
  return ((arg?: Quoted<(v: any) => any> | string): QueryTokenString<any> =>
    arg == null ? base :
      typeof arg == "string" ? base.expression(arg) :
        base.append(arg)) as TokenFunction<T>;
}

/** Builds a root filter group (AND / OR of the given filters), for use in `filterOptions`. */
export function filterGroup(groupOperation: FilterGroupOperationKeys, options: ExtraFilterGroupOptions, filters: (FilterOption | null | undefined)[]): FilterGroupOption {
  return { groupOperation, filters, ...options };
}
