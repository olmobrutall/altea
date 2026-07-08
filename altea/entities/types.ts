import type { ExLambda } from "quote-transformer/quoted";

export abstract class Type {
    // The element type when this is a collection type (ArrayType); null otherwise.
    get elementType(): Type | null { return null; }
}

export class ArrayType extends Type {
    constructor(private readonly element: Type) {
        super()
    }
    override get elementType(): Type { return this.element; }
}

export class FunctionType extends Type {
    constructor(
        public readonly func: Function | undefined,
        public readonly returnType: Type) {
        super()
    }
}

export class LiteralType extends Type {

    static readonly boolean: LiteralType = new LiteralType("boolean");
    static readonly number: LiteralType = new LiteralType("number");
    static readonly string: LiteralType = new LiteralType("string");
    static readonly null: LiteralType = new LiteralType("null");

    constructor(public readonly typeName: "boolean" | "number" | "string" | "null") {
        super()
    }
}

export class ClassType extends Type {
    constructor(public readonly constructorFunction: Function) {
        super()
    }
}

// A Lite<T> reference. `entityType` is the wrapped entity type (T). Distinct from
// ClassType so the query layer can tell a lite from a full entity — e.g. method
// dispatch routes to Lite.prototype, and `lite.entity` resolves to `entityType`.
export class LiteType extends Type {
    constructor(public readonly entityType: Type) {
        super()
    }
}

// A temporal column/value (Temporal.PlainDateTime / PlainDate / Duration). Distinct
// so the query layer can translate date-part access (`.year`, `.quarter()`, `.dayOfWeek`)
// to SQL and dispatch date methods to the right prototype.
export class TemporalType extends Type {
    constructor(public readonly kind: "dateTime" | "date" | "duration") {
        super()
    }
}

export class ObjectType extends Type {
    constructor(public readonly bindings: { [name: string]: Type | undefined }) {
        super()
    }
}

// An enum column/value. Stored as its underlying int, but carries the enum object
// so the query layer can translate `.toString()` to a value→name CASE.
export class EnumType extends Type {
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
export type LambdaTypeResolver = (thisType: Type, ...argsTypes: Type[]) => Type[];
export type ResultTypeResolver = (thisType: Type, ...argsTypes: Type[]) => Type;

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
