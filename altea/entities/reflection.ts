
import { Localization } from './utils/localization';
import type { Type, Entity } from './entity';
import type { EntityKind, EntityData } from './decorators';
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
    // Absent for value types and @implementedBy interface references (name-only). For an enum field the
    // thunk resolves to the enum OBJECT (not a class) — that is what marks the field as an enum, so
    // there is no separate `enum` flag.
    type?: () => Function | object;
    // The precise .NET-style value alias (e.g. "int"), emitted by the transformer from the source
    // primitive alias. Stored on FieldInfo as `subTypeName`. (Was `name`.)
    subTypeName?: SubTypeName;
    nullable?: boolean;
    // Container flags: set by the transformer for `Lite<T>` and `T[]`.
    // `lite` + `array` together = `Lite<T>[]`.
    lite?: boolean;
    array?: boolean;
}

// The coarse value-type name a field / query token exposes (Signum's TypeReference.name for value
// types). Open union: the literal members give autocomplete for the value types the query + UI layers
// switch on, while enum names and name-only @implementedBy interface names — which also land in
// `typeName` — stay assignable. The int-vs-double precision lives in `subTypeName`.
export type TypeName =
    | "String" | "Number" | "Boolean" | "Decimal" | "Guid"
    | "PlainDate" | "PlainDateTime" | "PlainTime" | "Duration" | "Instant" | "ZonedDateTime"
    | (string & {});

// The precise .NET-style value alias (Signum drove int-vs-double `<NumberLine/>` formatting off this).
// Emitted by the transformer from the source primitive alias (see entities/basics); undefined ⇒ the
// typeName's default (e.g. Number ⇒ float/double).
export type SubTypeName = "int" | "long" | "decimal" | "uuid" | "uuid7";

// The type FACET of a field or a query token — "what type is this value": the value/enum/entity it
// holds, whether it is a collection / Lite / nullable, and (for references) the polymorphic
// implementations. Signum called this TypeReference and carried ONE on both MemberInfo and QueryToken;
// altea does the same — `FieldInfo extends TypeReference`, and QueryToken.type is a TypeReference —
// so the Lines layer and the FilterBuilder speak a single descriptor. (Signum's flat wire DTO becomes
// a class here so the resolution logic — the `type` thunk → ctor/enum → name — lives with the data.)
export class TypeReference {
    // The value / enum / interface type name (see {@link TypeName}). For entity/embedded/enum
    // references the resolved name comes from the `type` thunk instead (see {@link getTypeName}).
    typeName!: TypeName;
    // The precise value alias (see {@link SubTypeName}) — e.g. Number + "int". Was FieldInfo.kind.
    subTypeName?: SubTypeName;
    // Lazy runtime reference to the referenced type: a class constructor (entity/embedded) OR an enum
    // object. Transformer-emitted (see FieldOptions.type). Read it via {@link getFunction}/{@link getEnum}.
    type?: () => Function | object;
    // Polymorphic reference target(s): @implementedBy list or @implementedByAll.
    implementations?: ImplementationsInfo;
    lite?: boolean;
    array?: boolean;
    isNullable?: boolean;

    // Build a TypeReference from a partial (query tokens / PropertyRoute construct these directly, e.g.
    // `new TypeReference({ typeName: "Number", subTypeName: "int" })` or `{ type: () => ArtistEntity,
    // lite: true }`). FieldInfo calls `super()` with no init and fills its fields via the @field decorator.
    constructor(init?: Partial<Pick<TypeReference, 'typeName' | 'subTypeName' | 'type' | 'implementations' | 'lite' | 'array' | 'isNullable'>>) {
        if (init != null) Object.assign(this, init);
    }

    // The referenced entity/embedded *constructor* — `type()` when it resolves to a class. undefined
    // for value types, enums, and name-only @implementedBy interface references (which have no thunk;
    // their concrete targets are reached via {@link is}/`implementations`). Was the free `fieldType`.
    getFunction(): Function | undefined {
        const t = this.type?.();
        return typeof t === 'function' ? t : undefined;
    }

    // The referenced enum OBJECT — `type()` when it resolves to a (non-function) object. Enums are NOT
    // resolved through the registry: the transformer always emits the `() => TheEnum` thunk, so the
    // presence of a non-function `type()` result IS what marks an enum field (no `isEnum` flag needed).
    // Was the free `fieldEnum`.
    getEnum(): object | undefined {
        const t = this.type?.();
        return t != null && typeof t !== 'function' ? t : undefined;
    }

    // The display/registry NAME — the class name or enum name via `type()`, else the value `typeName`.
    // Mainly for error messages / display; dispatch should prefer the structured predicates. Was the
    // free `fieldTypeName`.
    getTypeName(): string | undefined {
        if (this.type != null) {
            const t = this.type();
            if (typeof t === 'function') return t.name;
            if (t != null) return enumNameOf(t) ?? undefined;
        }
        return this.typeName;
    }

    // True when the field's resolved runtime type IS `baseClass` or a subclass of it — e.g.
    // tr.is(Entity), tr.is(EmbeddedEntity), tr.is(ModelEntity). Resolved from the ACTUAL runtime class
    // (via {@link getFunction}), NOT the coarse `typeName` (which the transformer leaves unset for
    // thunked refs). The CALLER supplies the class, so reflection.ts needn't import or late-bind the
    // entity base classes — sidestepping the entity↔reflection cycle — and it generalises to any class.
    //
    // A polymorphic @implementedBy reference (e.g. `@implementedBy(() => [ArtistEntity, BandEntity])
    // author: IAuthorEntity`) has NO single ctor — `type` is null and `typeName` is the interface name —
    // yet it is still an entity reference: it satisfies `is(baseClass)` when EVERY concrete
    // implementation does, so `is(Entity)` / `is(BaseEntity)` hold. (@implementedByAll carries a
    // `() => Entity` thunk, so it resolves through getFunction above; see also {@link isByAll}.)
    is(baseClass: Function): boolean {
        const ctor = this.getFunction();
        if (ctor != null)
            return ctor === baseClass || ctor.prototype instanceof baseClass;
        const impl = this.implementations;
        if (impl != null && impl.kind === 'implementedBy') {
            const types = impl.types();
            return types.length > 0 && types.every(t => t === baseClass || t.prototype instanceof baseClass);
        }
        return false;
    }

    // An enum field (Signum's isEnum) — derived from `type()` resolving to an enum object, not a flag.
    get isEnum(): boolean { return this.getEnum() != null; }

    // The element TypeReference of a collection (`array`), else null — the same reference with `array`
    // stripped. Counterpart of the query engine's RuntimeType.elementType; the collection query tokens
    // read `parent.type.elementType`.
    get elementType(): TypeReference | null {
        return this.array ? Object.assign(new TypeReference(), this, { array: false }) : null;
    }

    // @implementedByAll (a reference typed as "any entity").
    isByAll(): boolean { return this.implementations?.kind === 'implementedByAll'; }

    // The concrete entity TypeInfos this reference targets: the single class for a mono-typed
    // reference, or every @implementedBy implementation; [] for @implementedByAll, values, and enums.
    // Only *resolved* TypeInfos are returned. Replaces Signum's client `getTypeInfos(name)` string
    // round-trip — altea holds the target ctor(s) STRUCTURALLY, so a name-only @implementedBy interface
    // (whose {@link getTypeName} is the unresolvable INTERFACE name) still yields its real
    // implementations, and a polymorphic reference is detected by `typeInfos().length > 1` rather than
    // by sniffing a ", " in the name.
    typeInfos(): TypeInfo[] {
        if (this.isByAll()) return [];
        const impl = this.implementations;
        if (impl != null && impl.kind === 'implementedBy')
            return impl.types().map(t => tryGetTypeInfo(t)).filter((ti): ti is TypeInfo => ti != null);
        const ctor = this.getFunction();
        const ti = ctor != null ? tryGetTypeInfo(ctor) : undefined;
        return ti != null ? [ti] : [];
    }

    // The single TypeInfo this reference targets, asserting there is EXACTLY one (Signum's `.single()`).
    // Throws for a value/enum (zero), an @implementedByAll, or a multi-type @implementedBy — i.e. any
    // caller that assumes a mono-typed reference: its @valueField / @rowOrder row-type lookups read
    // `tr.typeInfo().valueField` / `.rowOrderField`. Use {@link typeInfos} where zero-or-many is valid.
    typeInfo(): TypeInfo {
        const tis = this.typeInfos();
        if (tis.length !== 1)
            throw new Error(`Expected exactly one TypeInfo for '${this.getTypeName()}', got ${tis.length}`);
        return tis[0];
    }
}

export class FieldInfo extends TypeReference {
    readonly name: string;
    // The TypeInfo that DECLARES this field (Signum's PropertyRoute.RootType). Set once at creation;
    // inherited fields are shared by reference (see getOrCreateTypeInfo), so this stays the base type
    // where the field is declared — which is also the type key its translation lives under.
    declaringType?: TypeInfo;
    // Set by @forceNullable (Signum's [ForceNullable]): the COLUMN is nullable
    // (IsNullable.Forced) while the field stays non-null in the object model — so queries
    // navigate it as a normal non-null reference but the column accepts NULL.
    forceNullable?: boolean;
    // Set by @column(false): excluded from the DB schema + change tracking (present only in the
    // object model), but still serialized to JSON by default.
    notMapped: boolean = false;
    // Set by @serialize(false): the JSON codec (entities/serializer) skips this field. Distinct
    // from @column(false) (which excludes a field from the DB schema + change tracking but leaves
    // it serializable) — used for pure bookkeeping like `isNew` / `_snapshot`.
    noSerialize?: boolean;
    fkPropertyName?: string;
    // Set by @avoidExpandOnRetrieving on a reference field (Signum's [AvoidExpandQuery]):
    // a query retrieving the owner does NOT eager-expand this reference (it stays a lazy
    // stub). A per-reference concern, so it lives on the field, not the entity.
    avoidExpandOnRetrieving?: boolean;
    // Set by @customLite (Signum's [LiteModel]): overrides which custom lite this field's lite
    // value uses, per implementation type. A field may carry several (one per concrete type of a
    // polymorphic @implementedBy lite), so this is a list — each `@customLite` on the field pushes
    // one entry. `liteClass` is the CustomLiteClass to build; `forEntityType` the concrete entity
    // type it applies to. Both are thunks so the classes may be declared after the owner. Typed
    // loosely here (like `type`) to keep reflection independent of lite.ts/entity.ts; consumers
    // cast. Consumed by the JSON codec and the query provider.
    customLite?: { liteClass: () => unknown; forEntityType: () => unknown }[];
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
    // Signum's MemberInfo display metadata (the client Lines layer reads these off the PropertyRoute's
    // field). Not wired by altea decorators yet, so undefined ⇒ default rendering — same as Signum
    // without the attrs. (Signum's MemberInfo.required has no altea field: it's `!isNullable`.)
    isReadOnly?: boolean;
    format?: string;
    unit?: string;
    isMultiline?: boolean;
    maxLength?: number;

    validators: Validator[] = [];
    customValidation?: (entity: any, fieldInfo: FieldInfo) => string | null;

    constructor(name: string) {
        super();
        this.name = name;
    }

    niceToString(): string {
        const translated = this.declaringType?.ctor != null
            ? Localization.memberNiceName(this.declaringType.ctor.name, this.name)
            : undefined;
        return translated ?? Localization.niceMemberName(this.name);
    }

    // Runs this field's validators (then any customValidation) against `entity`, returning the
    // first error message or null. Single source of field validation — used by BOTH
    // entityIntegrityCheck (whole entity) and the client Binding.getError (per-field, live),
    // so the two never diverge.
    validate(entity: any): string | null {
        const value = entity[this.name];
        for (const validator of this.validators) {
            const error = validator.error(value, entity, this);
            if (error != null) return error;
        }
        return this.customValidation != null ? this.customValidation(entity, this) : null;
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
        this.fields = Object.create(null); // null-proto: `fields["toString"]` etc. is undefined, not an inherited Object.prototype member
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

    // ---- Client TypeInfo surface (Signum's TypeInfo) ----
    // Back-reference to the constructor this describes (set in getOrCreateTypeInfo) so the
    // culture-dependent display names can be computed on demand.
    ctor?: Function;

    // Signum's EntityKind / EntityData — stamped by @entity (see decorators). `entityKind` is mandatory
    // on concrete entities (the abstract base uses @reflect, so it stays undefined here).
    entityKind?: EntityKind;

    // Effective EntityData. For a non-Part it is the value passed to @entity (mandatory there). For a
    // "Part" @entity may omit it: SchemaBuilder.include then fills it in from the FIRST entity that
    // includes the Part (propagated down the real reference graph — including polymorphic @implementedBy
    // part references that have no @backReference to follow — so it can't be derived from reflection
    // alone). `lowPopulation` = Signum's isLowPopulation.
    entityData?: EntityData;
    lowPopulation?: boolean;

    // TODO: wire to OperationLogic (operations-symbol-port) / the reflection types blob.
    operations?: { [operationKey: string]: OperationInfo };
    hasConstructorOperation?: boolean;
    gender?: string;

    // niceName / nicePluralName are METHODS (not cached fields): the display name is
    // culture-dependent, so a cached string would be stale after a culture switch (esp. on the
    // server). `niceName`/`nicePluralName` here are the module-scope functions (localization).
    // Named get* (not `niceName`) so Signum's field-style `ti.niceName` is a COMPILE error to
    // sweep, instead of compiling to a function ref that fails at runtime.
    getNiceName(): string { return Localization.niceName(this.ctor!); }
    getNicePluralName(): string { return Localization.nicePluralName(this.ctor!); }

    // Signum's TypeInfo.members — altea's fields (keyed by the real property name, not capitalized).
    get members(): { [fieldName: string]: FieldInfo } { return this.fields; }

    // O(1) access to the (at most one) field carrying each of altea's MList-replacement markers —
    // the boolean flags (FieldInfo.isValueField / isRowOrder / isBackReference) remain the source of
    // truth (the serializer + saver iterate them per-field); these are just a lazily-computed index
    // over `fields`, memoized once per TypeInfo (fields are frozen after boot). Computed on first
    // access — at render/save time — so inherited markers (merged into `fields` at registration) are
    // already present. The cache slot is `undefined` until computed, then `FieldInfo | null`; gating
    // on `=== undefined` (NOT `??=`, which would re-scan the null/not-found case forever) memoizes both
    // the found and the not-found result. Getters return `FieldInfo | null` (null = no such field).
    #valueField?: FieldInfo | null;
    get valueField(): FieldInfo | null {
        return this.#valueField !== undefined ? this.#valueField :
            (this.#valueField = Object.values(this.fields).find(f => f.isValueField) ?? null);
    }

    #rowOrderField?: FieldInfo | null;
    get rowOrderField(): FieldInfo | null {
        return this.#rowOrderField !== undefined ? this.#rowOrderField :
            (this.#rowOrderField = Object.values(this.fields).find(f => f.isRowOrder) ?? null);
    }

    #backReferenceField?: FieldInfo | null;
    get backReferenceField(): FieldInfo | null {
        return this.#backReferenceField !== undefined ? this.#backReferenceField :
            (this.#backReferenceField = Object.values(this.fields).find(f => f.isBackReference) ?? null);
    }

    // Signum's TypeInfo.kind. altea attaches TypeInfo only to reflected classes -> "Entity".
    get kind(): "Entity" | "Enum" | "SymbolContainer" { return "Entity"; } // TODO: enum / symbol containers
}

// Client OperationInfo (Signum's OperationInfo).
export type OperationType = "Execute" | "Delete" | "Constructor" | "ConstructorFrom" | "ConstructorFromMany";

export interface OperationInfo {
    key: string;
    niceName: string;
    operationType: OperationType;
    canBeNew?: boolean;
    canBeModified?: boolean;
    hasCanExecute?: boolean;
    hasCanExecuteExpression?: boolean;
    hasStates?: boolean;
    resultIsSaved?: boolean;
    forReadonlyEntity?: boolean;
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
    created.ctor = ctor;
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
    init, declaredSymbolsForType,
    setDefaultTypeDescription, setDefaultMemberDescription, getDefaultDescription,
    setDefaultCulture, getPackageCulture, cultureForName,
    setDefaultDatabaseSchema, schemaForName,
} from './registration';
export type { FileInfo } from './registration';

export function getOrCreateFieldInfo(typeInfo: TypeInfo, key: string): FieldInfo {
    const existing = typeInfo.fields[key];
    if (existing) return existing;
    const created = new FieldInfo(key);
    // Owner is known here (inherited fields keep their declaring type). NON-ENUMERABLE on purpose: it is
    // a back-reference (FieldInfo → TypeInfo → fields → FieldInfo) that would make the field graph
    // circular for JSON.stringify — e.g. SearchControl snapshots parsed find-options (whose column
    // tokens carry FieldInfos) via JSON. Property access (memberNiceName) is unaffected.
    Object.defineProperty(created, "declaringType", { value: typeInfo, enumerable: false, writable: true, configurable: true });
    typeInfo.fields[key] = created;
    return created;
}

export function getTypeInfo(target: object): TypeInfo | undefined {
    const ctor = ctorOf(target) as any;
    return ctor?.[typeInfoKey] as TypeInfo | undefined;
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
        if (options.subTypeName != null)
            fi.subTypeName = options.subTypeName;
        if (options.nullable != null)
            fi.isNullable = options.nullable;
        if (options.lite != null)
            fi.lite = options.lite;
        if (options.array != null)
            fi.array = options.array;
    };
}
