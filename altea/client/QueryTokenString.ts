// Signum.React/Reflection.ts QueryTokenString<T>, extracted to its own file. A typed, chainable
// query-token STRING builder — `T` is PHANTOM (the class only carries `token: string`; the type
// parameter drives the fluent return types). Used to write query tokens in a strongly-typed way,
// e.g. `Type.token(a => a.name)` → "Name".

import type { Entity, BaseEntity, MixinEntity, Type } from '../entities/entity';
import type { Lite } from '../entities/lite';
import type { FilterOperation } from '../entities/dynamicQueries';
import type { OrderType, FilterGroupOperation } from '../entities/dynamicQueries';
import { getLambdaMembers } from './binding';
import { getTypeName } from './Reflection';
import type { Quoted } from 'quote-transformer/quoted';
import type {
  FilterConditionOption, FilterGroupOption, FilterOption, OrderOption, ColumnOption,
  ExtraFilterConditionOptions, ExtraFilterGroupOptions, ColumnDisplayOptions,
} from './FindOptions';

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

  systemValidFrom(): QueryTokenString<unknown> { return new QueryTokenString<unknown>(this.token + ".SystemValidFrom"); }
  systemValidTo(): QueryTokenString<unknown> { return new QueryTokenString<unknown>(this.token + ".SystemValidTo"); }
  getToString(): QueryTokenString<string> { return new QueryTokenString<string>(this.token + ".ToString"); }

  // ALTEA: a `Type<R>`-typed value doesn't expose the static `typeName` through its construct
  // signature, so the clean name comes from getTypeName(t) (Signum used `t.typeName` directly).
  cast<R extends Entity>(t: Type<R>): QueryTokenString<R> { return new QueryTokenString<R>(this.token + ".(" + getTypeName(t) + ")"); }

  append<S>(lambdaToProperty: Quoted<(v: T) => S>): QueryTokenString<S> {
    const seq = tokenSequence(lambdaToProperty, !this.token);
    return new QueryTokenString<S>(this.token + (this.token && seq ? "." : "") + seq);
  }

  mixin<M extends MixinEntity>(_t: Type<M>): QueryTokenString<M> { return new QueryTokenString<M>(this.token); }

  expression<S>(expressionName: string): QueryTokenString<S> { return new QueryTokenString<S>(this.token + (this.token ? "." : "") + expressionName); }

  any(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".Any"); }
  all(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".All"); }
  notAll(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".NotAll"); }
  notAny(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".NotAny"); }

  separatedByComma(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".SeparatedByComma"); }
  separatedByCommaDistinct(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".SeparatedByCommaDistinct"); }
  separatedByNewLine(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".SeparatedByNewLine"); }
  separatedByNewLineDistinct(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".SeparatedByNewLineDistinct"); }

  nested(): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + ".Nested"); }
  nestedMap<S>(selector: (n: QueryTokenString<ArrayElement<T>>) => S): S { return selector(new QueryTokenString<ArrayElement<T>>(this.token + ".Nested")); }

  element(index = 1): QueryTokenString<ArrayElement<T>> { return new QueryTokenString<ArrayElement<T>>(this.token + (this.token ? "." : "") + "Element" + (index === 1 ? "" : index)); }

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
  filter(operation: FilterOperation, value: FilterValue<T>, options?: ExtraFilterConditionOptions): FilterConditionOption;
  filter(operation: FilterOperation, value: any, options?: ExtraFilterConditionOptions): FilterConditionOption {
    return { token: this, operation, value, ...options };
  }

  /** Builds an order option on this token. */
  order(orderType: OrderType): OrderOption {
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
  filterGroup(groupOperation: FilterGroupOperation, options: ExtraFilterGroupOptions, selector: (t: TokenFunction<T>) => (FilterOption | null | undefined)[]): FilterGroupOption {
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
export function filterGroup(groupOperation: FilterGroupOperation, options: ExtraFilterGroupOptions, filters: (FilterOption | null | undefined)[]): FilterGroupOption {
  return { groupOperation, filters, ...options };
}
