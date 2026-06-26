
import { DescriptionManager } from './utils/localization';
import type { Type, Entity } from './entity';

// The runtime type of a primary key. `int`/`long` are identity-style integers;
// `uuid`/`uuid7` are GUID columns (uuid7 is time-ordered). Maps to an
// AbstractDbType in logic/schema/dbType.
export type PrimaryKeyType = 'uuid' | 'uuid7' | 'int' | 'long';

// ColumnOptions lives here (shared) so logic/schema.ts can import it without
// the entities package depending on server-only code.
export interface ColumnOptions {
    columnName?: string;
    pgDbType?: string;
    sqlDbType?: string;
    nullable?: boolean;
    collection?: boolean;
    ignored?: boolean;
    size?: number;
    precision?: number;
    // Set by @primaryKey on the entity's `id` field: overrides the schema's
    // default PK db type.
    primaryKey?: PrimaryKeyType;
}

export type ImplementationsInfo =
    // `types` is the user's thunk, evaluated lazily (at schema-build time) so it
    // can reference entity classes declared later in the file without hitting a
    // temporal-dead-zone error — same rationale as @include.
    | { kind: 'implementedBy'; types: () => Type<Entity>[] }
    | { kind: 'implementedByAll' };

export interface FieldOptions {
    // The runtime type's *name* (e.g. "CustomerEntity", "Number", "Date") rather
    // than a `() => Type` factory — so the transformer never emits a runtime
    // reference to an imported type (which TS would elide). Entity/embedded names
    // resolve to constructors via the type registry; value-type names resolve in
    // defaultDbType; enums are flagged with `enum`.
    typeName: string;
    name?: string;
    nullable?: boolean;
    // Container flags: set by the transformer for `Lite<T>` and `T[]`.
    // `lite` + `array` together = `Lite<T>[]`.
    lite?: boolean;
    array?: boolean;
    // Set for enum-typed fields (the type registry doesn't hold enums).
    enum?: boolean;
}

export class FieldInfo {
    readonly name: string;
    typeName!: string;
    lite?: boolean;
    array?: boolean;
    isEnum?: boolean;
    kind?: string;
    isNullable?: boolean;
    ignore: boolean = false;
    fkPropertyName?: string;
    // Set by @include: a user-written thunk returning the referenced
    // constructor(s). Because the thunk references the type as a *value* in
    // source, the import survives elision (no verbatimModuleSyntax needed) and
    // the schema builder gets the constructor by reference (no name registry).
    // `true` means a bare @include that defers to a sibling @implementedBy.
    include?: (() => unknown) | boolean;
    implementations?: ImplementationsInfo;
    // Set by the child-side @backReference marker (bare): this FK field points
    // back to the owner entity. The owner's collection (@include(() => Child))
    // finds it as the back-pointing FK. Per-row equivalent of an MList element.
    isBackReference?: boolean;
    // Set by @rowOrder: this int column preserves MList row order (Signum's
    // [PreserveOrder]).
    isRowOrder?: boolean;
    // Set by @valueField: this field holds the element value of a non-embedded
    // MList row (the scalar/reference the MList<T> stored).
    isValueField?: boolean;
    columnOptions?: ColumnOptions;

    validators: Validator[] = [];
    customValidation?: (entity: any, fieldInfo: FieldInfo) => string | null;

    constructor(name: string) {
        this.name = name;
    }

    niceToString(): string {
        return DescriptionManager.inferDescription(this.name);
    }
}

// Validator is declared here (forward-reference) to break the circular dep
// between reflection ↔ validators.  The full implementations live in validators.ts.
export abstract class Validator {
    isApplicable?: (entity: any) => boolean;
    customError?: () => string;

    abstract get helpMessage(): string;
    isCompatibleWith?(type: Function): boolean;

    protected abstract overrideError(value: unknown, entity: any, fieldName: FieldInfo): string | null;

    error(value: unknown, entity: any, fieldName: FieldInfo): string | null {
        if (this.isApplicable != null && !this.isApplicable(entity)) return null;
        const result = this.overrideError(value, entity, fieldName);
        if (result == null) return null;
        return this.customError != null ? this.customError() : result;
    }
}

export class TypeInfo {
    constructor() {
        this.fields = {};
    }

    fields: { [fieldName: string]: FieldInfo };
}

const symbolWithMetadata = Symbol as any;
if (symbolWithMetadata.metadata == null) {
    symbolWithMetadata.metadata = Symbol.for('Symbol.metadata');
}

const metadataSymbol: symbol = symbolWithMetadata.metadata;
const typeInfoMetadataKey = Symbol.for('altea:typeInfo');

export function getOrCreateTypeInfo(metadata: DecoratorMetadataObject): TypeInfo {
    // TC39 decorator metadata objects are prototype-linked to the base class's
    // metadata, so a plain `metadata[key]` read on a subclass returns the BASE
    // class's TypeInfo — which would make every subclass share (and pollute) one
    // TypeInfo. We therefore key off an *own* property: the first decorator on a
    // given class creates that class's own TypeInfo, seeded with a shallow copy
    // of the inherited (base) fields so inheritance still works.
    if (Object.prototype.hasOwnProperty.call(metadata, typeInfoMetadataKey))
        return metadata[typeInfoMetadataKey] as TypeInfo;

    const inherited = metadata[typeInfoMetadataKey] as TypeInfo | undefined;
    const created = new TypeInfo();
    if (inherited != null)
        Object.assign(created.fields, inherited.fields);

    metadata[typeInfoMetadataKey] = created;
    return created;
}

// Generic, ORM-agnostic marker: any class decorated with @reflect participates
// in reflection. The quote-transformer auto-injects @field on its (non-ignored)
// properties. Use it for entities, models, DTOs, views, etc. Entity-specific
// concerns like @entity / @column live in ./decorators instead.
export function reflect(value: Function, context: ClassDecoratorContext): void {
    if (context.metadata != null)
        getOrCreateTypeInfo(context.metadata);
    registerType(value);
}

// Type registry: maps a type's name to its runtime constructor. Populated at
// class-definition time by @reflect / @entity, so the schema builder can
// resolve a field's `typeName` (e.g. "CustomerEntity") back to its constructor
// for classification (entity / embedded) and recursion. Value types (String,
// Number, Date, Decimal, Temporal.*) are intentionally absent — they resolve by
// name in defaultDbType — as are enums (flagged via FieldInfo.isEnum).
const typeRegistry = new Map<string, Function>();

export function registerType(ctor: Function): void {
    if (ctor?.name)
        typeRegistry.set(ctor.name, ctor);
}

export function resolveType(name: string): Function | undefined {
    return typeRegistry.get(name);
}

export function getOrCreateFieldInfo(typeInfo: TypeInfo, key: string): FieldInfo {
    const existing = typeInfo.fields[key];
    if (existing) return existing;
    const created = new FieldInfo(key);
    typeInfo.fields[key] = created;
    return created;
}

function getMetadata(target: any): DecoratorMetadataObject | undefined {
    return target?.[metadataSymbol] ?? target?.constructor?.[metadataSymbol];
}

export function getTypeInfo(target: object): TypeInfo | undefined {
    const metadata = getMetadata(target as any);
    return metadata?.[typeInfoMetadataKey] as TypeInfo | undefined;
}

function isFieldContext(value: unknown): value is ClassFieldDecoratorContext {
    if (value == null || typeof value !== 'object')
        return false;

    const kind = (value as any).kind;
    return kind === 'field' || kind === 'accessor';
}

export function field(value: undefined, context: ClassFieldDecoratorContext): void;
export function field(options: FieldOptions | false): (value: unknown, context: ClassFieldDecoratorContext | ClassAccessorDecoratorContext) => void;
export function field(arg1: unknown, arg2?: unknown): unknown {
    if (isFieldContext(arg2)) {
        throw new Error('@field without options should be rewritten by the compiler to @field({ typeName: ... })');
    }

    // @field(false) suppresses auto-injection — register nothing.
    if (arg1 === false)
        return function (): void { };

    if (arg1 == null || typeof arg1 !== 'object')
        throw new Error('@field expects an options object: @field({ typeName: ... })');

    const options = arg1 as FieldOptions;

    return function (_value: unknown, context: ClassFieldDecoratorContext) {
        if (context.metadata == null)
            throw new Error('Decorator metadata is required but not available in this runtime');

        const key = String(context.name);
        const typeInfo = getOrCreateTypeInfo(context.metadata);
        const fi = getOrCreateFieldInfo(typeInfo, key);
        fi.typeName = options.typeName;
        if (options.name != null)
            fi.kind = options.name;
        if (options.nullable != null)
            fi.isNullable = options.nullable;
        if (options.lite != null)
            fi.lite = options.lite;
        if (options.array != null)
            fi.array = options.array;
        if (options.enum != null)
            fi.isEnum = options.enum;
    };
}
