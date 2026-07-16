import type { ExLambda } from "quote-transformer/quoted";

export abstract class RuntimeType {
    // The element type when this is a collection type (ArrayType); null otherwise.
    get elementType(): RuntimeType | null { return null; }
}

export class ArrayType extends RuntimeType {
    constructor(private readonly element: RuntimeType) {
        super()
    }
    override get elementType(): RuntimeType { return this.element; }
}

export class FunctionType extends RuntimeType {
    constructor(
        public readonly func: Function | undefined,
        public readonly returnType: RuntimeType) {
        super()
    }
}

export class LiteralType extends RuntimeType {

    static readonly boolean: LiteralType = new LiteralType("boolean");
    static readonly number: LiteralType = new LiteralType("number");
    static readonly string: LiteralType = new LiteralType("string");
    static readonly null: LiteralType = new LiteralType("null");

    constructor(public readonly typeName: "boolean" | "number" | "string" | "null") {
        super()
    }
}

export class ClassType extends RuntimeType {
    constructor(public readonly constructorFunction: Function) {
        super()
    }
}

// A Lite<T> reference. `entityType` is the wrapped entity type (T). Distinct from
// ClassType so the query layer can tell a lite from a full entity — e.g. method
// dispatch routes to Lite.prototype, and `lite.entity` resolves to `entityType`.
export class LiteType extends RuntimeType {
    constructor(public readonly entityType: RuntimeType) {
        super()
    }
}

// A temporal column/value (Temporal.PlainDateTime / PlainDate / Duration). Distinct
// so the query layer can translate date-part access (`.year`, `.quarter()`, `.dayOfWeek`)
// to SQL and dispatch date methods to the right prototype.
export class TemporalType extends RuntimeType {
    constructor(public readonly kind: "dateTime" | "date" | "duration") {
        super()
    }
}

export class ObjectType extends RuntimeType {
    constructor(public readonly bindings: { [name: string]: RuntimeType | undefined }) {
        super()
    }
}

// A time period (Signum's NullableInterval<DateTime>) — the result of `entity.systemPeriod()`
// on a system-versioned table. `.min`/`.max` are the (nullable) bounds of `elementType`
// (a dateTime); the whole value materialises to a NullableInterval whose `.overlaps`/`.contains`
// run in memory. The binder lowers it to an IntervalExpression over the period columns.
export class IntervalType extends RuntimeType {
    constructor(public readonly boundType: RuntimeType) {
        super()
    }
}

// An enum column/value. Stored as its underlying int, but carries the enum object
// so the query layer can translate `.toString()` to a value→name CASE.
export class EnumType extends RuntimeType {
    constructor(public readonly enumObject: object, public readonly enumName: string) {
        super()
    }
}

// Query-expression metadata carried on a function value (Signum's method attributes:
// [SqlMethod], expression bodies, computed result/lambda types). It lives here in
// entities/ — rather than logic/ — so entity classes can attach metadata to their own
// methods (`quotedFunction(Entity.isLite).__resultType = …`) without an unsafe
// `{ __resultType?: … }` cast and without depending on the query engine.
//
// Fields whose types need the Expression API (logic/) can't be declared here; logic
// adds them by declaration-merging this interface (see `__methodExpander` in
// logic/linq/expressions.ts).
export type LambdaTypeResolver = (thisType: RuntimeType, ...argsTypes: RuntimeType[]) => RuntimeType[];
export type ResultTypeResolver = (thisType: RuntimeType, ...argsTypes: RuntimeType[]) => RuntimeType;

export interface QuotedFunction<T extends Function = Function> {
    __lambdaType?: LambdaTypeResolver[];
    __resultType?: ResultTypeResolver;
    __quoted?: () => ExLambda;
    // Signum's [SqlMethod(Name = "…")]: the SQL name of a query-only (table-valued or
    // scalar) function. The QueryBinder lowers a call to `<__sqlMethod>(args)`.
    __sqlMethod?: string;
}

// Cast a function to its query metadata carrier (Signum's attribute access). A no-op
// at runtime; only the static type changes.
export function quotedFunction<T extends Function>(func: T): QuotedFunction<T> {
    return func as unknown as QuotedFunction<T>;
}
