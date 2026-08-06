
import { getOrCreateTypeInfo, getOrCreateFieldInfo, registerType, FieldInfo, ctorOf, setDefaultTypeDescription, setDefaultMemberDescription } from './reflection';
import type { Gender } from './utils/naturalLanguage';
import type { PrimaryKeyType, ColumnOptions } from './reflection';
import type { Type, Entity } from './entity';
import type { CustomLiteClass } from './lite';
import type { ExLambda, Quoted } from 'quote-transformer/quoted';
import { accessedFields } from './accessedFields';

export type { ColumnOptions } from './reflection';

// `@quoted` / `withQuoted` mark a method (or function) whose body the quote-transformer
// captures as a translatable expression, stored on `__quoted`. They live here (entities)
// so the entity model can annotate expression members without depending on the query
// layer. The query-layer's richer carrier (QuotedFunction, with __resultType/__sqlMethod)
// + cast helper (quotedFunction) stay in logic/query. Here we only touch `__quoted`, so the
// transformer's own `Quoted<T> = T & { __quoted? }` is the carrier type.

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

        (fn as Quoted<Function>).__quoted = exp;
    };
}

// Functional form of @quoted, for attaching a quoted expression to a function value
// (e.g. a prototype method added outside a class). The transformer rewrites
// `withQuoted(fn)` to inject the captured expression as the second argument.
export function withQuoted<T extends Function>(f: T, quoted?: () => ExLambda): T {
    (f as Quoted<T>).__quoted = quoted;
    return f;
}

export type { PrimaryKeyType } from './reflection';

export {
    stringLengthValidator, urlValidator, telephoneValidator,
    emailValidator, noRepeatValidator,
    customValidators as fieldValidation,
} from './validators';

// Re-exported so entity authors get @mixin from the same module as the other
// entity decorators. Implementation lives in ./mixinDeclarations.
export { mixin, MixinDeclarations } from './mixinDeclarations';

// Signum's EntityKind / EntityData (Signum.Entities/TypeAttributes.cs) — string-union TYPES here (were
// enums). Kind is mandatory on every entity; data is mandatory for every kind EXCEPT "Part" (a Part
// inherits the EntityData of the entity that owns it — see TypeInfo.entityData). Member docs copied
// from Signum:
export type EntityKind =
    /** Doesn't make sense to view it from other entity, since there's not to much to see. Not editable.
     * Not RequiresSaveOperation. ie: PermissionSymbol */
    | "SystemString"
    /** Not editable. Not RequiresSaveOperation. ie: ExceptionEntity */
    | "System"
    /** An entity that connects two entitities to implement a N to N relationship in a symetric way (no
     * MLists). RequiresSaveOperation, not vieable, not creable (override on SearchControl).
     * ie: DiscountProductEntity */
    | "Relational"
    /** Doesn't make sense to view it from other entity, since there's not to much to see.
     * RequiresSaveOperation. ie: CountryEntity */
    | "String"
    /** Used and shared by other entities, can be created from other entity. RequiresSaveOperation.
     * ie: CustomerEntity (can create new while creating the order) */
    | "Shared"
    /** Used and shared by other entities, but too big to create it from other entity.
     * RequiresSaveOperation. ie: OrderEntity */
    | "Main"
    /** Entity that belongs to just one entity and should be saved together, but that can not be
     * implemented as EmbeddedEntity (usually to enable polymorphisim). Not RequiresSaveOperation.
     * ie: ProductExtensionEntity */
    | "Part"
    /** Entity that can be created on the fly and saved with the parent entity, but could also be shared
     * with other entities to save space. Not RequiresSaveOperation. ie: AddressEntity */
    | "SharedPart";

export type EntityData =
    /** Entity created for business definition. By default ordered by id Ascending.
     * ie: ProductEntity, OperationSymbol, PermissionSymbol, CountryEntity... */
    | "Master"
    /** Entity created while the business is running. By default is ordered by id Descending.
     * ie: OrderEntity, ExceptionEntity, OperationLogEntity... */
    | "Transactional";

export interface EntityOptions {
    // Signum's isLowPopulation: few enough rows to load them all — drives the AutoLine default to
    // EntityCombo (single) / EntityCheckboxList (collection) instead of EntityLine / EntityStrip.
    lowPopulation?: boolean;
}

export interface EntityInfo {
    kind: EntityKind;
    data?: EntityData;
    lowPopulation?: boolean;
}

const entityInfoKey = Symbol.for('altea:entityInfo');
const allowUnauthenticatedKey = Symbol.for('altea:allowUnauthenticated');

// EntityKind / EntityData are recorded on the constructor (legacy decorators
// have no context.metadata). Read back with getEntityInfo.
export function getEntityInfo(target: object): EntityInfo | undefined {
    return (ctorOf(target) as any)?.[entityInfoKey] as EntityInfo | undefined;
}

export function isAllowUnauthenticated(target: object): boolean {
    return (ctorOf(target) as any)?.[allowUnauthenticatedKey] === true;
}

// Field-level decorator — Signum's [AvoidExpandQuery]. Marks a reference field so a query
// retrieving the owner does NOT eager-expand this reference (it stays a lazy stub instead
// of joining the target). It's a per-reference concern (one FK, not the whole entity), so
// it belongs on the field, like Signum.
export function avoidExpandOnRetrieving(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).avoidExpandOnRetrieving = true;
}

// Marks a class as a persistent entity. Like @reflect it creates reflection metadata and registers
// the type (so the quote-transformer auto-injects @field on its properties); additionally it records
// the EntityKind / EntityData / lowPopulation. `kind` is MANDATORY; `data` is required for every kind
// EXCEPT "Part" (parts inherit their owner's data — the overloads enforce this at the type level).
// The abstract base Entity uses @reflect (not @entity), so there is no no-arg form.
export function entity(kind: "Part", data?: EntityData, options?: EntityOptions): (target: Function) => void;
export function entity(kind: Exclude<EntityKind, "Part">, data: EntityData, options?: EntityOptions): (target: Function) => void;
export function entity(kind: EntityKind, data?: EntityData, options?: EntityOptions): (target: Function) => void {
    return function (target: Function): void {
        (target as any)[entityInfoKey] = { kind, data, lowPopulation: options?.lowPopulation } satisfies EntityInfo;
        const ti = getOrCreateTypeInfo(target);
        ti.entityKind = kind;
        ti.entityData = data;
        ti.lowPopulation = options?.lowPopulation;
        registerType(target);
    };
}

// Sets the runtime type of the entity's primary key (Signum's
// [PrimaryKey(typeof(...))]). Recorded on the implicit `id` field's
// columnOptions and consumed by SchemaBuilder. Absent → schema default (int).
export function primaryKey(type: PrimaryKeyType) {
    return function (target: Function): void {
        const typeInfo = getOrCreateTypeInfo(target);
        // The base Entity's `id` FieldInfo is shallow-copied (by reference) into
        // every subclass's TypeInfo, so it is SHARED. Replace it with an own copy
        // before mutating, or @primaryKey on one entity would change all of them.
        const inherited = typeInfo.fields['id'];
        const fi = new FieldInfo('id');
        if (inherited != null)
            Object.assign(fi, inherited);
        fi.columnOptions = { ...(fi.columnOptions ?? {}), primaryKey: type };
        typeInfo.fields['id'] = fi;
    };
}

// Sets an explicit database table/view name for the type (Signum's [TableName]),
// overriding the name derived from the class. Used e.g. for temporary views
// (`@tableName("#MyTempView")`); consumed by SchemaBuilder / Administrator.
export function tableName(name: string) {
    return function (target: Function): void {
        getOrCreateTypeInfo(target).tableName = name;
    };
}

// Class-level marker (Signum's [SystemVersioned]): the type's table is system-versioned —
// it keeps a full history of every row version (temporal table). Bare `@systemVersioned`
// uses dialect-default period/history names; `@systemVersioned({ historyTableName, … })`
// overrides them. Consumed by the SchemaBuilder (period columns + history table + SS
// SYSTEM_VERSIONING / PG versioning trigger).
type SystemVersionedOptions = { startColumnName?: string; endColumnName?: string; sysPeriodColumnName?: string; historyTableName?: string };
export function systemVersioned(target: Function): void;
export function systemVersioned(options: SystemVersionedOptions): (target: Function) => void;
export function systemVersioned(arg?: unknown): unknown {
    if (typeof arg === 'function') {
        getOrCreateTypeInfo(arg).systemVersioned = {};
        return;
    }
    const options = (arg ?? {}) as SystemVersionedOptions;
    return function (target: Function): void {
        getOrCreateTypeInfo(target).systemVersioned = { ...options };
    };
}

// Field-level marker on an IView class (Signum's [ViewPrimaryKey]): this raw column
// is (part of) the view's primary key. Consumed by ViewBuilder. A view class is
// declared with `@reflect` (the reflection/@field trigger, standing in for Signum's
// `: IView`) + `@tableName("schema.view")` (Signum's [TableName]); ViewBuilder reads
// those to build the view table.
export function viewPrimaryKey(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).viewPrimaryKey = true;
}

// @index — Signum's [Index] (field) plus a class-level composite form. Two shapes:
//   • field:  `@index code!: string;`                              — a non-unique index on that column
//   • class:  `@index(e => [e.a, e.b], e => e.active)`             — composite non-unique, optionally filtered
// The class form (Signum's AddIndex(fields, where?, includeFields?)) stores the raw selector
// lambdas; the SchemaBuilder resolves fields/includeFields to columns and renders `where`.
export function index(target: object, propertyKey: string | symbol): void;
export function index<T>(fields: Quoted<(element: T) => unknown>, where?: Quoted<(element: T) => boolean>, includeFields?: Quoted<(element: T) => unknown>): (target: Function) => void;
export function index(arg1: unknown, arg2?: unknown, arg3?: unknown): unknown {
    return indexDecorator(false, arg1, arg2, arg3);
}

// @uniqueIndex — Signum's [UniqueIndex] (field) plus a class-level composite form:
//   • field:  `@uniqueIndex code!: string;`                        — a unique index on that column
//   • class:  `@uniqueIndex(e => [e.name, e.country], e => e.active)` — composite unique, optionally filtered
export function uniqueIndex(target: object, propertyKey: string | symbol): void;
export function uniqueIndex<T>(fields: Quoted<(element: T) => unknown>, where?: Quoted<(element: T) => boolean>, includeFields?: Quoted<(element: T) => unknown>): (target: Function) => void;
export function uniqueIndex(arg1: unknown, arg2?: unknown, arg3?: unknown): unknown {
    return indexDecorator(true, arg1, arg2, arg3);
}

function indexDecorator(unique: boolean, arg1: unknown, arg2: unknown, arg3: unknown): unknown {
    // Field form: (target, propertyKey).
    if (typeof arg2 === 'string' || typeof arg2 === 'symbol') {
        const fi = getOrCreateFieldInfo(getOrCreateTypeInfo(arg1 as object), String(arg2));
        if (unique) fi.uniqueIndex = true; else fi.index = true;
        return undefined;
    }
    // Class form: (fields, where?, includeFields?) → a class decorator storing the transformer-
    // quoted selectors (each a Quoted fn carrying __quoted). They're stored as-is so the
    // SchemaBuilder can resolve them with the dialect known: `fields`/`includeFields` → columns via
    // accessedFields, `where` → SQL via getIndexWhere (Quoted → Expression → string).
    const fields = arg1 as Quoted<(element: any) => unknown>;
    const where = arg2 as Quoted<(element: any) => boolean> | undefined;
    const includeFields = arg3 as Quoted<(element: any) => unknown> | undefined;
    return function (target: Function): void {
        const ti = getOrCreateTypeInfo(target);
        (ti.indexes ??= []).push({ unique, fields, includeFields, where });
    };
}

// @fullTextIndex — Signum's fluent WithFullTextIndex, expressed as an altea class decorator (the
// same divergence as class-level @index). Marks one or more string columns for full-text search:
//
//   @fullTextIndex(e => [e.firstName, e.lastName, e.notes])
//   @fullTextIndex(e => e.title, { postgres: { configuration: "spanish" }, sqlServer: { changeTracking: "Manual" } })
//
// The field selector is stored raw (the SchemaBuilder runs it against a recording proxy to resolve
// the covered fields → columns). On SQL Server it becomes a CREATE FULLTEXT INDEX over those columns
// bound to a catalog; on Postgres a persisted generated tsvector column + a GIN index.
export function fullTextIndex<T>(
    fields: Quoted<(element: T) => unknown>,
    options?: {
        sqlServer?: { catalogName?: string; changeTracking?: 'Manual' | 'Auto' | 'Off' | 'Off_NoPopulation'; stoplistName?: string; propertyListName?: string };
        postgres?: { tsVectorColumnName?: string; configuration?: string; weights?: Record<string, 'A' | 'B' | 'C' | 'D'> };
    },
): (target: Function) => void {
    return function (target: Function): void {
        const ti = getOrCreateTypeInfo(target);
        const quotedFields = fields as Quoted<(element: any) => unknown>;
        (ti.fullTextIndexes ??= []).push({ fields: quotedFields, sqlServer: options?.sqlServer, postgres: options?.postgres });
        // Mark the covered fields with hasFullTextIndex (Signum's Schema.HasFullTextIndex →
        // MemberInfo.HasFullTextIndex) so the client can offer the full-text filter operations. Set
        // here (isomorphic) rather than in the server SchemaBuilder so it ships in the reflection
        // blob. Read the fields off the @quoted selector's AST (accessedFields).
        for (const name of accessedFields(quotedFields))
            getOrCreateFieldInfo(ti, name).hasFullTextIndex = true;
    };
}

// @vectorIndex — Signum's fluent WithVectorIndex as an altea class decorator (like @fullTextIndex).
// Marks one `vector(N)` column for nearest-neighbour search:
//
//   @vectorIndex(e => e.embedding)
//   @vectorIndex(e => e.embedding, { postgres: { indexType: "HNSW", metric: "Cosine" } })
//
// On SQL Server it becomes a CREATE VECTOR INDEX; on Postgres a pgvector hnsw/ivfflat index. The
// single-field @quoted selector is stored; the SchemaBuilder resolves it to its column.
export function vectorIndex<T>(
    field: Quoted<(element: T) => unknown>,
    options?: {
        sqlServer?: { metric?: 'Cosine' | 'Euclidean' | 'DotProduct'; indexType?: 'DiskANN'; maxDegreeOfParallelism?: number };
        postgres?: { indexType?: 'HNSW' | 'IVFFlat'; metric?: 'Cosine' | 'L2' | 'InnerProduct' | 'L1' | 'Hamming' | 'Jaccard'; lists?: number };
    },
): (target: Function) => void {
    return function (target: Function): void {
        const ti = getOrCreateTypeInfo(target);
        (ti.vectorIndexes ??= []).push({ field: field as Quoted<(element: any) => unknown>, sqlServer: options?.sqlServer, postgres: options?.postgres });
    };
}

export function allowUnauthenticated(target: Function): void {
    (target as any)[allowUnauthenticatedKey] = true;
}

// Sets the DEFAULT-language display name in code — Signum derived it from the C# identifier and let a
// `[Description("…")]` attribute override it; altea has no attributes, so authors override the humanized
// fallback explicitly. Works as BOTH a class decorator (the type's nice name) and a field decorator (a
// member's nice name), so one import covers both:
//
//     @niceName("Person") @nicePluralName("People")
//     class PersonEntity extends Entity {
//         @niceName("e-Mail") email: string;
//     }
//
// This is only the no-translation default: a loaded translation for the current UI culture still wins
// (see DescriptionManager). Keyed by the constructor name — the same key translations use — via ctorOf
// (which maps a class-decorator target (the ctor) and a field-decorator target (the prototype) alike).
export function niceName(text: string): ClassDecorator & PropertyDecorator {
    return ((target: object, propertyKey?: string | symbol): void => {
        if (propertyKey == null)
            setDefaultTypeDescription(ctorOf(target).name, { description: text });
        else
            setDefaultMemberDescription(ctorOf(target).name, String(propertyKey), text);
    }) as ClassDecorator & PropertyDecorator;
}

// Class decorator: the type's DEFAULT-language plural name (Signum's PluralDescription). Without it
// the plural is derived by the culture pluralizer from the (nice) singular; a loaded translation wins.
export function nicePluralName(text: string): ClassDecorator {
    return ((target: Function): void => {
        setDefaultTypeDescription(target.name, { pluralDescription: text });
    }) as ClassDecorator;
}

// Class decorator: the type's grammatical gender ("m" | "f" | "n"), e.g. `@gender("m") class PerroEntity`.
// Without it the gender is auto-detected from the (nice) name for the current UI culture — English has
// none, German/Spanish guess from the word ending — so this pins it where the guess would be wrong. A
// loaded translation's Gender still wins (see Localization.typeGender / Localization.gender).
export function gender(value: Gender): ClassDecorator {
    return ((target: Function): void => {
        setDefaultTypeDescription(target.name, { gender: value });
    }) as ClassDecorator;
}

// Controls whether a field is serialized to JSON (entities/serializer). `@serialize(false)` is
// the opt-out — for pure bookkeeping (e.g. isNew / _snapshot) or transient/server-only state
// that must never leave the server. Fields are serialized by default (even @column(false)
// ones, which are absent from the DB but still on the wire), so `@serialize(true)` / bare
// `@serialize()` is only ever needed to override an inherited `@serialize(false)`.
export function serialize(value: boolean = true) {
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).noSerialize = !value;
    };
}

export function fkProperty(propertyName: string) {
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).fkPropertyName = propertyName;
    };
}

// Field-level display metadata (Signum's [Format] / [Unit] from Entities/PropertyAttributes.cs).
// Applied to a (usually numeric or date) field; recorded on FieldInfo and surfaced by AutoLine and
// by the SearchControl result cells — and, crucially, by the query tokens: EntityPropertyToken reads
// them off its FieldInfo, and AggregateToken (Sum/Min/Max/Average) inherits them from its parent
// token, so a "Sum of Unit price" column keeps the "€" unit. Signum resolved these lazily from the
// PropertyRoute's attributes (Reflector.GetFormatString / UnitAttribute); altea has no attributes, so
// the decorator writes the value straight onto FieldInfo.

// @format("0.0000") / @format("p") — the .NET-style format string the UI uses to render the value.
export function format(formatString: string) {
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).format = formatString;
    };
}

// @unit("€") / @unit("Kg") — the unit symbol shown read-only beside the value.
export function unit(unitName: string) {
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).unit = unitName;
    };
}

// Field-level decorator: overrides column mapping (name / db types / size / precision /
// nullability) for a field. Stored on FieldInfo.columnOptions and consumed by SchemaBuilder.
// `@column(false)` instead marks the field as NOT mapped to a column (Signum's [Ignore] / EF's
// [NotMapped]) — excluded from the DB schema and change tracking, but it KEEPS its reflection
// type metadata (the transformer still auto-injects @field, so client-side UI controls and JSON
// see the type) and is still serialized to JSON unless also marked `@serialize(false)`. Lives in
// entities/ (the entity model owns its column annotations); the schema layer re-exports it.
export function column(options: ColumnOptions | false = {}) {
    return function (target: object, propertyKey: string | symbol) {
        const key = String(propertyKey);
        const typeInfo = getOrCreateTypeInfo(target);
        const existing = getOrCreateFieldInfo(typeInfo, key);

        if (options === false) {   // not mapped to a column
            existing.notMapped = true;
            typeInfo.fields[key] = existing;
            return;
        }

        const normalizedOptions: ColumnOptions = {
            ...options,
            columnName: options.columnName ?? key,
        };
        existing.columnOptions = normalizedOptions;
        // Mirror an explicit nullable into the field's nullability so the column
        // is generated NULL even when the TS type isn't `| null` (Signum's
        // ForceNullable). Auto-@field never sets nullable for a non-null type, so
        // this is the authoritative source for those.
        if (options.nullable != null)
            existing.isNullable = options.nullable;
        typeInfo.fields[key] = existing;
    };
}

// (Former `@include(() => Child)` removed: the quote-transformer now auto-emits a
// `type: () => X` thunk for every entity/embedded field — including `Child[]`
// collections — so the referenced constructor is captured by reference automatically.
// The schema builder resolves it via `fi.getFunction()`; part entities are still pulled
// into the schema transitively from that ctor.)

// Marks the int column that preserves MList row order (Signum's [PreserveOrder]).
export function rowOrder(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).isRowOrder = true;
}

// Signum's [ForceNullable]: the column is generated NULL even though the field's type is
// non-null. The object model still treats the field as required (queries navigate it without a
// null guard); only the physical column accepts NULL (e.g. a set-based UPDATE to null).
export function forceNullable(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).forceNullable = true;
}

// Marks the element-value field of a non-embedded MList row (the scalar /
// reference the MList<T> held), e.g. `@valueField colaborator: Lite<ArtistEntity>`.
export function valueField(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).isValueField = true;
}

export function implementedBy(types: () => Type<Entity>[]) {
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).implementations = { kind: 'implementedBy', types };
    };
}

export function implementedByAll(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).implementations = { kind: 'implementedByAll' };
}

// Overrides the custom lite used for a `Lite<T>` field (Signum's [LiteModel(type, ForEntityType)]):
// for this field, a value of `forEntityType` builds/rebuilds as `liteClass` instead of the type's
// default custom lite. Both args are thunks so the classes may be declared after the owner. May be
// applied more than once on one field — one per concrete type of a polymorphic (@implementedBy)
// lite, each pushing an entry — e.g. `@customLite(() => BandLite, () => BandEntity)` on an
// `author: Lite<IAuthorEntity>`.
export function customLite(liteClass: () => CustomLiteClass, forEntityType: () => Type<Entity>) {
    return function (target: object, propertyKey: string | symbol): void {
        const fi = getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey));
        (fi.customLite ??= []).push({ liteClass, forEntityType });
    };
}

// Child-side marker (Altea's MList replacement): tags the single FK field on a
// part entity that points back to its owner, e.g. `@backReference album: Lite<AlbumEntity>`
// inside `AlbumEntity_Songs`. The owner declares the collection as a plain
// `AlbumEntity_Songs[]` field (the transformer's `type` thunk supplies the child ctor);
// the SchemaBuilder finds this marked field as the back-pointing FK, so the relationship
// is described from both sides without repeating the property name.
export function backReference(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).isBackReference = true;
}
