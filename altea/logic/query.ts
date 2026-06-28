
import { ExLambda, Quoted } from "quote-transformer/quoted";
import { IQuery, IOrderedQuery } from "../entities/iquery";
import { CallExpression, ConstantExpression, Expression, LambdaExpression, PropertyExpression } from "./linq/expressions";
import { ArrayType, LiteralType as SimpleType, ClassType, Type, FunctionType, ObjectType } from "../entities/types";

export type LambdaTypeResolver = (thisType: Type, ...argsTypes: Type[]) => Type[];
export type ResultTypeResolver = (thisType: Type, ...argsTypes: Type[]) => Type;

export interface StaticFunction<T extends Function> {
    __lambdaType?: LambdaTypeResolver[];
    __resultType?: ResultTypeResolver;
    __quoted?: () => ExLambda;
}

export function asStaticFunction<T extends Function>(func: T): StaticFunction<T> {
    return func as any as StaticFunction<T>;
}

export function getLambdaTypeResolvers(target: object, key: string): LambdaTypeResolver[] | undefined {
    const fn = (target as any)?.[key] as StaticFunction<Function> | undefined;
    return fn?.__lambdaType;
}

export function getResultTypeResolver(target: object, key: string): ResultTypeResolver | undefined {
    const fn = (target as any)?.[key] as StaticFunction<Function> | undefined;
    return fn?.__resultType;
}

// Two call shapes:
//   @quoted        — bare. The quote-transformer rewrites it to @quoted(() => <expr>)
//                    before emit, so this overload exists only so the bare form
//                    type-checks as a method decorator.
//   @quoted(exp)   — the rewritten/explicit form the transformer produces.
export function quoted(target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): void;
export function quoted(exp?: () => ExLambda): (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => void;
export function quoted(arg1?: unknown, arg2?: unknown, _arg3?: unknown): unknown {
    // Bare @quoted reached runtime (applied directly as a decorator: arg2 is a
    // property key). The transformer should have rewritten it to @quoted(() => <expr>).
    if (typeof arg2 === "string" || typeof arg2 === "symbol")
        throw new Error(`Unable to add the quoted expression to "${String(arg2)}". Are you using ts-patch and quote-transformer?`);

    const exp = arg1 as (() => ExLambda) | undefined;
    return function (_target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): void {

        if (exp == undefined)
            throw new Error(`Unable to add the quoted expression to "${String(propertyKey)}". Are you using ts-patch and quote-transformer?`);

        const fn = descriptor.value;
        if (typeof fn != "function")
            throw new Error(`@quoted can only be applied to methods, but '${String(propertyKey)}' is not a method`);

        (fn as StaticFunction<Function>).__quoted = exp;
    };
}

export function withQuoted<T extends Function>(f: T, quoted?: () => ExLambda): T {
    (f as StaticFunction<T>).__quoted = quoted;
    return f;
}

export function lambdaTypeForParam(paramNumber: number, typeResolver: LambdaTypeResolver) {
    return function (_target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        const value = descriptor.value;
        if (typeof value !== "function")
            throw new Error(`@lambdaTypeForParam can only be applied to methods, but '${String(propertyKey)}' is not a method`);

        const sf = value as StaticFunction<Function>;
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

        (value as StaticFunction<Function>).__resultType = typeResolver;
    };
}


export interface IQueryTranslator {
    execute(t: Expression): Promise<unknown>;
    getQueryTextForDebug(t: Query<any>): string
}

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

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType((ot, selType) => new ArrayType((selType as FunctionType).returnType))
    map<R>(selector: Quoted<(element: T) => R>): Query<R> {
        var lambda = Expression.fromQuotedLambda(selector, [this.elementType]);
        var call = new CallExpression(
            new PropertyExpression(this.expression, "map"),
            [lambda],
            new ArrayType(lambda.body.type!));
        return new Query<R>(call, this.translator);
    }

    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @resultType((ot, colSelType) => (colSelType as FunctionType).returnType)
    flatMap<R>(colSelector: Quoted<(element: T) => R[] | Query<R>>): Query<R> {
        var lambda = Expression.fromQuotedLambda(colSelector, [this.elementType]);

        if (!(lambda.body.type instanceof Array))
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
    @resultType((ot, at) => SimpleType.number)
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
    @resultType((ot, at) => SimpleType.number)
    avg(valueSelector?: Quoted<(element: T) => unknown>): Promise<unknown> {
        var lambda = valueSelector == null ? null : Expression.fromQuotedLambda(valueSelector, [this.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "avg"),
            lambda ? [lambda] : [],
            lambda?.body.type ?? this.elementType);

        return this.translator.execute(call);
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
    nullIfEmpty(): Query<T | null> {
        var call = new CallExpression(
            new PropertyExpression(this.expression, "nullIfEmpty"),
            [],
            this.type);
        return new Query<T>(call, this.translator);
    }


    @resultType(ot => ot)
    distinct(): Query<T> {
        var call = new CallExpression(
            new PropertyExpression(this.expression, "distinct"),
            [],
            this.type);
        return new Query<T>(call, this.translator);
    }

    groupBy<K>(keySelector: Quoted<(element: T) => K>): Query<{ key: K, elements: T[] }>;
    groupBy<K, E>(keySelector: Quoted<(element: T) => K>, elementSelector: Quoted<(element: T) => E>): Query<{ key: K, elements: E[] }>;


    @lambdaTypeForParam(0, ot => [(ot as ArrayType).elementType])
    @lambdaTypeForParam(1, ot => [(ot as ArrayType).elementType])
    @resultType((ot, keyType, elemType) => new ObjectType({
        key: (keyType as FunctionType).returnType,
        elements: elemType ? new ArrayType(elemType) : ot
    }))
    groupBy(keySelector: Quoted<(element: T) => unknown>, elementSelector?: Quoted<(element: T) => unknown>): Query<{ key: unknown, elements: unknown[] }> {
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


    @lambdaTypeForParam(1, ot => [(ot as ArrayType).elementType])
    @lambdaTypeForParam(2, (ot, other) => [(other as ArrayType).elementType])
    @lambdaTypeForParam(3, (ot, other) => [(ot as ArrayType).elementType, (other as ArrayType).elementType])
    @resultType((ot, other, key, otherKey, result) => new ArrayType((result as FunctionType).returnType))
    join<K, O, R>(
        otherSource: Query<O>,
        keySelector: Quoted<(element: T) => K>,
        otherKeySelector: Quoted<(otherElement: O) => K>,
        resultSelector: Quoted<(element: T, otherElement: O) => R>
    ): Query<R> {
        var lambdaKey = Expression.fromQuotedLambda(keySelector, [this.elementType]);
        var lambdaOtherKey = Expression.fromQuotedLambda(otherKeySelector, [otherSource.elementType]);
        var lambdaResult = Expression.fromQuotedLambda(resultSelector, [this.elementType, otherSource.elementType]);

        var call = new CallExpression(
            new PropertyExpression(this.expression, "join"),
            [lambdaKey, lambdaOtherKey, lambdaResult],
            this.expression.type!);

        return new Query<R>(call, this.translator);
    }
}

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
