// The react-layer half of Signum's `Type<T>` descriptor. In Signum entity types are `new Type("X")`
// instances carrying `token()` / `findOptions()` / `fetchOptions()` / `typedResultsOptions()`; in
// altea the entity CLASS itself is the Type descriptor (BaseEntity already has the entities-side
// statics typeName / niceName / create / resolveType), so these query-building statics are ADDED to
// the class here — they return client types (QueryTokenString / FindOptions), so they live in react.
//
//   OrderEntity.findOptions(token => ({
//     filterOptions: [token(a => a.state).filter(FilterOperation.EqualTo, "Open")],
//     orderOptions:  [token(a => a.orderDate).order(OrderType.Descending)],
//     columnOptions: [token(a => a.id), token(a => a.customer).column("Customer")],
//   }))
//
// Import this module once at client startup to install the statics (mirrors ./QueryClient).

import { BaseEntity, type Type } from '../data/entity';
import {
  QueryTokenString, tokenSequence, createTokenFunction,
  type TokenFunction, type Anonymous,
} from './QueryTokenString';
import type { FindOptions, FetchOptions, TypedResultsOptions, ResultObject, OptionalQueryName } from './FindOptions';
import type { Quoted } from 'quote-transformer/quoted';

// Add the statics to the entity-class side (namespace ⋈ class merge → static members; inherited by
// every entity subclass). `this: Type<T>` binds to the concrete entity constructor at the call site.
declare module '../data/entity' {
  namespace BaseEntity {
    /** A {@link QueryTokenString} rooted at this type (Signum's Type.token). `S` (the column result
     * type) is the explicit type arg; `T` infers from `this`, so `token<number>("Expr")` works. */
    export function token<T extends BaseEntity>(this: Type<T>): QueryTokenString<Anonymous<T>>;
    export function token<S, T extends BaseEntity = BaseEntity>(this: Type<T>, lambdaToColumn: Quoted<(v: Anonymous<T>) => S>): QueryTokenString<S>;
    export function token<S = unknown, T extends BaseEntity = BaseEntity>(this: Type<T>, columnName: string): QueryTokenString<S>;

    /** A strongly-typed {@link FindOptions} rooted at this type; `queryName` defaults to this type. */
    export function findOptions<T extends BaseEntity>(this: Type<T>, builder?: (token: TokenFunction<T>) => OptionalQueryName<FindOptions<T>>): FindOptions<T>;
    /** A {@link FetchOptions} rooted at this type (Finder.fetchLites / fetchEntities). */
    export function fetchOptions<T extends BaseEntity>(this: Type<T>, builder?: (token: TokenFunction<T>) => OptionalQueryName<FetchOptions<T>>): FetchOptions<T>;
    /** A {@link TypedResultsOptions} rooted at this type (Finder.getTypedResults). */
    export function typedResultsOptions<T extends BaseEntity, RO extends ResultObject>(this: Type<T>, builder: (token: TokenFunction<T>) => OptionalQueryName<TypedResultsOptions<RO>>): TypedResultsOptions<RO>;
    // NOTE: per-query settings registration moved OFF the Type<T> static onto the ClientBuilder fluent
    // API — `cb.configure(Type).withQuerySettings(token => …)` (see ./ClientBuilder). The old
    // `Type.querySettings(…)` static was removed.
  }
}

// Runtime install. Assigned through a cast (the declared statics are an overloaded set; a single impl
// isn't directly assignable to that type, but the bodies are the faithful Signum implementations).
const impls = {
  token(this: Type<BaseEntity>, lambdaToColumn?: ((a: any) => any) | string): QueryTokenString<any> {
    if (lambdaToColumn == null)
      return new QueryTokenString("");
    if (typeof lambdaToColumn === "string")
      return new QueryTokenString(lambdaToColumn);
    return new QueryTokenString(tokenSequence(lambdaToColumn, true));
  },
  findOptions(this: Type<BaseEntity>, builder?: (token: TokenFunction<any>) => OptionalQueryName<FindOptions<any>>): FindOptions<any> {
    if (builder == null)
      return { queryName: this };
    const fo = builder(createTokenFunction(new QueryTokenString("")));
    if (!fo.queryName)
      fo.queryName = this;
    return fo as FindOptions<any>;
  },
  fetchOptions(this: Type<BaseEntity>, builder?: (token: TokenFunction<any>) => OptionalQueryName<FetchOptions<any>>): FetchOptions<any> {
    if (builder == null)
      return { queryName: this };
    const fo = builder(createTokenFunction(new QueryTokenString("")));
    if (!fo.queryName)
      fo.queryName = this;
    return fo as FetchOptions<any>;
  },
  typedResultsOptions(this: Type<BaseEntity>, builder: (token: TokenFunction<any>) => OptionalQueryName<TypedResultsOptions<any>>): TypedResultsOptions<any> {
    const to = builder(createTokenFunction(new QueryTokenString("")));
    if (!to.queryName)
      to.queryName = this;
    return to as TypedResultsOptions<any>;
  },
};

Object.assign(BaseEntity as unknown as Record<string, unknown>, impls);
