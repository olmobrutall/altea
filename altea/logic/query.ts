
import { Quoted } from "quote-transformer/quoted";
import { EmbeddedEntity, Entity } from "../entities/entity";
import { IQuery, IOrderedQuery } from "../entities/iquery";
import { CallExpression, ConstantExpression, Expression, LambdaExpression, MethodExpander, PropertyExpression } from "./linq/expressions";
import { ArrayType, LiteralType as SimpleType, ClassType, Type, FunctionType, ObjectType, QuotedFunction, quotedFunction, LambdaTypeResolver, ResultTypeResolver } from "../entities/types";
import { toInt, toLong, toDecimal, inSql } from "../entities/basics";
import { SystemTime } from "../entities/systemTime";

// The query-expression metadata carrier (QuotedFunction) and its cast helper
// (quotedFunction) live in entities/types so entity classes can attach metadata to
// their own methods without depending on logic. Re-exported here for the query layer,
// which augments QuotedFunction with __methodExpander (see logic/linq/expressions.ts).
export { QuotedFunction, quotedFunction, type LambdaTypeResolver, type ResultTypeResolver } from "../entities/types";

export function getLambdaTypeResolvers(target: object, key: string): LambdaTypeResolver[] | undefined {
    const fn = (target as any)?.[key] as QuotedFunction | undefined;
    return fn?.__lambdaType;
}

export function getResultTypeResolver(target: object, key: string): ResultTypeResolver | undefined {
    const fn = (target as any)?.[key] as QuotedFunction | undefined;
    return fn?.__resultType;
}

export function lambdaTypeForParam(paramNumber: number, typeResolver: LambdaTypeResolver) {
    return function (_target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        const value = descriptor.value;
        if (typeof value !== "function")
            throw new Error(`@lambdaTypeForParam can only be applied to methods, but '${String(propertyKey)}' is not a method`);

        const sf = quotedFunction(value as Function);
        var lambdaParams = (sf.__lambdaType ?? []) as LambdaTypeResolver[];
        lambdaParams[paramNumber] = typeResolver;
        sf.__lambdaType = lambdaParams;
    };
}

export function resultType(typeResolver: ResultTypeResolver) {
    return function (_target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        const value = descriptor.value;
        if (typeof value !== "function")
            throw new Error(`@resultType can only be applied to methods, but '${String(propertyKey)}' is not a method`);

        quotedFunction(value as Function).__resultType = typeResolver;
    };
}

// Signum's [SqlMethod(Name = "…")]: marks a static method as a query-only SQL function whose
// call is translated to `<name>(args)`. For a table-valued function the row shape is declared
// separately with @returnType; the QueryBinder recognises the __sqlMethod brand and lowers the
// call to a table-valued-function source.
export function sqlMethod(name: string) {
    return function (_target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        const value = descriptor.value;
        if (typeof value !== "function")
            throw new Error(`@sqlMethod can only be applied to methods, but '${String(propertyKey)}' is not a method`);
        quotedFunction(value as Function).__sqlMethod = name;
    };
}

// The IView row type a table-valued @sqlMethod yields (Signum's `IQueryable<IntValue>` return
// type). Sets the method's result type to `View[]`, both so `.map(m => m.field)` / terminals
// type-check downstream and so the binder can reflect the view's columns off the element type.
export function returnType(viewType: new () => object) {
    return function (_target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        const value = descriptor.value;
        if (typeof value !== "function")
            throw new Error(`@returnType can only be applied to methods, but '${String(propertyKey)}' is not a method`);
        quotedFunction(value as Function).__resultType = () => new ArrayType(new ClassType(viewType));
    };
}

// Marks a method whose calls are rewritten by `expander` during ExpressionSimplifier
// (Signum's [MethodExpander]). The expander receives the receiver + visited args and
// returns a replacement source expression, which is then re-simplified and bound.
export function methodExpander(expander: MethodExpander) {
    return function (_target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        const value = descriptor.value;
        if (typeof value !== "function")
            throw new Error(`@methodExpander can only be applied to methods, but '${String(propertyKey)}' is not a method`);

        quotedFunction(value as Function).__methodExpander = expander;
    };
}


export interface IQueryTranslator {
    execute(t: Expression): Promise<unknown>;
    // Bulk-DML terminal (executeUpdate/executeDelete/executeInsert): binds to a
    // command tree and runs it, returning the affected row count.
    executeCommand(t: Expression): Promise<number>;
    getQueryTextForDebug(t: Query<any>): string
}

// Lite-model / entity eager-load hints for `.expandLite()` / `.expandEntity()`
// (Signum's ExpandLite / ExpandEntity).
export enum ExpandLite { ModelNull, ModelLazy, ModelEager, EntityEager }
export enum ExpandEntity { EagerEntity, LazyEntity }

// Row primary-key helper usable inside a query (Signum's EntityContext). `entityId`
// returns the primary key of the row a value belongs to. (No `mListRowId` — altea has
// no MList; collection rows are ordinary part entities with their own `id`.) Query-only,
// so the in-memory body throws.
export const EntityContext = {
    entityId(_value: unknown): number {
        throw new Error("EntityContext.entityId is a query-only helper");
    },
};
// A captured static-helper receiver: the quote transform dispatches its methods on the
// object itself, and the QueryBinder recognises it by this brand (no import cycle).
(EntityContext as { __isEntityContext?: boolean }).__isEntityContext = true;
// entityId returns a primary-key (number); the binder resolves the actual id expression.
quotedFunction(EntityContext.entityId).__resultType = () => SimpleType.number;

// toInt/toLong (entities/basics) are compile-time int/long BRANDS over a number — used in query
// values (e.g. `year: toInt(a.year * 2)`) to satisfy a branded column's type. In a query the
// brand is meaningless, so the binder lowers the call to its argument (identity); here we just
// give it a result type so fromQuoted can type the call node.
quotedFunction(toInt).__resultType = () => SimpleType.number;
quotedFunction(toLong).__resultType = () => SimpleType.number;
quotedFunction(toDecimal).__resultType = () => SimpleType.number;

// inSql(x) (Signum's LinqHints.InSql) is identity for typing — its result is its argument's
// type. The binder keeps it a CallExpression marker; the nominator force-nominates its arg.
quotedFunction(inSql).__resultType = (_ot, argType) => argType ?? SimpleType.null;

// Number(x) (Signum's Convert to double): a query-side numeric cast. fromQuoted needs a result
// type to type the call node; the binder leaves it residual and the nominator lowers it to a SQL
// CAST to a floating type.
quotedFunction(Number as unknown as Function).__resultType = () => SimpleType.number;

export class Query<T> implements IQuery<T> {

    get type(): ArrayType {
        var at = this.expression.type;
        if (!(at instanceof ArrayType))
            throw new Error("The type of the query should be an array");
        return at;

    }

    get elementType() {

        const at = this.type;
        if (at.elementType == null)
            throw new Error("The type of the query is an array but has an unknown element type");
        return at.elementType;
    }

    constructor(
        public readonly expression: Expression,
        public readonly translator: IQueryTranslator,
    ) {
    }

    @resultType(ot => ot)
    toArray(): Promise<T[]> {
        return this.translator.execute(this.expression) as Promise<T[]>;
    }

    queryTextForDebug(): string {
        return this.translator.getQueryTextForDebug(this);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => ot)
    filter(predicate: Quoted<(element: T) => boolean>): Query<T> {
        var lambda = Expression.fromQuotedLambda(predicate, [this.elementType]);
        var call = new CallExpression(
            new PropertyExpression(this.expression, "filter"),
            [lambda],
            this.type)
        return new Query<T>(call, this.translator);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType, SimpleType.number])
    @resultType((ot, selType) => new ArrayType((selType as FunctionType).returnType))
    map<R>(selector: Quoted<(element: T, index: number) => R>): Query<R> {
        var lambda = Expression.fromQuotedLambda(selector, [this.elementType]);
        var call = new CallExpression(
            new PropertyExpression(this.expression, "map"),
            [lambda],
            new ArrayType(lambda.body.type!));
        return new Query<R>(call, this.translator);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType, SimpleType.number])
    @resultType((ot, colSelType) => (colSelType as FunctionType).returnType)
    flatMap<R>(colSelector: Quoted<(element: T, index: number) => R[] | Query<R>>): Query<R> {
        var lambda = Expression.fromQuotedLambda(colSelector, [this.elementType]);

        if (!(lambda.body.type instanceof ArrayType))
            throw new Error("colSelector should return an Array but returned " + (lambda.body.type?.toString() ?? "null"));
        var call = new CallExpression(
            new PropertyExpression(this.expression, "flatMap"),
            [lambda],
            lambda.body.type);
        return new Query<R>(call, this.translator);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => ot)
    orderBy(selector: Quoted<(element: T) => unknown>): OrderedQuery<T> {
        var lambda = Expression.fromQuotedLambda(selector, [this.elementType]);
        var call = new CallExpression(
            new PropertyExpression(this.expression, "orderBy"),
            [lambda],
            this.type);
        return new OrderedQuery<T>(call, this.translator);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => ot)
    orderByDescending(selector: Quoted<(element: T) => unknown>): OrderedQuery<T> {
        var lambda = Expression.fromQuotedLambda(selector, [this.elementType]);
        var call = new CallExpression(
            new PropertyExpression(this.expression, "orderByDescending"),
            [lambda],
            this.type);
        return new OrderedQuery<T>(call, this.translator);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => SimpleType.number)
    count<R>(predicate?: Quoted<(element: T) => boolean>): Promise<number> {

        var lambda = predicate == null ? null : Expression.fromQuotedLambda(predicate, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "count"),
            lambda ? [lambda] : [],
            SimpleType.number);

        return this.translator.execute(call) as Promise<number>;
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => SimpleType.boolean)
    some<R>(predicate?: Quoted<(element: T) => boolean>): Promise<boolean> {

        var lambda = predicate == null ? null : Expression.fromQuotedLambda(predicate, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "some"),
            lambda ? [lambda] : [],
            SimpleType.boolean);

        return this.translator.execute(call) as Promise<boolean>;
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => SimpleType.boolean)
    every<R>(predicate?: Quoted<(element: T) => boolean>): Promise<boolean> {

        var lambda = predicate == null ? null : Expression.fromQuotedLambda(predicate, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "every"),
            lambda ? [lambda] : [],
            SimpleType.boolean);

        return this.translator.execute(call) as Promise<boolean>;
    }

    @resultType(ot => SimpleType.boolean)
    contains(element: T): Promise<boolean> {
        var call = new CallExpression(
            new PropertyExpression(this.expression, "contains"),
            [new ConstantExpression(element)],
            SimpleType.boolean);

        return this.translator.execute(call) as Promise<boolean>;
    }

    min(): Promise<T & (number | string | boolean | null | undefined)>;
    min<V extends (number | string | boolean | null | undefined)>(valueSelector: Quoted<(element: T) => V>): Promise<V>;
    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType((ot, selType) => selType ? (selType as FunctionType).returnType : (ot as ArrayType).elementType)
    min(valueSelector?: Quoted<(element: T) => unknown>): Promise<unknown> {
        var lambda = valueSelector == null ? null : Expression.fromQuotedLambda(valueSelector, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "min"),
            lambda ? [lambda] : [],
            lambda?.body.type ?? this.elementType);

        return this.translator.execute(call);
    }

    max(): Promise<T & (number | string | boolean | null | undefined)>;
    max<V extends (number | string | boolean | null | undefined)>(valueSelector: Quoted<(element: T) => V>): Promise<V>;
    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType((ot, selType) => selType ? (selType as FunctionType).returnType : (ot as ArrayType).elementType)
    max(valueSelector?: Quoted<(element: T) => unknown>): Promise<unknown> {
        var lambda = valueSelector == null ? null : Expression.fromQuotedLambda(valueSelector, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "max"),
            lambda ? [lambda] : [],
            lambda?.body.type ?? this.elementType);

        return this.translator.execute(call);
    }

    sum(): Promise<T & (number | null | undefined)>;
    sum<V extends (number | null | undefined)>(valueSelector: Quoted<(element: T) => V>): Promise<V>;
    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType((ot, selType) => selType ? (selType as FunctionType).returnType : (ot as ArrayType).elementType)
    sum(valueSelector?: Quoted<(element: T) => unknown>): Promise<unknown> {
        var lambda = valueSelector == null ? null : Expression.fromQuotedLambda(valueSelector, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "sum"),
            lambda ? [lambda] : [],
            lambda?.body.type ?? this.elementType);

        return this.translator.execute(call);
    }

    avg(): Promise<T & (number | null | undefined)>;
    avg<V extends (number | null | undefined)>(valueSelector: Quoted<(element: T) => V>): Promise<V>;
    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType((ot, selType) => selType ? (selType as FunctionType).returnType : (ot as ArrayType).elementType)
    avg(valueSelector?: Quoted<(element: T) => unknown>): Promise<unknown> {
        var lambda = valueSelector == null ? null : Expression.fromQuotedLambda(valueSelector, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "avg"),
            lambda ? [lambda] : [],
            lambda?.body.type ?? this.elementType);

        return this.translator.execute(call);
    }

    // Sample / population standard deviation (Signum's StdDev / StdDevP). Over the element
    // values, or the projected `valueSelector`. Returns a nullable float.
    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(() => SimpleType.number)
    stdDev(valueSelector?: Quoted<(element: T) => unknown>): Promise<number | null> {
        return this.aggregateCall("stdDev", valueSelector);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(() => SimpleType.number)
    stdDevP(valueSelector?: Quoted<(element: T) => unknown>): Promise<number | null> {
        return this.aggregateCall("stdDevP", valueSelector);
    }

    private aggregateCall(op: string, valueSelector?: Quoted<(element: T) => unknown>): Promise<number | null> {
        const lambda = valueSelector == null ? null : Expression.fromQuotedLambda(valueSelector, [this.elementType]);
        const call = new CallExpression(new PropertyExpression(this.expression, op), lambda ? [lambda] : [], SimpleType.number);
        return this.translator.execute(call) as Promise<number | null>;
    }

    @resultType(ot => ot)
    top(count: number): Query<T> {
        var call = new CallExpression(
            new PropertyExpression(this.expression, "top"),
            [new ConstantExpression(count)],
            this.type);
        return new Query<T>(call, this.translator);
    }

    @resultType(ot => ot)
    skip(count: number): Query<T> {
        var call = new CallExpression(
            new PropertyExpression(this.expression, "skip"),
            [new ConstantExpression(count)],
            this.type);
        return new Query<T>(call, this.translator);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => (ot as ArrayType).elementType)
    first<R>(predicate?: Quoted<(element: T) => boolean>): Promise<T> {

        var lambda = predicate == null ? null : Expression.fromQuotedLambda(predicate, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "first"),
            lambda ? [lambda] : [],
            this.elementType);

        return this.translator.execute(call) as Promise<T>;
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => (ot as ArrayType).elementType)
    firstOrNull<R>(predicate?: Quoted<(element: T) => boolean>): Promise<T | null> {

        var lambda = predicate == null ? null : Expression.fromQuotedLambda(predicate, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "firstOrNull"),
            lambda ? [lambda] : [],
            this.elementType);

        return this.translator.execute(call) as Promise<T | null>;
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => (ot as ArrayType).elementType)
    last<R>(predicate?: Quoted<(element: T) => boolean>): Promise<T> {

        var lambda = predicate == null ? null : Expression.fromQuotedLambda(predicate, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "last"),
            lambda ? [lambda] : [],
            this.elementType);

        return this.translator.execute(call) as Promise<T>;
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => (ot as ArrayType).elementType)
    lastOrNull<R>(predicate?: Quoted<(element: T) => boolean>): Promise<T | null> {

        var lambda = predicate == null ? null : Expression.fromQuotedLambda(predicate, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "lastOrNull"),
            lambda ? [lambda] : [],
            this.elementType);

        return this.translator.execute(call) as Promise<T | null>;
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => (ot as ArrayType).elementType)
    single<R>(predicate?: Quoted<(element: T) => boolean>): Promise<T> {

        var lambda = predicate == null ? null : Expression.fromQuotedLambda(predicate, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "single"),
            lambda ? [lambda] : [],
            this.elementType);

        return this.translator.execute(call) as Promise<T>;
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => (ot as ArrayType).elementType)
    singleOrNull<R>(predicate?: Quoted<(element: T) => boolean>): Promise<T | null> {

        var lambda = predicate == null ? null : Expression.fromQuotedLambda(predicate, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "singleOrNull"),
            lambda ? [lambda] : [],
            this.elementType);

        return this.translator.execute(call) as Promise<T | null>;
    }

    @resultType(ot => ot)
    distinct(): Query<T> {
        var call = new CallExpression(
            new PropertyExpression(this.expression, "distinct"),
            [],
            this.type);
        return new Query<T>(call, this.translator);
    }

    // table(T).withHint("NOLOCK" | "INDEX(...)" | …) — a SQL Server table hint (Signum's
    // WithHint), rendered as `<table> AS <alias> WITH(<hint>)`. The hint must land on a table
    // (the binder throws otherwise). Postgres has no table-hint syntax, so it is dropped there.
    @resultType(ot => ot)
    withHint(hint: string): Query<T> {
        var call = new CallExpression(
            new PropertyExpression(this.expression, "withHint"),
            [new ConstantExpression(hint)],
            this.type);
        return new Query<T>(call, this.translator);
    }

    // table(T).overrideSystemTime(new SystemTime.AsOf(instant) | .All(…) | …) — query a
    // system-versioned table's history for THIS query only (Signum's OverrideSystemTime), the
    // per-query counterpart of the ambient SystemTime.override(). The SystemTime travels as a
    // constant the binder reads onto the versioned table's TableExpression.
    @resultType(ot => ot)
    overrideSystemTime(systemTime: SystemTime): Query<T> {
        var call = new CallExpression(
            new PropertyExpression(this.expression, "overrideSystemTime"),
            [new ConstantExpression(systemTime)],
            this.type);
        return new Query<T>(call, this.translator);
    }

    // defaultIfEmpty — used inside a flatMap collection selector, it makes the SelectMany an
    // OUTER APPLY (the outer row survives with a null inner). Signum's DefaultIfEmpty.
    // Divergence: Signum also uses DefaultIfEmpty to express left/right/full joins; altea has
    // explicit join operators for those (join stays string concatenation), so DefaultIfEmpty
    // here is only the outer-apply marker. At the query root it is a no-op.
    @resultType(ot => ot)
    defaultIfEmpty(): Query<T> {
        var call = new CallExpression(
            new PropertyExpression(this.expression, "defaultIfEmpty"),
            [],
            this.type);
        return new Query<T>(call, this.translator);
    }

    groupBy<K>(keySelector: Quoted<(element: T) => K>): Query<{ key: K, elements: T[] }>;
    groupBy<K, E>(keySelector: Quoted<(element: T) => K>, elementSelector: Quoted<(element: T) => E>): Query<{ key: K, elements: E[] }>;


    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @lambdaTypeForParam(1, ot => [(ot as ArrayType).elementType])
    // groupBy yields a *collection* of groupings, so the nested/quoted result type must
    // be an ArrayType(grouping) — matching the eager body's `new ArrayType(groupingType)`
    // below. (Returning a bare ObjectType broke a following `.map`/`.length` in a
    // correlated flatMap — GroupTake.)
    @resultType((ot, keyType, elemType) => new ArrayType(new ObjectType({
        key: (keyType as FunctionType).returnType,
        elements: elemType ? new ArrayType(elemType) : ot
    })))
    groupBy(keySelector: Quoted<(element: T) => unknown>, elementSelector?: Quoted<(element: T) => unknown>): Query<{ key: any, elements: any[] }> {
        var lambdaKey = Expression.fromQuotedLambda(keySelector, [this.elementType]);
        var lambdaElement = elementSelector == null ? null : Expression.fromQuotedLambda(elementSelector, [this.elementType]);

        var groupingType = new ObjectType({
            key: lambdaKey.body.type,
            elements: new ArrayType(lambdaElement?.body.type ?? this.elementType),
        });

        var call = new CallExpression(
            new PropertyExpression(this.expression, "groupBy"),
            lambdaElement == null ? [lambdaKey] : [lambdaKey, lambdaElement],
            new ArrayType(groupingType));

        return new Query<{ key: unknown, elements: unknown[] }>(call, this.translator);
    }


    // String aggregate (Signum's `IEnumerable<T>.ToString(separator)`): concatenates
    // the projected values with a separator (SQL STRING_AGG). `join` is *only* the
    // string aggregate now — the relational joins are innerJoin/leftJoin/rightJoin/
    // fullJoin below.
    @resultType(() => SimpleType.string)
    join(separator: string): Promise<string> {
        var call = new CallExpression(
            new PropertyExpression(this.expression, "join"),
            [new ConstantExpression(separator)],
            SimpleType.string);
        return this.translator.execute(call) as Promise<string>;
    }

    // Relational joins — `outer.<join>(inner, outerKey, innerKey, (o, i) => result)`.
    // The four variants pick the SQL join type (which side is row-preserving):
    //   innerJoin — only matching pairs.
    //   leftJoin  — every outer (left) row; inner (right) is null when unmatched.
    //   rightJoin — every inner (right) row; outer (left) is null when unmatched.
    //   fullJoin  — every row of either side.
    // (Replaces the old single `join` + `.optional()`/DefaultIfEmpty markers.)
    @lambdaTypeForParam(1, ot => [(ot as ArrayType).elementType])
    @lambdaTypeForParam(2, (ot, other) => [(other as ArrayType).elementType])
    @lambdaTypeForParam(3, (ot, other) => [(ot as ArrayType).elementType, (other as ArrayType).elementType])
    @resultType((ot, other, key, otherKey, result) => new ArrayType((result as FunctionType).returnType))
    innerJoin<K, O, R>(otherSource: Query<O>, keySelector: Quoted<(element: T) => K>, otherKeySelector: Quoted<(otherElement: O) => K>, resultSelector: Quoted<(element: T, otherElement: O) => R>): Query<R> {
        return this.relationalJoin("innerJoin", otherSource, keySelector, otherKeySelector, resultSelector);
    }

    @lambdaTypeForParam(1, ot => [(ot as ArrayType).elementType])
    @lambdaTypeForParam(2, (ot, other) => [(other as ArrayType).elementType])
    @lambdaTypeForParam(3, (ot, other) => [(ot as ArrayType).elementType, (other as ArrayType).elementType])
    @resultType((ot, other, key, otherKey, result) => new ArrayType((result as FunctionType).returnType))
    leftJoin<K, O, R>(otherSource: Query<O>, keySelector: Quoted<(element: T) => K>, otherKeySelector: Quoted<(otherElement: O) => K>, resultSelector: Quoted<(element: T, otherElement: O | null) => R>): Query<R> {
        return this.relationalJoin("leftJoin", otherSource, keySelector, otherKeySelector, resultSelector);
    }

    @lambdaTypeForParam(1, ot => [(ot as ArrayType).elementType])
    @lambdaTypeForParam(2, (ot, other) => [(other as ArrayType).elementType])
    @lambdaTypeForParam(3, (ot, other) => [(ot as ArrayType).elementType, (other as ArrayType).elementType])
    @resultType((ot, other, key, otherKey, result) => new ArrayType((result as FunctionType).returnType))
    rightJoin<K, O, R>(otherSource: Query<O>, keySelector: Quoted<(element: T) => K>, otherKeySelector: Quoted<(otherElement: O) => K>, resultSelector: Quoted<(element: T | null, otherElement: O) => R>): Query<R> {
        return this.relationalJoin("rightJoin", otherSource, keySelector, otherKeySelector, resultSelector);
    }

    @lambdaTypeForParam(1, ot => [(ot as ArrayType).elementType])
    @lambdaTypeForParam(2, (ot, other) => [(other as ArrayType).elementType])
    @lambdaTypeForParam(3, (ot, other) => [(ot as ArrayType).elementType, (other as ArrayType).elementType])
    @resultType((ot, other, key, otherKey, result) => new ArrayType((result as FunctionType).returnType))
    fullJoin<K, O, R>(otherSource: Query<O>, keySelector: Quoted<(element: T) => K>, otherKeySelector: Quoted<(otherElement: O) => K>, resultSelector: Quoted<(element: T | null, otherElement: O | null) => R>): Query<R> {
        return this.relationalJoin("fullJoin", otherSource, keySelector, otherKeySelector, resultSelector);
    }

    private relationalJoin<K, O, R>(op: string, otherSource: Query<O>, keySelector: Quoted<(element: T) => K>, otherKeySelector: Quoted<(otherElement: O) => K>, resultSelector: Quoted<(element: any, otherElement: any) => R>): Query<R> {
        var lambdaKey = Expression.fromQuotedLambda(keySelector, [this.elementType]);
        var lambdaOtherKey = Expression.fromQuotedLambda(otherKeySelector, [otherSource.elementType]);
        var lambdaResult = Expression.fromQuotedLambda(resultSelector, [this.elementType, otherSource.elementType]);

        // The other source travels with the call (the binder reads it as args[0]); the
        // operator name (innerJoin/leftJoin/…) tells the binder the SQL join type.
        var call = new CallExpression(
            new PropertyExpression(this.expression, op),
            [otherSource.expression, lambdaKey, lambdaOtherKey, lambdaResult],
            new ArrayType(lambdaResult.body.type!));

        return new Query<R>(call, this.translator);
    }

    // ---- bulk DML (set-based UPDATE / DELETE / INSERT … SELECT) ---------------
    // Each builds a command CallExpression the QueryBinder lowers to a
    // Update/Delete/InsertSelect command node; the translator formats it and runs it
    // via executeQuery, returning the affected row count. The setter/selector lambdas
    // are `Quoted<>` so the transformer captures them as expressions.

    // table(T)[.filter(…)].executeUpdate(a => ({ field: valueExpr, … })) → affected rows.
    // The setter returns the partial set of columns to write (keys validated against T;
    // values loose, since `int`/`PrimaryKey` are branded numbers and value expressions
    // widen to `number`).
    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(() => SimpleType.number)
    executeUpdate(setter: Quoted<(element: T) => PartialRec<T>>): Promise<number> {
        var lambda = Expression.fromQuotedLambda(setter, [this.elementType]);
        var call = new CallExpression(new PropertyExpression(this.expression, "executeUpdate"), [lambda], SimpleType.number);
        return this.translator.executeCommand(call);
    }

    // table(T)[.filter(…)].executeDelete() → affected rows.
    @resultType(() => SimpleType.number)
    executeDelete(): Promise<number> {
        var call = new CallExpression(new PropertyExpression(this.expression, "executeDelete"), [], SimpleType.number);
        return this.translator.executeCommand(call);
    }

    // table(S)[.filter(…)].executeInsert(TargetEntity, s => ({ …fields })) → inserted rows.
    @lambdaTypeForParam(1, ot => [(ot as ArrayType).elementType])
    @resultType(() => SimpleType.number)
    executeInsert<E>(target: new () => E, selector: Quoted<(element: T) => PartialRec<E>>): Promise<number> {
        var lambda = Expression.fromQuotedLambda(selector, [this.elementType]);
        var call = new CallExpression(
            new PropertyExpression(this.expression, "executeInsert"),
            [new ConstantExpression(target, new ClassType(target)), lambda],
            SimpleType.number);
        return this.translator.executeCommand(call);
    }

    // minBy/maxBy — the element with the min/max projected value (Signum's MinBy/MaxBy;
    // the binder rewrites to orderBy[Descending](selector).firstOrNull()). Decorated so it
    // also types when used inside a query group (`g.elements.maxBy(…)`).
    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => (ot as ArrayType).elementType)
    minBy(selector: Quoted<(element: T) => unknown>): Promise<T | null> {
        const lambda = Expression.fromQuotedLambda(selector, [this.elementType]);
        const call = new CallExpression(new PropertyExpression(this.expression, "minBy"), [lambda], this.elementType);
        return this.translator.execute(call) as Promise<T | null>;
    }
    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => (ot as ArrayType).elementType)
    maxBy(selector: Quoted<(element: T) => unknown>): Promise<T | null> {
        const lambda = Expression.fromQuotedLambda(selector, [this.elementType]);
        const call = new CallExpression(new PropertyExpression(this.expression, "maxBy"), [lambda], this.elementType);
        return this.translator.execute(call) as Promise<T | null>;
    }

    // reverse — invert the current ordering (the binder lowers it via the Reverse flag).
    @resultType(ot => ot)
    reverse(): Query<T> {
        var call = new CallExpression(new PropertyExpression(this.expression, "reverse"), [], this.type);
        return new Query<T>(call, this.translator);
    }

    // orderAlsoByKeys — append the source entities' primary keys as ORDER BY tie-breakers
    // (Signum's OrderAlsoByKeys), so a query ordered by a non-unique key paginates in a stable,
    // deterministic total order. The binder lowers it via the OrderAlsoByKeys flag.
    @resultType(ot => ot)
    orderAlsoByKeys(): Query<T> {
        var call = new CallExpression(new PropertyExpression(this.expression, "orderAlsoByKeys"), [], this.type);
        return new Query<T>(call, this.translator);
    }

    // ofType / cast — narrow a polymorphic-reference query to one implementation
    // (Signum's OfType/Cast). The binder rewrites cast(T) to `map(x => x as T)` and
    // ofType(T) to `filter(x => x instanceof T).map(x => x as T)`.
    ofType<S>(type: new (...args: any[]) => S): Query<S> {
        const call = new CallExpression(
            new PropertyExpression(this.expression, "ofType"),
            [new ConstantExpression(type, new ClassType(type))],
            new ArrayType(new ClassType(type)));
        return new Query<S>(call, this.translator);
    }
    cast<S>(type: new (...args: any[]) => S): Query<S> {
        const call = new CallExpression(
            new PropertyExpression(this.expression, "cast"),
            [new ConstantExpression(type, new ClassType(type))],
            new ArrayType(new ClassType(type)));
        return new Query<S>(call, this.translator);
    }

    // Bulk-DML variant: chunked delete — a pure utility (Signum's UnsafeDeleteChunks),
    // not a distinct command: it just deletes `order by id, top(chunkSize)` repeatedly
    // until a pass removes fewer than a full chunk.
    async executeDeleteChunks(chunkSize: number = 10000, maxChunks: number = Number.MAX_SAFE_INTEGER): Promise<number> {
        let total = 0;
        for (let i = 0; i < maxChunks; i++) {
            const num = await this.orderBy(a => (a as Entity).id).top(chunkSize).executeDelete();
            total += num;
            if (num < chunkSize)
                break;
        }
        return total;
    }

    // executeUpdatePart — update a *navigated* entity reached from each source row
    // (Signum's UnsafeUpdatePart): `partSelector` picks the entity/reference to update; the
    // `setter` object's KEYS name the part's columns, while its VALUES are read from the
    // ROOT source element (Signum binds the value selector to the root, so a value can
    // reach any field of the source projection, not only the navigated part).
    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @lambdaTypeForParam(1, ot => [(ot as ArrayType).elementType])
    @resultType(() => SimpleType.number)
    executeUpdatePart<P>(partSelector: Quoted<(element: T) => P>, setter: Quoted<(root: T) => PartialRec<P>>): Promise<number> {
        var partLambda = Expression.fromQuotedLambda(partSelector, [this.elementType]);
        var setterLambda = Expression.fromQuotedLambda(setter, [this.elementType]);
        var call = new CallExpression(new PropertyExpression(this.expression, "executeUpdatePart"), [partLambda, setterLambda], SimpleType.number);
        return this.translator.executeCommand(call);
    }

    // Lite-model / entity eager-load hints (Signum's ExpandLite/ExpandEntity): tag the
    // selected Lite/Entity in the projector so materialization loads its model/entity eager,
    // lazy, or not at all. The selector navigates to the target (identity `a => a` = the whole
    // projected value); the hint travels as a constant the binder reads.
    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    expandLite(liteSelector: Quoted<(element: T) => unknown>, hint: ExpandLite): Query<T> {
        const lambda = Expression.fromQuotedLambda(liteSelector, [this.elementType]);
        const call = new CallExpression(new PropertyExpression(this.expression, "expandLite"),
            [lambda, new ConstantExpression(hint)], this.type);
        return new Query<T>(call, this.translator);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    expandEntity(entitySelector: Quoted<(element: T) => unknown>, hint: ExpandEntity): Query<T> {
        const lambda = Expression.fromQuotedLambda(entitySelector, [this.elementType]);
        const call = new CallExpression(new PropertyExpression(this.expression, "expandEntity"),
            [lambda, new ConstantExpression(hint)], this.type);
        return new Query<T>(call, this.translator);
    }
}

// The partial set of columns an executeUpdate writes: `{ field: value, … }`. Keys are
// validated against the entity (typos caught); values are loose because `int`/`PrimaryKey`
// are branded numbers and update value expressions (`a.year * 2`) widen to `number`.

export class OrderedQuery<T> extends Query<T> implements IOrderedQuery<T> {

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => ot)
    thenBy(selector: Quoted<(value: T) => unknown>): OrderedQuery<T> {
        var lambda = Expression.fromQuotedLambda(selector, [this.elementType]);
        var call = new CallExpression(
            new PropertyExpression(this.expression, "thenBy"),
            [lambda],
            this.type);
        return new OrderedQuery<T>(call, this.translator);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType(ot => ot)
    thenByDescending(selector: Quoted<(value: T) => unknown>): OrderedQuery<T> {
        var lambda = Expression.fromQuotedLambda(selector, [this.elementType]);
        var call = new CallExpression(
            new PropertyExpression(this.expression, "thenByDescending"),
            [lambda],
            this.type);
        return new OrderedQuery<T>(call, this.translator);
    }
}

// `reduce` has no SQL translation — a dev reaching for it in a query (e.g.
// `g.elements.reduce((acc, a) => acc + a.value, 0)`) almost always wants a SQL aggregate.
// A collection in a quoted query dispatches its methods to OrderedQuery.prototype, so
// attaching throwing query-metadata to `reduce` turns the otherwise cryptic
// "Missing @lambdaTypeForParam 'reduce'" front-end error into a clear, educational one.
// This only affects quoted queries; native Array.reduce over a materialised array is untouched.
function rejectReduceInQuery(): never {
    throw new Error(
        "'reduce' cannot be translated to SQL. Use a SQL aggregate instead — sum, min, max, " +
        "count, or average — e.g. `g.elements.sum(a => a.value)` (and `count(a => predicate)` " +
        "to count matches).");
}
(OrderedQuery.prototype as unknown as { reduce: QuotedFunction }).reduce =
    Object.assign(function (): never { return rejectReduceInQuery(); }, {
        __lambdaType: [rejectReduceInQuery as unknown as LambdaTypeResolver],
        __resultType: rejectReduceInQuery as unknown as ResultTypeResolver,
    });

type PartialRec<T> = {
    [P in keyof T]?:
    T[P] extends EmbeddedEntity ? PartialRec<T[P]> :
    T[P] extends EmbeddedEntity | null ? PartialRec<T[P]> | null :
    T[P];
};