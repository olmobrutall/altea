

export abstract class Type {

}

export class ArrayType extends Type {
    constructor(public readonly elementType: Type) {
        super()
    }
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

export class ObjectType extends Type {
    constructor(public readonly bindings: { [name: string]: Type | undefined }) {
        super()
    }
}
