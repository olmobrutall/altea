
import { Localization } from './utils/localization';
import type { Type, Entity } from './entity';
import type { EntityKind, EntityData } from './decorators';
import type { Quoted } from 'quote-transformer/quoted';
import { registerType, resolveType, resolveEnum, enumNameOf } from './registration';
import { MixinDeclarations } from './mixinDeclarations';
import { Decimal, Temporal } from './basics';
// TYPE-only: the enum's runtime object lives in a module that installs the Temporal prototype
// augmentations, and reflection.ts is imported by everything — the member NAMES are all it needs.
import type { DateTimePrecisionKeys } from './globals/dateTimeExtensions';

// The runtime type of a primary key. `int`/`long` are identity-style integers;
// `uuid`/`uuid7` are GUID columns (uuid7 is time-ordered). Maps to an
// AbstractDbType in logic/schema/dbType.
export type PrimaryKeyType = 'uuid' | 'uuid7' | 'int' | 'long';

/**
 * `size` meaning "unbounded" — `nvarchar(MAX)` / `varbinary(MAX)` on SQL Server, a bare (already
 * unbounded) `varchar` / `bytea` on PostgreSQL. Signum's `[DbType(Size = int.MaxValue)]`, and what
 * `[StringLengthValidator(Max = -1)]` answers; -1 rather than a huge number because that is also the
 * value the validator carries, so the two sentinels coincide.
 *
 * It has to be SAID, not left out: a string column with no size takes the per-provider DEFAULT of 200
 * (SchemaSettings.defaultSize*, ported in the schema builder's `getSqlSize`), so omitting it on a field
 * that holds a stack trace or an e-mail body would truncate it. Declared in `data` because the fields
 * that need it are entity declarations (`@column({ size: MAX_SIZE })`); `server/schema/column.ts` and
 * `server/sync/sqlBuilder.ts` re-export it for the engine side.
 */
export const MAX_SIZE = -1;

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
    // Decimal/numeric scale (digits after the point). Defaults to 2 for a decimal column
    // when precision is likewise unset (Signum's money default numeric(18,2)).
    scale?: number;
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
    | "String" | "Number" | "Boolean" | "Decimal" | "Guid" | "Blob"
    | "PlainDate" | "PlainDateTime" | "PlainTime" | "Duration" | "Instant" | "ZonedDateTime"
    | (string & {});

// How a @translatable field is edited and rendered (Signum's TranslatableRouteType, Signum.Basics):
// plain text, or rich HTML through the html editor.
export type TranslatableRouteType = "Text" | "Html";

// The precise .NET-style value alias (Signum drove int-vs-double `<NumberLine/>` formatting off this).
// Emitted by the transformer from the source primitive alias (see entities/basics); undefined ⇒ the
// typeName's default (e.g. Number ⇒ float/double).
export type SubTypeName = "short" | "int" | "long" | "float" | "decimal" | "uuid" | "uuid7";

// The type FACET of a field or a query token — "what type is this value": the value/enum/entity it
// holds, whether it is a collection / Lite / nullable, and (for references) the polymorphic
// implementations. Signum called this TypeReference and carried ONE on both MemberInfo and QueryToken;
// altea does the same — `FieldInfo extends TypeReference`, and QueryToken.type is a TypeReference —
// so the Lines layer and the FilterBuilder speak a single descriptor. (Signum's flat wire DTO becomes
// a class here so the resolution logic — the `type` thunk → ctor/enum → name — lives with the data.)
/**
 * Signum's `Validator.GlobalValidation` — a validator that applies to EVERY field of every entity.
 *
 * The one thing a per-field decorator cannot express: a rule chosen at RUNTIME, for a type the rule's
 * author does not own. @altea/altea-dynamic's DynamicValidation is the consumer — a validation written from
 * inside the running application, stored as a script, and applicable to any type.
 *
 * Runs AFTER the declared validators (so "is not set" still wins over a business rule) and BEFORE the
 * field's own `customValidation`. The first non-null message stops the pass, as Signum's does. An ASYNC
 * result is honoured on every server path (`validateAsync`) and SKIPPED on the client's live per-field
 * pass, exactly as `customValidation` already is: reporting "valid" there would be fail-open.
 */
export const globalValidators: Array<
    (entity: any, fi: FieldInfo, env: IntegrityCheckEnvironment) => string | null | undefined | Promise<string | null | undefined>
> = [];

/**
 * The CONSTRUCTOR a value `typeName` stands for, which is what `Validator.isCompatibleWith` is asked
 * about (`type === String`, `type === Temporal.PlainDate`, …). A value field carries only the name, so
 * without this table the compatibility check has nothing to hand it. `Guid` and `Blob` are deliberately
 * absent: no validator declares itself compatible with either, so naming them would turn "unmapped,
 * skip" into "incompatible, throw".
 */
function valueTypeConstructor(typeName: string | undefined): Function | undefined {
    switch (typeName) {
        case "String": return String;
        case "Number": return Number;
        case "Boolean": return Boolean;
        case "Decimal": return Decimal;
        case "PlainDate": return Temporal.PlainDate;
        case "PlainDateTime": return Temporal.PlainDateTime;
        case "PlainTime": return Temporal.PlainTime;
        case "Duration": return Temporal.Duration;
        default: return undefined;
    }
}

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

/**
 * The data MEMBER names of a modifiable — what a rule about "which member" compares against, and altea's
 * stand-in for C#'s `nameof`. Methods are excluded (`toString`, `isDirty`, a `@quoted` expression member),
 * as are the reserved bookkeeping fields no rule can meaningfully name.
 *
 * Write the type argument EXPLICITLY at the decorator — `@isReadOnly<OrderEntity>((o, fi) => …)` — which
 * is what makes `fi.name` this union and so makes a typo, or a member since renamed, a compile error.
 * Naming the CLASS is the point: `keyof this` compiles and then checks nothing, because inside the method
 * it is a deferred type.
 *
 * A MIXIN's member is not in its owner's union, since the owner's class does not declare it. So a rule
 * that NAMES such a member belongs on the mixin (`@isReadOnly<OrderDetailMixin>`), where it is declared;
 * a blanket rule on the owner still covers it, it just cannot name it. `fi.declaringType` tells the two
 * apart.
 */
export type MemberOf<T> = Exclude<
    Extract<{ [K in keyof T]: T[K] extends Function ? never : K }[keyof T], string>,
    "id" | "ticks" | "isNew" | "_snapshot">;

/**
 * A {@link FieldInfo} whose `name` is narrowed to `T`'s members — the second argument every model RULE
 * receives. It IS the FieldInfo (so `niceToString()`, `declaringType`, `format` all work); only the
 * declared type of `name` is tighter, which is where the checking comes from.
 */
export type FieldInfoOf<T> = FieldInfo & { readonly name: MemberOf<T> };

/**
 * A class- or field-level `@isReadOnly` predicate. `undefined` means "no opinion" and defers to whatever
 * is asked next (see `FieldInfo.isReadOnlyFor`).
 */
export type ReadOnlyRule = (entity: any, fi: FieldInfo) => boolean | undefined;

/**
 * The per-dialect options of a `@vectorIndex` (Signum's `VectorTableIndex.SqlServerOptions` /
 * `PostgresOptions`, as bare shapes — `data/` must not import the server's schema layer).
 *
 * Both halves are carried on BOTH tiers, and both are OPTIONAL: the SchemaBuilder fills each dialect's
 * default (`Cosine`, `HNSW` / `DiskANN`) when it builds the real index, and the query layer defaults the
 * METRIC the same way when it builds a `Distance` expression — a vector index declared with no options at
 * all is a cosine index on either provider.
 */
export interface VectorIndexOptions {
    sqlServer?: { metric?: 'Cosine' | 'Euclidean' | 'DotProduct'; indexType?: 'DiskANN'; maxDegreeOfParallelism?: number };
    postgres?: { indexType?: 'HNSW' | 'IVFFlat'; metric?: 'Cosine' | 'L2' | 'InnerProduct' | 'L1' | 'Hamming' | 'Jaccard'; lists?: number };
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
    // Set by @forceNotNullable (Signum's [ForceNotNullable]): the exact inverse — the COLUMN is NOT
    // NULL while the field stays nullable in the object model.
    forceNotNullable?: boolean;
    // Set by @column(false): excluded from the DB schema + change tracking (present only in the
    // object model), but still serialized to JSON by default.
    notMapped: boolean = false;
    // Set by @serialize(false): the JSON codec (entities/serializer) skips this field. Distinct
    // from @column(false) (which excludes a field from the DB schema + change tracking but leaves
    // it serializable) — used for pure bookkeeping like `isNew` / `_snapshot`.
    noSerialize?: boolean;
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
    // This member is MACHINERY, not vocabulary: it has no label a user ever reads, so the translation
    // sync must not ask for one. Without it every `@rowOrder` column raised a `<Member Name="Order">` in
    // every culture file of every package that owns a `@part` row — dozens of stubs for a positional
    // index, and (worse) a name that collides with the ORDER entity, so a translator filling them by name
    // would write "Pedido" where "Orden" was meant.
    //
    // Signum has no equivalent because it has no such member: an MList's order is a column of the
    // relation table, not a property of anything, so there is nothing for its sync to enumerate.
    avoidTranslation?: boolean;
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
    // Set when this field's column is covered by a class-level @fullTextIndex (Signum's
    // Schema.HasFullTextIndex(route), shipped on the member as MemberInfo.HasFullTextIndex).
    // Drives the client's full-text filter operations and the Rank sub-token. Computed by the
    // SchemaBuilder from TypeInfo.fullTextIndexes.
    hasFullTextIndex?: boolean;
    /**
     * Set when this field's `vector(N)` column carries a class-level `@vectorIndex` — Signum's
     * `VectorTableIndex`, which its `VectorColumnToken` is minted from and reads the distance METRIC off.
     *
     * altea has no VectorColumnToken (see `data/dynamicQuery/tokens/vectorTokens`): the vector PROPERTY's
     * own token is the one the `Distance` sub-token hangs off, exactly as `MatchRank` hangs off the
     * full-text-indexed string property — so the index options have to reach the token, and the token is
     * isomorphic. Stamped by the decorator (like `hasFullTextIndex`), NOT by the SchemaBuilder, so the
     * client sees it without a server round-trip.
     */
    vectorIndex?: VectorIndexOptions;
    columnOptions?: ColumnOptions;
    // The LOGICAL name SIGNUM gave this field's column (@legacyColumnName), used ONLY when
    // SchemaSettings.legacyMode is on — for a field altea models differently from Signum but which occupies
    // the same column. Mapped to the dialect by SchemaBuilder.idiomatic, unlike the verbatim
    // @column({ columnName }), which still wins where both are given.
    legacyColumnName?: string;
    // Signum's MemberInfo display metadata (the client Lines layer reads these off the PropertyRoute's
    // field). undefined ⇒ default rendering — same as Signum without the attrs. (Signum's
    // MemberInfo.required has no altea field: it's `!isNullable`.) `format` / `unit` are set by the
    // @format / @unit decorators (Signum's [Format] / [Unit]) and flow to the query tokens.

    /**
     * Set by `@bindParent` (Signum's `[BindParent]`): the modifiable(s) this field holds belong to this
     * entity, so the parent back-pointer is stamped on them — see data/parentEntity for the whole story.
     * Explicit, as in Signum: the marker is what says "this member's value is mine", and it is what the
     * binding walk follows.
     */
    bindParent?: boolean;

    /**
     * Set by `@isReadOnly` on THIS field — the property-level half of "this member cannot be edited", and
     * the union of two things Signum keeps apart: its static `MemberInfo.isReadOnly` (a boolean) and its
     * per-property `PropertyValidator.IsReadonly` event (a predicate over the instance). One decorator
     * writes either, because both answer the same question and both are read by `isReadOnlyFor`.
     *
     * A single value, not a list: a field carries one declaration (a second `@isReadOnly` on it replaces
     * the first). The CLASS-level rules are a list — see `TypeInfo.isReadOnly` — because a prototype chain
     * and a mixin can each contribute one.
     */
    isReadOnly?: boolean | ReadOnlyRule;
    format?: string;
    unit?: string;
    // Signum's [DecimalsValidator(n)].DecimalPlaces, recorded here by `@decimalsValidator` because two
    // readers that cannot see the validator list need it: the SCHEMA (the column's scale — Signum's
    // SchemaSettings.GetSqlScale) and the DISPLAY FORMAT below (Reflector.GetFormatString's "N" + n).
    decimalPlaces?: number;
    // Signum's [DateTimePrecisionValidator(p)].Precision, recorded here by `@dateTimePrecisionValidator`
    // for ONE reader: `defaultFormat`, below, which lives in this module — and this module cannot import
    // validators.ts, which imports it. Every other reader can, and does: the query tokens find the
    // validator in `fi.validators` the way schemaBuilder finds a StringLengthValidator there. Keep it
    // that way — a copy is only justified where the validator is genuinely out of reach. The member
    // NAME, which is altea's runtime value for an enum.
    dateTimePrecision?: DateTimePrecisionKeys;
    isMultiline?: boolean;
    maxLength?: number;
    // Signum's `MemberInfo.notVisible` — this field is an implementation detail, not a user-facing
    // property, so the AUTO-GENERATED view (and EntityTable's default columns) must not render it. Set
    // imperatively from a client start, never by a decorator: whether a field is worth showing is a
    // decision of whoever assembles the UI, and the same field may be internal in one app and
    // meaningful in another. altea-tree's `TreeClient.hideTreeInternals` is the first caller (the two
    // positioning fields are inputs to the Save operation, and the route columns are engine state).
    notVisible?: boolean;
    // Set by @translatable (Signum's [Translatable]): this string field may carry a PER-INSTANCE
    // translation, managed by @altea/altea-translations. "Text" is plain, "Html" is rich (the editor
    // shows a WYSIWYG). `false` on an EMBEDDED field switches translation OFF for that route and
    // everything below it, even where a descendant is marked translatable — Signum's
    // `[Translatable(false)]`. It lives on the compile-time descriptor rather than the per-request
    // metadata blob because it is the same for every user and every culture, and because the CLIENT
    // needs it to put the translate button on a line — exactly what Signum ships as
    // `MemberInfo.translatable`.
    translatable?: TranslatableRouteType | false;

    validators: Validator[] = [];
    /**
     * Signum's StaticPropertyValidation. May be ASYNC: a validation that has to open a file, resolve
     * query tokens or hit the database cannot be expressed synchronously (see the template parse in
     * @altea/altea-office-template). An async one runs ONLY on the awaiting paths — the server's save
     * and deserialization passes, and the explicit /api/validateEntity pre-flight — never in the
     * client's live per-keystroke path, which must stay synchronous and must not do I/O per render.
     */
    customValidation?: (entity: any, fieldInfo: FieldInfo, env: IntegrityCheckEnvironment) => string | null | undefined | Promise<string | null | undefined>;

    constructor(name: string) {
        super();
        this.name = name;
    }

    niceToString(): string {
        const declared = this.declaringType?.ctor != null
            ? Localization.Internal.tryMemberNiceName(this.declaringType.ctor.name, this.name)
            : undefined;
        return declared ?? Localization.Internal.niceMemberName(this.name);
    }

    /**
     * Whether this field is read-only for `entity` — Signum's `PropertyValidator.IsPropertyReadonly`, and
     * the single source both tiers go through: the client Lines layer (`Binding.getIsReadonly`, applied by
     * LineBase's `taskSetReadOnly`) and the serializer's write gate (Signum's `AssertCanWrite`).
     *
     * Asked in ONE order, and the first answer that is not `undefined` wins:
     *   1. this FIELD's own `@isReadOnly`;
     *   2. the class-level `@isReadOnly` rules of the class that DECLARES the field — which for a mixin's
     *      member is the mixin, the only place a rule can name it (see the note on `MemberOf`);
     *   3. the class-level rules of the entity itself, most-derived first, up the prototype chain.
     *
     * `undefined` means "no opinion", so the DEFAULT behaviour is to defer — which is what replaces
     * Signum's `super.IsPropertyReadonly(pi)` call, and why no rule needs a handle on the next one. A
     * `false` WINS over everything below it, which makes `@isReadOnly(false)` on a field the escape hatch
     * from a whole-entity rule; Signum lets its per-property event win only on `true` and cannot say
     * "editable in spite of the entity".
     *
     * Property AUTHORIZATION is a separate source, per ROLE rather than per instance; it is enforced by
     * the serializer and by altea-auth's own line task, and is deliberately not folded in here (a field
     * the role may not write is not a field the model calls read-only).
     */
    // `entity` is `any` for the same reason `validate` above takes one: data/entity imports THIS file,
    // so BaseEntity cannot be imported back.
    isReadOnlyFor(entity: any): boolean {
        const own = typeof this.isReadOnly === "function" ? this.isReadOnly(entity, this) : this.isReadOnly;
        if (own !== undefined)
            return own;

        for (const ctor of ruleOwners(entity?.constructor, this.declaringType?.ctor)) {
            for (const rule of getTypeInfo(ctor)?.isReadOnly ?? []) {
                const answer = typeof rule === "function" ? rule(entity, this) : rule;
                if (answer !== undefined)
                    return answer;
            }
        }

        return false;
    }

    // Runs this field's validators (then any customValidation) against `entity`, returning the
    // first error message or null. Single source of field validation — used by BOTH
    // entityIntegrityCheck (whole entity) and the client Binding.getError (per-field, live),
    // so the two never diverge.
    validate(entity: any, env: IntegrityCheckEnvironment): string | null {
        const error = this.validateDeclared(entity, env);
        if (error != null)
            return error;

        const global = this.validateGlobalSync(entity, env);
        if (global != null)
            return global;

        const custom = this.customValidation?.(entity, this, env);
        // A PENDING custom validation cannot be resolved here. Reporting "valid" would be fail-open,
        // so the sync path reports NOTHING and `validateAsync` (every server path) is what enforces it.
        // The client therefore learns about such a rule when it tries to save, exactly as it already
        // does for any validator disabled outside the "Saving" phase.
        if (custom instanceof Promise)
            return null;

        return custom ?? null;
    }

    /**
     * The same check, awaiting an async customValidation. Used by every path that CAN await: the
     * Saver's "Saving" pass, the operation endpoint's "ServerDeserialization" pass, and
     * /api/validateEntity.
     */
    async validateAsync(entity: any, env: IntegrityCheckEnvironment): Promise<string | null> {
        const error = this.validateDeclared(entity, env);
        if (error != null)
            return error;

        for (const global of globalValidators) {
            const result = await global(entity, this, env);
            if (result != null)
                return result;
        }

        return (await this.customValidation?.(entity, this, env)) ?? null;
    }

    /** The sync half of the global pass — a PENDING result is skipped, as for customValidation. */
    private validateGlobalSync(entity: any, env: IntegrityCheckEnvironment): string | null {
        for (const global of globalValidators) {
            const result = global(entity, this, env);
            if (result instanceof Promise)
                continue;
            if (result != null)
                return result;
        }
        return null;
    }

    /** The declared validators (implicit NotNull first), shared by both entry points. */
    private validateDeclared(entity: any, env: IntegrityCheckEnvironment): string | null {
        this.assertValidatorsCompatible();
        const value = entity[this.name];
        // Signum auto-adds a NotNullValidator to every non-nullable reference/string property; altea
        // synthesises it here (see getImplicitNotNull) so it runs BEFORE the declared validators — a
        // not-set value should surface "is not set", not a downstream format error.
        const implicit = this.getImplicitNotNull();
        if (implicit != null) {
            const error = implicit.error(value, entity, this, env);
            if (error != null) return error;
        }
        for (const validator of this.validators) {
            const error = validator.error(value, entity, this, env);
            if (error != null) return error;
        }
        return null;
    }

    /**
     * Signum's `PropertyValidator.AssertCompatible` — every validator declares `isCompatibleWith`, and
     * until now NOTHING asked, so a `@decimalsValidator` on a string was silently accepted and simply
     * never fired.
     *
     * LAZY and memoised, which is where Signum puts it too: it asserts while BUILDING the
     * PropertyValidator, i.e. the first time the type is reflected, not at attribute-application time.
     * altea cannot assert in the decorator either, and for a sharper reason — `TypeReference.type` is a
     * THUNK, so resolving it while the class is still being declared can hit a not-yet-initialised
     * binding. By the time a value is being validated the graph is complete.
     *
     * A field whose type does not resolve to a constructor (an enum, a bare value `typeName`) is skipped
     * rather than guessed at: `isCompatibleWith` is asked about a `Function`, and there is nothing
     * truthful to hand it.
     */
    private compatibilityChecked = false;
    private assertValidatorsCompatible(): void {
        if (this.compatibilityChecked)
            return;

        // A COLLECTION field's type is `Array`, not its element's — `getFunction()` answers the element,
        // which is what a `CountIsValidator` (compatible with `Array`) would otherwise be measured against.
        // Signum has this for free: `IsCompatibleWith(PropertyInfo)` reads `pi.PropertyType`, and an MList
        // property's type IS the collection.
        const ctor = this.array ? Array : (this.getFunction() ?? valueTypeConstructor(this.typeName));
        if (ctor != undefined)
            for (const validator of this.validators)
                // A validator that declares NO compatibility answers for everything, as Signum's base does.
                if (validator.isCompatibleWith != undefined && !validator.isCompatibleWith(ctor))
                    throw new Error(
                        `Validator ${validator.constructor.name} is not compatible with the field ` +
                        `'${this.name}' of type ${ctor.name}.`);

        // Only a PASSING check is remembered. Setting the flag first would make a bad declaration throw
        // once and then validate silently for the rest of the process — fail-open, and worse than never
        // having checked. Signum cannot hit this: it asserts while BUILDING the PropertyValidator, so a
        // failure means the validator never exists at all.
        this.compatibilityChecked = true;
    }

    // Signum's implicit NotNullValidator (PropertyValidator ctor: a non-nullable, non-value-type
    // property with no explicit NotNullValidator gets one automatically). altea computes it lazily off
    // reflection metadata and memoizes it (the field graph is frozen after boot). The validator INSTANCE
    // is built by a factory validators.ts registers (registerImplicitNotNullValidator) — reflection.ts
    // can't import validators.ts (cycle). Fetched lazily, so it is never wrongly cached as "absent" when
    // the factory is registered after the first probe.
    #needsImplicitNotNull?: boolean;
    #implicitNotNull?: Validator;
    private getImplicitNotNull(): Validator | undefined {
        if (this.#needsImplicitNotNull === undefined)
            this.#needsImplicitNotNull = this.computeNeedsImplicitNotNull();
        if (!this.#needsImplicitNotNull) return undefined;
        return this.#implicitNotNull ??= implicitNotNullValidatorFactory?.();
    }

    private computeNeedsImplicitNotNull(): boolean {
        if (this.isNullable) return false;
        // @backReference (owner FK) and @rowOrder (MList row index) are wired by the save cascade
        // (saver.wireOwnedChildren), not the user — so, like Signum's implicit MList back-pointer /
        // PreserveOrder column, they are never validated as required. (@valueField, by contrast, holds
        // the actual element value and stays required.)
        if (this.isBackReference || this.isRowOrder) return false;
        // Collections default to [] (see the transformer's array init) — never null — so a NotNull would
        // be a no-op; "required = non-empty" is a separate CountIs concern, not NotNull.
        if (this.array) return false;
        // An explicit NotNullValidator wins — including a DISABLED one, which is exactly how you opt out
        // of the implicit check (`@notNullValidator({ disabled: () => true })`).
        if (this.validators.some(v => v.isNotNull)) return false;
        // DIVERGENCE from Signum: Signum's implicit NotNull is added ONLY to reference types
        // (`!pi.PropertyType.IsValueType`) because a non-nullable C# struct/enum PHYSICALLY can't be null,
        // so validating it is pointless. In TypeScript that guarantee does not exist — a non-nullable
        // `number` / `boolean` / enum / `PlainDate` field is `undefined` on a freshly-constructed entity —
        // so altea requires EVERY non-nullable field, value types included. The DB-generated framework
        // fields (id / ticks / isNew / _snapshot) are never reached: forEachField (the validation driver)
        // skips them via RESERVED_FIELDS, and the client only validates fields a Line actually binds.
        return true;
    }
}

// The three points at which an entity is validated, passed to every Validator so a validator can opt
// out of a specific phase (Signum's single `Validator.InModelBinder` bool generalised to an enum):
//   - "Client"               — in the browser, BEFORE the entity is sent (fail fast, no round-trip);
//   - "ServerDeserialization"— on the server, right after the request body is deserialized (Signum's
//                              model-binder validation) — the value may be filled by server logic later;
//   - "Saving"               — on the server, immediately before the row is written (the last word).
export type IntegrityCheckEnvironment = "Client" | "ServerDeserialization" | "Saving";

// Validator is declared here (forward-reference) to break the circular dep
// between reflection ↔ validators.  The full implementations live in validators.ts.
export abstract class Validator {
    isApplicable?: (entity: any) => boolean;
    // Per-environment opt-out (Signum's ValidatorAttribute.DisabledInModelBinder, generalised): return
    // true to SKIP this validator in the given environment. Set via `@<validator>({ disabled: env => … })`.
    // Examples: `env => true` (always off — the plain opt-out), `env => env === "Client"` (server-only,
    // e.g. a uniqueness check the browser can't run), `env => env !== "Saving"` (only enforced at save).
    disabled?: (env: IntegrityCheckEnvironment) => boolean;

    // True for the NotNullValidator (Signum tests `v is NotNullValidatorAttribute`). Lets the reflection
    // layer detect an already-declared NotNull without importing validators.ts (cycle). Overridden there.
    get isNotNull(): boolean { return false; }

    // True for a CountIsValidator that means "non-empty" (Signum's CountIsValidatorAttribute
    // .IsGreaterThanZero: GreaterThan 0 / GreaterThanOrEqualTo 1). It is what makes a COLLECTION line
    // mandatory in the UI — Signum computes MemberInfo.Required from exactly this test. Declared here (not
    // in validators.ts) for the same cycle reason as isNotNull, so the client's taskSetMandatory and the
    // reflection layer can read it off any Validator. Overridden by CountIsValidator.
    get isGreaterThanZero(): boolean { return false; }

    abstract get helpMessage(): string;
    isCompatibleWith?(type: Function): boolean;

    protected abstract overrideError(value: unknown, entity: any, fieldName: FieldInfo): string | null;

    error(value: unknown, entity: any, fieldName: FieldInfo, env: IntegrityCheckEnvironment): string | null {
        if (this.disabled != null && this.disabled(env)) return null;
        if (this.isApplicable != null && !this.isApplicable(entity)) return null;
        return this.overrideError(value, entity, fieldName);
    }
}

// The implicit NotNull validator (Signum auto-adds one to every non-nullable reference/string property
// without an explicit NotNullValidator). Its CLASS and the `@notNullValidator` decorator live in
// validators.ts; to avoid the reflection→validators import cycle, validators.ts registers a factory here
// at module load. FieldInfo.getImplicitNotNull fetches it lazily, so registration order is irrelevant.
let implicitNotNullValidatorFactory: (() => Validator) | undefined;
export function registerImplicitNotNullValidator(factory: () => Validator): void {
    implicitNotNullValidatorFactory = factory;
}

export class TypeInfo {
    constructor() {
        this.fields = Object.create(null); // null-proto: `fields["toString"]` etc. is undefined, not an inherited Object.prototype member
    }

    fields: { [fieldName: string]: FieldInfo };
    /**
     * Set by a class-level `@isReadOnly` — a rule about EVERY member of this type at once, which is what
     * Signum's `ModifiableEntity.IsPropertyReadonly(PropertyInfo)` override is for (Southwind's order is
     * read-only in every member once it is Shipped). A LIST, because a prototype chain and a mixin can each
     * contribute one and they compose — and because that makes the imperative override a `push` / `unshift`
     * rather than a clobber. Read, in order, by `FieldInfo.isReadOnlyFor`.
     */
    isReadOnly?: (boolean | ReadOnlyRule)[];
    // Explicit database table/view name (Signum's [TableName]); overrides the
    // name derived from the class. For a view class (@reflect + @tableName) this is
    // the raw view name ViewBuilder maps to, e.g. "pg_catalog.pg_namespace".
    tableName?: string;
    // The name SIGNUM gave this type's table (@legacyTableName), used ONLY when SchemaSettings.legacyMode
    // is on. Logical, so it is dialect-mapped like a derived name. See the decorator for why it cannot be
    // computed from the model.
    legacyTableName?: string;
    // `@legacyTableName({ wasVirtualMList: true })`: Signum has no MList table for the collection holding
    // this type — its element is a standalone Entity, so the table is named after the ENTITY and
    // legacyCollectionTableName must stand down. Like legacyTableName, read ONLY under legacyMode.
    legacyWasVirtualMList?: boolean;
    // `@ticksColumn(true|false)` (Signum's [TicksColumn]): whether the table carries a concurrency stamp.
    // Undefined means the DEFAULT, which depends on the kind — a `@part` row has none, anything else has
    // one. See the decorator.
    ticksColumn?: boolean;
    // Set by class-level @index / @uniqueIndex(e => [e.a, e.b]): composite indexes declared
    // by column-selector lambdas. Stored as the @quoted selectors; the SchemaBuilder resolves the
    // covered fields → columns by reading each captured AST (accessedFields), like `where`.
    indexes?: { unique: boolean; fields: Quoted<(element: any) => unknown>; includeFields?: Quoted<(element: any) => unknown>; where?: Quoted<(element: any) => boolean> }[];
    // Set by class-level @fullTextIndex(e => [e.a, e.b], options?): a full-text index over the
    // selected string columns (Signum's WithFullTextIndex). Stored as the @quoted selector plus the
    // per-dialect options as bare shapes (entities/ can't import the server tableIndex types); the
    // SchemaBuilder resolves the fields → columns and builds a FullTextTableIndex.
    fullTextIndexes?: {
        fields: Quoted<(element: any) => unknown>;
        sqlServer?: { catalogName?: string; changeTracking?: 'Manual' | 'Auto' | 'Off' | 'Off_NoPopulation'; stoplistName?: string; propertyListName?: string };
        postgres?: { tsVectorColumnName?: string; configuration?: string; weights?: Record<string, 'A' | 'B' | 'C' | 'D'> };
    }[];
    // Set by @vectorIndex(e => e.embedding, options?): a nearest-neighbour index over one vector
    // column (Signum's WithVectorIndex). Stored as the @quoted single-column selector + per-dialect
    // options as bare shapes; the SchemaBuilder resolves the column and builds a VectorTableIndex.
    vectorIndexes?: ({ field: Quoted<(element: any) => unknown> } & VectorIndexOptions)[];
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
    // Signum's `[PrimaryKey(IdentityBehaviour = false)]`: the PK is NOT a DB identity — its ids are
    // supplied externally (seeded by SymbolLogic / the enum value). Stamped by `@entity(..., { identity:
    // false })`; default (undefined) = a normal DB identity PK. Read by the SchemaBuilder.
    identity?: boolean;

    // (Signum's TypeInfo.operations / hasConstructorOperation / gender are GONE from here — they are
    // per-role or per-culture, so they belong to the metadata blob, not to this compile-time descriptor.
    // Read them via Metadata.tryType(name) / the client's getOperationInfos (client/Reflection).)

    // niceName / nicePluralName are METHODS (not cached fields): the display name is
    // culture-dependent, so a cached string would be stale after a culture switch (esp. on the
    // server). Named get* (not `niceName`) so Signum's field-style `ti.niceName` is a COMPILE error to
    // sweep, instead of compiling to a function ref that fails at runtime. Prefer the fluent form
    // `SomeEntity.niceName()` (data/entity) — these two exist for callers holding only a TypeInfo.
    getNiceName(): string { return this.ctor!.niceName(); }
    getNicePluralName(): string { return this.ctor!.nicePluralName(); }
    /** Grammatical gender for the current UI culture (Signum's TypeInfo.gender, a field there). */
    getGender(): string | undefined { return this.ctor!.gender(); }

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

    // Signum's TypeInfo.kind, narrowed to what a TypeInfo can describe: altea attaches TypeInfo only to
    // reflected CLASSES, so it is "Entity" (persisted) or "Model" (embedded / model / mixin — anything
    // not backed by its own table). Enums and containers have no class to carry a TypeInfo; their kinds
    // exist only in the metadata blob (data/metadata KindOfType).
    get kind(): "Entity" | "Model" {
        return this.ctor != null && isPersistedEntity(this.ctor) ? "Entity" : "Model";
    }
}

// Set once by data/entity (which imports THIS module, so the dependency can only run that way): whether a
// ctor descends from the persisted `Entity` base. A direct `import { Entity }` here would be a cycle.
let isPersistedEntity: (ctor: Function) => boolean = () => true;
export function registerIsPersistedEntity(fn: (ctor: Function) => boolean): void { isPersistedEntity = fn; }

// The five operation kinds (Signum's OperationType). STABLE per operation, so it stays on the Info side;
// the per-culture label and the per-role allowance live on `OperationMetadata` (data/metadata).
export type OperationType = "Execute" | "Delete" | "Constructor" | "ConstructorFrom" | "ConstructorFromMany";

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
    if (inherited != null) {
        Object.assign(created.fields, inherited.fields);
        // `@ticksColumn(false)` is inherited, unlike every other class-level flag here. It describes what
        // KIND of table this is — one the engine writes rather than a person edits — and that is true of
        // every subclass of a base that says it (Signum's [TicksColumn] is inherited for the same reason:
        // SemiSymbol declares it once and every note type / alert type / agent gets it).
        if (inherited.ticksColumn !== undefined)
            created.ticksColumn = inherited.ticksColumn;
    }

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
    registerType, resolveType, getRegisteredTypes,
    registerEnum, resolveEnum, enumNameOf,
    registerObject, resolveObject,
    getLocation,
    init, declaredSymbolsForType, renameSymbolContainer, legacyClassName, legacyCleanNameOf,
    setLegacyMode, isLegacyMode, declaredLegacyClassNames,
    setDefaultTypeDescription, setDefaultMemberDescription, getDefaultDescription,
    setDefaultCulture, getPackageCulture, cultureForName,
    setDefaultDatabaseSchema, setDatabaseSchema, schemaForName,
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

/**
 * The FieldInfo for ONE member of a modifiable, looked up the way every reader must: the type's own
 * fields (which already carry the inherited ones — `getOrCreateTypeInfo` seeds a subclass from its base)
 * and then the fields each declared MIXIN contributes.
 *
 * That second half is the whole reason this exists. altea inlines a mixin's fields onto the owner's
 * instance (`mixin()` is a cast), but NOT onto the owner's TypeInfo — a mixin keeps its own, and
 * `MixinDeclarations` is the only link. So a bare `getTypeInfo(ctor).fields[member]` silently answers
 * undefined for a mixin's member: `OrderLineEntity.fields` has no `discountCode`, it lives on
 * `OrderDetailMixin`. Every caller that reads a field BY NAME goes through here instead (the serializer
 * and `changes.forEachField` iterate the same two levels for themselves).
 */
export function resolveField(target: object, member: string): FieldInfo | undefined {
    const ctor = ctorOf(target) as Type<Entity>;
    const own = getTypeInfo(ctor)?.fields[member];
    if (own != null)
        return own;

    for (const mixinClass of MixinDeclarations.getMixins(ctor)) {
        const fi = getTypeInfo(mixinClass)?.fields[member];
        if (fi != null)
            return fi;
    }

    return undefined;
}

/**
 * Every reflected field of a modifiable TYPE — its own (inherited ones included, since a subclass's
 * TypeInfo is seeded from its base) plus the ones each declared MIXIN contributes. The iterating twin of
 * {@link resolveField}, and the same reason for existing: a mixin keeps its own TypeInfo, so one level is
 * never the whole field list.
 *
 * Takes a CONSTRUCTOR, so it needs no instance — unlike `changes.forEachField`, which reads values and
 * deliberately skips `@column(false)` and the reserved bookkeeping fields because it serves the snapshot
 * diff. Nothing is filtered here.
 */
/**
 * The classes whose CLASS-LEVEL rules apply to a field of `entityCtor` declared by `declaringCtor`, in the
 * order they are asked: the declaring class first when it is not part of the entity's own chain (i.e. a
 * MIXIN, the only place a rule can name that field), then the entity's prototype chain, most-derived
 * first. Deduped, so an own field does not ask its declaring class twice.
 *
 * Walking the chain at RESOLVE time rather than copying rules at decoration time is deliberate: a
 * subclass's own `@isReadOnly` would otherwise replace the base's, since `getOrCreateTypeInfo` seeds a
 * subclass by shallow-copying its base's TypeInfo. Same reason `OperationLogic.operationsForType` walks.
 */
export function ruleOwners(entityCtor: Function | undefined, declaringCtor?: Function): Function[] {
    const chain: Function[] = [];
    for (let c: Function | null = entityCtor ?? null; c != null && c !== Function.prototype; c = Object.getPrototypeOf(c))
        chain.push(c);

    if (declaringCtor != null && !chain.includes(declaringCtor))
        return [declaringCtor, ...chain];

    return chain;
}

export function eachFieldInfo(ctor: Function, callback: (fi: FieldInfo) => void): void {
    const visit = (owner: Function): void => {
        const ti = getTypeInfo(owner);
        if (ti == null) return;
        for (const fi of Object.values(ti.fields)) callback(fi);
    };

    visit(ctor);
    for (const mixinClass of MixinDeclarations.getMixins(ctor as Type<Entity>))
        visit(mixinClass);
}

// The default display format for a value type when no explicit @format is given (Signum's
// Reflector.FormatString). A decimal renders with two fixed fraction digits ("N2" → 0.00); everything
// else has no default (the UI falls back to the locale default). Both altea decimal spellings resolve
// here: the branded `decimal` alias (typeName "Number", subTypeName "decimal") and a `Decimal` value
// type. Used wherever a format is read — Lines (taskSetFormat), the entity-property and extension tokens.
//
// A VALIDATOR comes FIRST, as it does in Signum: `Reflector.GetFormatString` checks an explicit [Format]
// (the callers' own `fi.format ??` here), then the validators, then the type default. So four decimals
// declared on the value show as four without a second `@format("N4")` saying so, and a date declared to
// the second shows its seconds without a second `@format("G")`.
export function defaultFormat(tr: (Pick<TypeReference, 'typeName' | 'subTypeName'> & { decimalPlaces?: number, dateTimePrecision?: DateTimePrecisionKeys }) | undefined): string | undefined {
    if (tr == undefined)
        return undefined;
    if (tr.decimalPlaces != undefined)
        return "N" + tr.decimalPlaces;
    if (tr.dateTimePrecision != undefined)
        return dateTimePrecisionFormat[tr.dateTimePrecision];
    if (tr.subTypeName === "decimal" || tr.typeName === "Decimal")
        return "N2";
    return undefined;
}

// Signum's `DateTimePrecisionValidatorAttribute.FormatString` — how far along a date a display should
// read, given how far the property is allowed to go.
//
// DIVERGENCE: Signum's five answers are three standard .NET specifiers ("d", "g", "G") plus two CUSTOM
// patterns built from the current culture (`ShortDatePattern + " HH"`, and the long time pattern with
// "ss" → "ss.fff"). altea's date layer is Intl-options-based, not pattern-based — its format vocabulary
// is the standard specifiers alone — so the two custom cases get altea-only specifiers of their own,
// mapped in client/Lines/ReactWidgetsLocalizer's toDateFormatOptions next to the standard ones. The
// culture stays where Intl keeps it instead of being baked into a pattern here.
const dateTimePrecisionFormat: Record<DateTimePrecisionKeys, string> = {
    Days: "d",
    Hours: "dH",
    Minutes: "g",
    Seconds: "G",
    Milliseconds: "Gf",
};

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
