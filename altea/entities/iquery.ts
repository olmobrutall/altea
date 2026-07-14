import { Quoted } from "quote-transformer/quoted";

// Shared, server-agnostic query surface. Lives in entities/ so entity classes
// can *declare* navigation methods that return IQuery<T> (e.g. via same-module
// interface merging) without importing the server-only Query<T> implementation.
// The concrete Query<T> in logic/ implements this interface.
export interface IQuery<T> {
    toArray(): Promise<T[]>;
    queryTextForDebug(): string;

    filter(predicate: Quoted<(element: T) => boolean>): IQuery<T>;
    map<R>(selector: Quoted<(element: T, index: number) => R>): IQuery<R>;
    flatMap<R>(colSelector: Quoted<(element: T, index: number) => R[] | IQuery<R>>): IQuery<R>;

    orderBy(selector: Quoted<(element: T) => unknown>): IOrderedQuery<T>;
    orderByDescending(selector: Quoted<(element: T) => unknown>): IOrderedQuery<T>;

    count(predicate?: Quoted<(element: T) => boolean>): Promise<number>;
    some(predicate?: Quoted<(element: T) => boolean>): Promise<boolean>;
    every(predicate?: Quoted<(element: T) => boolean>): Promise<boolean>;

    min(): Promise<T & (number | string | boolean | null | undefined)>;
    min<V extends (number | string | boolean | null | undefined)>(valueSelector: Quoted<(element: T) => V>): Promise<V>;

    max(): Promise<T & (number | string | boolean | null | undefined)>;
    max<V extends (number | string | boolean | null | undefined)>(valueSelector: Quoted<(element: T) => V>): Promise<V>;

    sum(): Promise<T & (number | null | undefined)>;
    sum<V extends (number | null | undefined)>(valueSelector: Quoted<(element: T) => V>): Promise<V>;

    avg(): Promise<T & (number | null | undefined)>;
    avg<V extends (number | null | undefined)>(valueSelector: Quoted<(element: T) => V>): Promise<V>;

    top(count: number): IQuery<T>;
    skip(count: number): IQuery<T>;
    withHint(hint: string): IQuery<T>;
    // overrideSystemTime is added by interface expansion in logic/query.ts (it's a
    // server-only feature whose SystemTime type lives in the logic layer).

    first(predicate?: Quoted<(element: T) => boolean>): Promise<T>;
    firstOrNull(predicate?: Quoted<(element: T) => boolean>): Promise<T | null>;
    last(predicate?: Quoted<(element: T) => boolean>): Promise<T>;
    lastOrNull(predicate?: Quoted<(element: T) => boolean>): Promise<T | null>;
    single(predicate?: Quoted<(element: T) => boolean>): Promise<T>;
    singleOrNull(predicate?: Quoted<(element: T) => boolean>): Promise<T | null>;

    distinct(): IQuery<T>;

    groupBy<K>(keySelector: Quoted<(element: T) => K>): IQuery<{ key: K; elements: T[] }>;
    groupBy<K, E>(keySelector: Quoted<(element: T) => K>, elementSelector: Quoted<(element: T) => E>): IQuery<{ key: K; elements: E[] }>;

    // String aggregate (Signum's ToString(separator)) — the relational joins are below.
    join(separator: string): Promise<string>;

    innerJoin<K, O, R>(
        otherSource: IQuery<O>,
        keySelector: Quoted<(element: T) => K>,
        otherKeySelector: Quoted<(otherElement: O) => K>,
        resultSelector: Quoted<(element: T, otherElement: O) => R>,
    ): IQuery<R>;
    leftJoin<K, O, R>(
        otherSource: IQuery<O>,
        keySelector: Quoted<(element: T) => K>,
        otherKeySelector: Quoted<(otherElement: O) => K>,
        resultSelector: Quoted<(element: T, otherElement: O | null) => R>,
    ): IQuery<R>;
    rightJoin<K, O, R>(
        otherSource: IQuery<O>,
        keySelector: Quoted<(element: T) => K>,
        otherKeySelector: Quoted<(otherElement: O) => K>,
        resultSelector: Quoted<(element: T | null, otherElement: O) => R>,
    ): IQuery<R>;
    fullJoin<K, O, R>(
        otherSource: IQuery<O>,
        keySelector: Quoted<(element: T) => K>,
        otherKeySelector: Quoted<(otherElement: O) => K>,
        resultSelector: Quoted<(element: T | null, otherElement: O | null) => R>,
    ): IQuery<R>;
}

export interface IOrderedQuery<T> extends IQuery<T> {
    thenBy(selector: Quoted<(value: T) => unknown>): IOrderedQuery<T>;
    thenByDescending(selector: Quoted<(value: T) => unknown>): IOrderedQuery<T>;
}
