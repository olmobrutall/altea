
import { DescriptionManager } from './utils/localization';
import type { Type, Entity } from './entity';
import type { Quoted } from 'quote-transformer/quoted';
import { registerType, resolveType, resolveEnum, enumNameOf } from './registration';

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
    // The runtime type's *name* (e.g. "CustomerEntity", "Number", "Date"). Always
    // present. For value types it is the sole type carrier (resolves in defaultDbType);
    // for entity/embedded/enum references it accompanies `type` (below) and drives
    // name-based lookups + the clean-name (wire/URL) derivation.
    typeName: string;
    // Lazy runtime reference to the entity/embedded class or enum object, e.g.
    // `type: () => CustomerEntity`. Emitted by the transformer for value-typed
    // references (under verbatimModuleSyntax) so the import survives: the module graph
    // then mirrors the entity reference graph (importing an owner transitively loads +
    // registers everything reachable) and resolution is rename-/load-order-proof.
    // Absent for value types and @implementedBy interface references (name-only).
    type?: () => unknown;
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
    // Lazy runtime reference to the field's entity/embedded class or enum object (see
    // FieldOptions.type). Prefer {@link fieldType} over reading this or resolving
    // `typeName` through the registry.
    type?: () => unknown;
    lite?: boolean;
    array?: boolean;
    isEnum?: boolean;
    kind?: string;
    isNullable?: boolean;
    // Set by @forceNullable (Signum's [ForceNullable]): the COLUMN is nullable
    // (IsNullable.Forced) while the field stays non-null in the object model — so queries
    // navigate it as a normal non-null reference but the column accepts NULL.
    forceNullable?: boolean;
    ignore: boolean = false;
    fkPropertyName?: string;
    // Set by @avoidExpandOnRetrieving on a reference field (Signum's [AvoidExpandQuery]):
    // a query retrieving the owner does NOT eager-expand this reference (it stays a lazy
    // stub). A per-reference concern, so it lives on the field, not the entity.
    avoidExpandOnRetrieving?: boolean;
    implementations?: ImplementationsInfo;
    // Set by the child-side @backReference marker (bare): this FK field points
    // back to the owner entity. The owner's collection (a `Child[]` field) finds it as
    // the back-pointing FK. Per-row equivalent of an MList element.
    isBackReference?: boolean;
    // Set by @rowOrder: this int column preserves MList row order (Signum's
    // [PreserveOrder]).
    isRowOrder?: boolean;
    // Set by @valueField: this field holds the element value of a non-embedded
    // MList row (the scalar/reference the MList<T> stored).
    isValueField?: boolean;
    // Set by @viewPrimaryKey on an IView field (Signum's [ViewPrimaryKey]): this
    // raw column is (part of) the view's primary key. Consumed by ViewBuilder.
    viewPrimaryKey?: boolean;
    // Set by field-level @index / @uniqueIndex (Signum's [Index] / [UniqueIndex]): a single-
    // column (non-)unique index on this field's column. Consumed by SchemaBuilder.
    index?: boolean;
    uniqueIndex?: boolean;
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
    // Explicit database table/view name (Signum's [TableName]); overrides the
    // name derived from the class. For a view class (@reflect + @tableName) this is
    // the raw view name ViewBuilder maps to, e.g. "pg_catalog.pg_namespace".
    tableName?: string;
    // Set by class-level @index / @uniqueIndex(e => [e.a, e.b]): composite indexes declared
    // by column-selector lambdas. Stored as the raw selectors (entities/ can't import the
    // logic-layer field recorder); the SchemaBuilder runs them against a recording proxy to
    // resolve the covered fields → columns.
    indexes?: { unique: boolean; fields: (element: any) => unknown; includeFields?: (element: any) => unknown; where?: Quoted<(element: any) => boolean> }[];
    // Set by @systemVersioned (Signum's [SystemVersioned]): the type's table keeps a full
    // history of every row version. The optional fields override the period column / history
    // table names; the SchemaBuilder fills dialect defaults. Stored as a bare shape here
    // (entities/ must not import the logic layer's SystemVersionedInfo).
    systemVersioned?: { startColumnName?: string; endColumnName?: string; sysPeriodColumnName?: string; historyTableName?: string };
}

// Legacy (experimentalDecorators) decorators have no `context.metadata`, so
// TypeInfo lives under this key directly on the class *constructor*. Class
// decorators receive the constructor; field/method decorators receive the
// prototype — `ctorOf` normalizes both to the constructor.
const typeInfoKey = Symbol.for('altea:typeInfo');

// A decorator target is either the constructor (class decorators) or the
// prototype / instance (field & method decorators); both resolve to the ctor.
export function ctorOf(target: object): Function {
    return typeof target === 'function' ? target : (target as { constructor: Function }).constructor;
}

// Read-only lookup: returns the TypeInfo a class already has (via @reflect /
// field decorators), or undefined. Unlike getOrCreateTypeInfo it never creates or
// attaches one, so callers that merely *inspect* metadata (e.g. resolving a
// member's type) don't accidentally materialise TypeInfo on arbitrary ctors.
// Reads an *own* property so a subclass never returns its base's TypeInfo.
export function tryGetTypeInfo(target: object): TypeInfo | undefined {
    const ctor = ctorOf(target) as any;
    return Object.prototype.hasOwnProperty.call(ctor, typeInfoKey)
        ? ctor[typeInfoKey] as TypeInfo
        : undefined;
}

export function getOrCreateTypeInfo(target: object): TypeInfo {
    const ctor = ctorOf(target) as any;
    // Class constructors inherit *static* properties through their own prototype
    // chain (class B extends A ⇒ Object.getPrototypeOf(B) === A), so a plain
    // `ctor[typeInfoKey]` read on a subclass returns the BASE class's TypeInfo —
    // which would make every subclass share (and pollute) one TypeInfo. We key
    // off an *own* property: the first decorator on a given class creates that
    // class's own TypeInfo, seeded with a shallow copy of the inherited (base)
    // fields so inheritance still works.
    if (Object.prototype.hasOwnProperty.call(ctor, typeInfoKey))
        return ctor[typeInfoKey] as TypeInfo;

    const inherited = ctor[typeInfoKey] as TypeInfo | undefined;
    const created = new TypeInfo();
    if (inherited != null)
        Object.assign(created.fields, inherited.fields);

    Object.defineProperty(ctor, typeInfoKey, { value: created, configurable: true, writable: true, enumerable: false });
    return created;
}

// Generic, ORM-agnostic marker: any class decorated with @reflect participates
// in reflection. The quote-transformer auto-injects @field on its (non-ignored)
// properties. Use it for entities, models, DTOs, views, etc. Entity-specific
// concerns like @entity / @column live in ./decorators instead.
export function reflect(target: Function): void {
    getOrCreateTypeInfo(target);
    registerType(target);
}

// The runtime registries + FileInfo live in the (import-free) ./registration
// leaf module so they can also be re-exported from utils/localization without an
// import cycle (reflection imports localization). Re-exported here so existing
// `from './reflection'` consumers keep working unchanged.
export {
    registerType, resolveType,
    registerEnum, resolveEnum, enumNameOf,
    registerObject, resolveObject,
    getLocation,
} from './registration';
export type { FileInfo } from './registration';

export function getOrCreateFieldInfo(typeInfo: TypeInfo, key: string): FieldInfo {
    const existing = typeInfo.fields[key];
    if (existing) return existing;
    const created = new FieldInfo(key);
    typeInfo.fields[key] = created;
    return created;
}

export function getTypeInfo(target: object): TypeInfo | undefined {
    const ctor = ctorOf(target) as any;
    return ctor?.[typeInfoKey] as TypeInfo | undefined;
}

// Resolves a field's referenced entity/embedded *constructor* — the single accessor for
// a reference field's runtime type. Prefers the transformer-emitted `type` thunk
// (rename-/load-order-proof, and it kept the import alive so the type is registered),
// falling back to a name lookup for hand-written `@field({ typeName })` metadata.
// Returns undefined for value-typed and enum fields (their `typeName`, e.g. "Number", is
// not an entity ctor — value types resolve in defaultDbType, enums via {@link fieldEnum}).
export function fieldType(fi: FieldInfo): Function | undefined {
    const t = fi.type != null ? fi.type() : (fi.typeName != null ? resolveType(fi.typeName) : undefined);
    return typeof t === 'function' ? t as Function : undefined;
}

// Resolves an enum field's runtime enum object (the counterpart of {@link fieldType} for
// `@field({ enum: true })` fields). Prefers the `type` thunk, else the enum registry.
export function fieldEnum(fi: FieldInfo): object | undefined {
    if (fi.type != null) {
        const t = fi.type();
        return typeof t === 'object' && t != null ? t as object : undefined;
    }
    return fi.typeName != null ? resolveEnum(fi.typeName) : undefined;
}

// The display/registry NAME of a field's type — the entity/embedded class name or the
// enum's registered name — derived from the `type` thunk when present, else the stored
// `typeName`. Used for error messages, table naming and EnumType metadata now that
// thunked fields carry no `typeName` string.
export function fieldTypeName(fi: FieldInfo): string | undefined {
    if (fi.type != null) {
        const t = fi.type();
        if (typeof t === 'function') return (t as Function).name;
        if (t != null) return enumNameOf(t as object) ?? undefined;
    }
    return fi.typeName;
}

// Bare @field: exists so source type-checks (tsc checks the original AST). The
// quote-transformer rewrites it to @field({ typeName: ... }) before emit, so
// reaching this overload at runtime means the transform never ran.
export function field(target: object, propertyKey: string | symbol): void;
export function field(options: FieldOptions | false): (target: object, propertyKey: string | symbol) => void;
export function field(arg1: unknown, arg2?: unknown): unknown {
    // Bare @field reached runtime (called directly as a property decorator).
    if (typeof arg2 === 'string' || typeof arg2 === 'symbol')
        throw new Error('@field without options should be rewritten by the compiler to @field({ typeName: ... })');

    // @field(false) suppresses auto-injection — register nothing.
    if (arg1 === false)
        return function (): void { };

    if (arg1 == null || typeof arg1 !== 'object')
        throw new Error('@field expects an options object: @field({ typeName: ... })');

    const options = arg1 as FieldOptions;

    return function (target: object, propertyKey: string | symbol): void {
        const key = String(propertyKey);
        const typeInfo = getOrCreateTypeInfo(target);
        const fi = getOrCreateFieldInfo(typeInfo, key);
        fi.typeName = options.typeName;
        if (options.type != null)
            fi.type = options.type;
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
