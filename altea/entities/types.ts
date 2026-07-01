

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

// A Promise<T>. Query terminals (toArray/first/count/…) are async at the top
// level, so their result type is a PromiseType. Inside a query expression there is
// no async: dispatching a Query terminal onto an Array/sub-query strips the
// PromiseType (see fromQuoted), and `promise.$v` unwraps it to its inner value (a
// scalar subquery). `inner` is T.
export class PromiseType extends Type {
    constructor(public readonly inner: Type) {
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
