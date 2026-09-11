
import { getOrCreateTypeInfo, getOrCreateFieldInfo, registerType, FieldInfo, ctorOf, setDefaultTypeDescription, setDefaultMemberDescription } from './reflection';
import type { Gender } from './utils/naturalLanguage';
import type { PrimaryKeyType, ColumnOptions, TranslatableRouteType, FieldInfoOf, ReadOnlyRule } from './reflection';
import type { Type, Entity } from './entity';
import type { CustomLiteClass } from './lite';
import type { ExLambda, Quoted } from 'quote-transformer/quoted';
import { accessedFields, memberPath } from './accessedFields';
import { declareLegacyCleanName, declareLegacyClassName } from './registration';

export type { ColumnOptions, TranslatableRouteType } from './reflection';

// `@quoted` / `withQuoted` mark a method (or function) whose body the quote-transformer
// captures as a translatable expression, stored on `__quoted`. They live here (entities)
// so the entity model can annotate expression members without depending on the query
// layer. The query-layer's richer carrier (QuotedFunction, with __resultType/__sqlMethod)
// + cast helper (quotedFunction) stay in logic/query. Here we only touch `__quoted`, so the
// transformer's own `Quoted<T> = T & { __quoted? }` is the carrier type.

// Three call shapes:
//   @quoted        — bare. The quote-transformer rewrites it to @quoted(() => <expr>)
//                    before emit, so this overload exists only so the bare form
//                    type-checks as a method decorator.
//   @quoted(fn)    — the expression written OUT, because the method BODY diverges from it. SQL is
//                    null-tolerant and JavaScript arithmetic is not, so an in-memory implementation
//                    often needs guards the translated formula must not carry:
//
//                      @quoted(function (this: OrderLineEntity) {
//                          return Decimal.mul(Decimal.mul(this.quantity, this.unitPrice),
//                              Decimal.sub(1, this.discount));
//                      })
//                      subTotalPrice(): Decimal {
//                          if (this.quantity == null || this.unitPrice == null)
//                              return null!;
//                          return Decimal.mul(Decimal.mul(this.quantity, this.unitPrice),
//                              Decimal.sub(1, this.discount ?? 0));
//                      }
//
//                    A FUNCTION EXPRESSION, not an arrow: an arrow cannot declare a `this` parameter, and
//                    the expression has to be written in terms of `this` to read as the same formula the
//                    body does (an arrow taking the entity as its parameter is accepted too). Its body must
//                    be exactly one `return`, as a bare @quoted method's is. The transformer REPLACES it
//                    with the quoted tree, so it is never CALLED at runtime — it is there to be read and
//                    type-checked against the member it stands for.
//   @quoted(exp)   — the rewritten form the transformer produces: a thunk yielding the ExLambda.
export function quoted(target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): void;
export function quoted(exp?: () => ExLambda): (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => void;
export function quoted<A extends unknown[], R>(expression: (this: any, ...args: A) => R):
    (target: object, propertyKey: string | symbol, descriptor: TypedPropertyDescriptor<(...args: A) => R>) => void;
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

// Functional form of @quoted, for attaching a quoted expression to a function value (e.g. a prototype
// method added outside a class — which is how every registered expression is stamped). The transformer
// rewrites `withQuoted(fn)` to inject the captured expression as the second argument.
//
// `withQuoted(fn, expression)` is the counterpart of `@quoted(<lambda>)`: the expression written OUT
// because the runtime body has to DIVERGE from it — a guard against the nulls SQL propagates by itself,
// say. The transformer quotes the second argument and replaces it with the thunk, so the expression is
// never CALLED; it is there to be read and type-checked. It must have the same signature as `fn`, `this`
// included, which is what the first overload says:
//
//     Entity.prototype.alerts = withQuoted(
//         function (this: Entity): IQuery<AlertEntity> {
//             return this.id == null ? emptyQuery() : table(AlertEntity).filter(a => a.target!.is(this));
//         },
//         function (this: Entity): IQuery<AlertEntity> {
//             return table(AlertEntity).filter(a => a.target!.is(this));
//         });
export function withQuoted<T extends (this: any, ...args: any[]) => any>(f: T, expression: T): T;
export function withQuoted<T extends Function>(f: T, quoted?: () => ExLambda): T;
export function withQuoted<T extends Function>(f: T, quoted?: () => ExLambda): T {
    (f as Quoted<T>).__quoted = quoted;
    return f;
}

export type { PrimaryKeyType } from './reflection';


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
    // Signum's `[PrimaryKey(IdentityBehaviour = false)]`: the PK is NOT a DB identity — ids are supplied
    // externally (a Symbol seeded by SymbolLogic; an enum's underlying value). Default = identity PK.
    identity?: boolean;
}

export interface EntityInfo {
    kind: EntityKind;
    data?: EntityData;
    lowPopulation?: boolean;
    identity?: boolean;
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

// The shared body of @entity and @part. Like @reflect it creates reflection metadata and registers the
// type (so the quote-transformer auto-injects @field on its properties); additionally it records the
// EntityKind / EntityData / lowPopulation.
function defineEntity(kind: EntityKind, data: EntityData | undefined, options: EntityOptions | undefined): (target: Function) => void {
    return function (target: Function): void {
        (target as any)[entityInfoKey] = { kind, data, lowPopulation: options?.lowPopulation, identity: options?.identity } satisfies EntityInfo;
        const ti = getOrCreateTypeInfo(target);
        ti.entityKind = kind;
        ti.entityData = data;
        ti.lowPopulation = options?.lowPopulation;
        ti.identity = options?.identity;
        registerType(target);
    };
}

// Marks a class as a persistent entity. `kind` and `data` are both MANDATORY — the abstract base Entity
// uses @reflect (not @entity), so there is no no-arg form. "Part" is not one of the kinds it takes: a part
// is declared `@part`, which is the only way to say it (see below).
export function entity(kind: Exclude<EntityKind, "Part">, data: EntityData, options?: EntityOptions): (target: Function) => void {
    return defineEntity(kind, data, options);
}

/**
 * A `@part` ROW — the entity kind altea reaches for wherever Signum writes an `MList<T>` or an owned
 * `EmbeddedEntity` with a table of its own, and by far the most-declared kind in the workspace (120 of the
 * 124 classes that name one). A part is a KIND of declaration, not a configuration of a general one, and
 * the whole codebase already talks about "a `@part` row" — so the name in the comments is the name in the
 * code, and `@entity("Part")` is gone rather than left beside it: one home per thing, and two spellings of
 * a declaration is exactly the kind of drift the rest of this file is written to avoid.
 *
 * It takes NO EntityData, where every other kind must be given one. A part is reached and saved through
 * the entity that owns it, so its data is the OWNER's by construction — `SchemaBuilder.include` passes it
 * down (transitively, through a chain of parts), which is Signum's own rule for an MList table. Sixty of
 * these used to restate it, and restating a value that is derived is how the two drift: change the owner
 * and the row keeps whatever it was written with, silently. The one shape the decorator has left is the
 * one that is always right.
 *
 * `@part` bare, then — and `@part` with parentheses is a compile error, not a second form. The
 * quote-transformer recognises the name, so a `@part` class gets its `@field` injection exactly as an
 * `@entity` one does.
 */
export function part(target: Function): void {
    defineEntity("Part", undefined, undefined)(target);
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

// Signum's [TicksColumn(...)] — whether this type's table carries a concurrency stamp.
//
// A Ticks column is what makes a save refuse to overwrite a row someone else changed, and it earns that
// column only where a row is edited by PEOPLE, one at a time. So the DEFAULTS are:
//
//   @part           →  NO ticks. A part row is reached and saved through its owner, whose own stamp
//                       guards the aggregate; it is never edited on its own. (Signum's MList table — what
//                       a @part row usually stands in for — has none either, for the same reason.)
//   everything else  →  ticks, unless a SEEDED table (symbols, enum tables) or marked below.
//
// The decorator overrides either default in either direction:
//   @ticksColumn(false)  logs and engine-written rows: ExceptionEntity, OperationLogEntity, ProcessEntity,
//                        PackageLineEntity, the migration rows, SemiSymbol.
//   @ticksColumn(true)   a `@part` that IS edited on its own — Signum models it as a real entity with its
//                        own table (a dashboard part's content, an email service, a scheduler rule, a
//                        virtual-MList child), so it keeps a stamp.
//
// It is INHERITED, unlike every other class-level flag here (see getOrCreateTypeInfo): it says what KIND
// of table this is, which is true of every subclass — one declaration on SemiSymbol reaches every note
// type, alert type and agent, exactly as Signum's inherited attribute does.
export function ticksColumn(enabled: boolean) {
    return function (target: Function): void {
        getOrCreateTypeInfo(target).ticksColumn = enabled;
    };
}

// The name SIGNUM gave this type's table, for a database generated by a Signum application
// (SchemaSettings.legacyMode). Ignored entirely when legacyMode is off, so it never affects an altea-native
// database — unlike @tableName, which is unconditional.
//
// An OVERRIDE, like `@legacyCleanName`: a type that declares `@legacyClassName` already derives its
// Signum table name from it (WordTemplateEntity → WordTemplate → word_template), and needs this only for
// the `wasVirtualMList` half below, or where the derived name is not what Signum calls the table.
//
// It exists because ONE altea shape covers TWO of Signum's. A `@part` row stands in both for an MList of
// EmbeddedEntity — whose table Signum names `<ownerTable>_<CollectionProperty>` — and for a VIRTUAL MList,
// whose element is a standalone Entity that Signum names after the entity. legacyMode derives the first
// (legacyCollectionTableName); the second cannot be derived, and altea's own type NAME does not tell them
// apart in either direction: RuleTypeConditionEntity keeps Signum's standalone name while
// DashboardEntity_TokenEquivalenceGroup was composed off its owner, and both are virtual MLists — while
// OrderLineEntity has a standalone name for what Signum modelled as a plain MList (order_details). So the
// mapping is HISTORY, not convention, and history has to be written down.
//
// Give it the LOGICAL name (`"RuleTypeCondition"`), not the physical one: it is dialect-mapped exactly as a
// derived name is, so it reads `rule_type_condition` on Postgres and `RuleTypeCondition` on SQL Server.
// The two forms answer the two different questions legacyMode cannot derive, so they say which one they
// are answering:
//
//   @legacyTableName("WordTemplate")             — Signum CALLS this table something else. A rename the
//                                                  model does not record (Signum.Word became
//                                                  altea-office-template, so office_template is Signum's
//                                                  word_template).
//   @legacyTableName({ wasVirtualMList: true })  — Signum has NO MList table for this collection. Its
//                                                  element is a standalone Entity wired as a VIRTUAL
//                                                  MList, so the table is named after the ENTITY and the
//                                                  owner-plus-collection rule must stand down. The name
//                                                  itself is the ordinary derived one, so there is
//                                                  nothing to spell out.
//
// Both may be given together for a renamed virtual MList.
export type LegacyTableOptions = {
    /** Signum's name for this table, when it differs from the derived one. */
    name?: string;
    /** Signum modelled this as a standalone Entity behind a virtual MList — see legacyCollectionTableName. */
    wasVirtualMList?: boolean;
};

/**
 * LEGACY MODE: the name of the C# CLASS Signum has for a type altea renamed — the ROOT of the three
 * `@legacy*` names, and usually the only one worth writing.
 *
 * Signum stores it: `TypeEntity` carries `className` beside `cleanName`, and a Signum application
 * pointed at the same database keeps synchronizing that column back to its own answer. An altea
 * application that renamed the type has to be able to say what Signum calls it, or the two fight over
 * the row.
 *
 * Everything else FOLLOWS by the ordinary rules — the clean name is the class name without its kind
 * suffix, the table name is that, dialect-mapped:
 *
 *   `@legacyClassName("WordTemplateEntity")`  → clean name `WordTemplate`, table `word_template`
 *
 * so `@legacyCleanName` / `@legacyTableName` are only for the type whose Signum names do NOT follow
 * that chain. Every one of the three is read ONLY while legacy mode is on (SchemaSettings.legacyMode):
 * an altea-native database gets altea's own names throughout.
 *
 * A DECORATOR rather than a call an app makes at startup, and the same on both tiers: what Signum calls
 * a type is the MODULE's knowledge, where the database came from is the app's.
 */
export function legacyClassName(className: string) {
    return function (target: Function): void {
        declareLegacyClassName(target, className);
    };
}

/**
 * LEGACY MODE: the CLEAN NAME Signum gives this type — an OVERRIDE of what `@legacyClassName` implies,
 * for the type whose two Signum names do not follow the ordinary suffix rule.
 *
 * A clean name is identity in five places: `basics.type.clean_name`, the registered QUERY's key, the
 * `$type` wire discriminator, a lite's key, and an @implementedBy column's suffix — so it is worth being
 * able to state outright. With a `@legacyClassName` present and the ordinary rule landing on the right
 * answer, do not write this.
 */
export function legacyCleanName(cleanName: string) {
    return function (target: Function): void {
        declareLegacyCleanName(target, cleanName);
    };
}

export function legacyTableName(name: string): (target: Function) => void;
export function legacyTableName(options: LegacyTableOptions): (target: Function) => void;
export function legacyTableName(arg: string | LegacyTableOptions) {
    const options: LegacyTableOptions = typeof arg === 'string' ? { name: arg } : arg;
    return function (target: Function): void {
        const ti = getOrCreateTypeInfo(target);
        if (options.name != null) ti.legacyTableName = options.name;
        if (options.wasVirtualMList) ti.legacyWasVirtualMList = true;
    };
}

/**
 * LEGACY MODE: the name SIGNUM gives this field's column, for a field altea models differently but which
 * occupies the SAME column — the field-level sibling of {@link legacyTableName}, and the seam that lets a
 * model difference stay a model difference instead of being reshaped to match a column name.
 *
 * `RuleOperationEntity` is the case it was written for: Signum keys an operation rule by an embedded PAIR
 * (`OperationTypeEmbedded Resource`), so its columns are `ResourceOperationID` / `ResourceTypeID`; altea
 * keeps two direct FK fields, which is simpler everywhere the rule is read and indexed, and differs from
 * Signum only in what the columns are called.
 *
 * Write the WHOLE logical name, `ID` suffix included (`"ResourceOperationID"`) — what Signum calls the
 * column is the whole name, not a stem to compose on. It is still mapped to the dialect by
 * `SchemaBuilder.idiomatic`, so one declaration is right on both (`resource_operation_id` on Postgres,
 * `ResourceOperationID` on SQL Server) where a verbatim name could only ever be right on one. Ignored
 * entirely when legacy mode is off, and a hand-picked `@column({ columnName })` still wins.
 *
 * Only for a field owning exactly ONE column — a value, a reference or an enum. An embedded's name is a
 * PREFIX, and a polymorphic reference owns one column per implementation.
 */
export function legacyColumnName(name: string) {
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).legacyColumnName = name;
    };
}

// declaring ctor → member name → the Signum spelling, or undefined for "derive it from the member".
const legacyRouteMembers = new Map<Function, Map<string, string | undefined>>();

/**
 * `@legacyPropertyRoute` — the third member of the `@legacyTableName` / `@legacyColumnName` family, and
 * the one about a ROUTE rather than a physical name: this METHOD was ported from a C# **property**, so a
 * Signum database has a `basics.property_route` row for it and a legacy sync must not remove that row.
 *
 * It is needed because Signum's `GenerateRoutes` walks `PublicInstancePropertiesInOrder` — a computed
 * property (`[AutoExpressionField] public decimal ValueInStock => …`) is an ordinary route with an
 * ordinary row — while altea's entity model has no property getters, so the same member is a method and
 * route generation walks reflected FIELDS. The route is therefore invisible, and the synchronizer offers
 * the stored row as a rename of whatever sorts nearest and then DROPS it, taking every consumer row with
 * it (a real `auth.rule_property` sits on `Product.ValueInStock`).
 *
 * **Declared, never derived.** Whether the C# original was a property or an EXTENSION METHOD is a fact
 * about the port that only the person doing it knows — Signum has no route for an extension method
 * (altea-tree's `descendants`, altea-printing's `lines`, `entityNotes`), and inferring it from the shape
 * of the TypeScript would be guessing at the C# from its translation. So a member that needs a route says
 * so, and one that says nothing gets nothing.
 *
 * Read only in LEGACY mode (`PropertyRouteLogic.extraSyncRoutes`): in normal mode the database is one
 * altea generated, so it holds no such row. Nothing else consults it — the member is still not a
 * `PropertyRoute`, so it is absent from the property-auth grid and a rule on it gates nothing here.
 *
 *   `@legacyPropertyRoute @quoted valueInStock(): Decimal { … }`   → the route `ValueInStock`
 *   `@legacyPropertyRoute("Duration") @quoted durationSeconds()`   → Signum named the property Duration
 *
 * The bare form derives the path from the member (PascalCased like any other route); the argument form is
 * VERBATIM, for the cases where altea deliberately renamed the member and only the database still cares
 * what Signum called it. Applicable to any method, `@quoted` or not — what it records is the C# original.
 */
export function legacyPropertyRoute(target: object, propertyKey: string | symbol, descriptor?: PropertyDescriptor): void;
export function legacyPropertyRoute(signumName: string): (target: object, propertyKey: string | symbol, descriptor?: PropertyDescriptor) => void;
export function legacyPropertyRoute(arg1: unknown, arg2?: unknown): unknown {
    if (arg2 !== undefined) {  // bare: applied straight as a decorator
        addLegacyRouteMember(arg1 as object, String(arg2), undefined);
        return;
    }
    const signumName = arg1 as string;
    return function (target: object, propertyKey: string | symbol): void {
        addLegacyRouteMember(target, String(propertyKey), signumName);
    };
}

function addLegacyRouteMember(target: object, member: string, signumName: string | undefined): void {
    const ctor = ctorOf(target);
    let members = legacyRouteMembers.get(ctor);
    if (members == undefined)
        legacyRouteMembers.set(ctor, members = new Map());
    members.set(member, signumName);
}

/**
 * Every member of `ctor` (its own and its bases') declared `@legacyPropertyRoute`, as member name → the
 * Signum spelling or undefined for "derive it". Inherited, because Signum generates a route on each
 * CONCRETE root type — a property on an abstract base is a route of every type that derives from it — and
 * a subclass's declaration wins.
 */
export function legacyPropertyRoutesOf(ctor: Function): Map<string, string | undefined> {
    const result = new Map<string, string | undefined>();
    for (let c: Function | null = ctor; c != null; c = Object.getPrototypeOf(c) as Function | null)
        for (const [member, signumName] of legacyRouteMembers.get(c) ?? [])
            if (!result.has(member))
                result.set(member, signumName);
    return result;
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

// @decimalsValidator(4) — Signum's [DecimalsValidator]: at most n decimal places, and the source of the
// column's SCALE and the display FORMAT (see validators.ts). Re-exported here so an entity author reaches
// it beside @format / @unit / @column, the three things it replaces.
export { decimalsValidator } from './validators';

// @unit("€") / @unit("Kg") — the unit symbol shown read-only beside the value.
export function unit(unitName: string) {
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).unit = unitName;
    };
}

/**
 * `@isReadOnly` — this member cannot be edited. Applies at TWO levels, and the same decorator writes
 * both, dispatching on where it was put:
 *
 *   // on a FIELD: about this member alone
 *   @isReadOnly(true)                                          orderDate: Temporal.PlainDate;
 *   @isReadOnly<OrderEntity>(o => o.state === OrderState.New)   shipName: string | null;
 *
 *   // on a CLASS: about every member at once
 *   @isReadOnly<OrderEntity>(o => o.state !== OrderState.New ? true : undefined)
 *   export class OrderEntity extends Entity { … }
 *
 * The field level is asked first and `undefined` defers, so the two compose without either needing a
 * handle on the other — that is what replaces Signum's `super.IsPropertyReadonly(pi)`. The full order is
 * in `FieldInfo.isReadOnlyFor`.
 *
 * WRITE THE TYPE ARGUMENT. It is what types `entity` and narrows `fi.name` to the type's members
 * ({@link MemberOf}), so naming a member that does not exist is a compile error; there is no default, so
 * forgetting it makes the body fail to compile rather than silently checking nothing. A class-level rule
 * that has to NAME a member is usually one that belongs on the field — moving it there needs no name at
 * all.
 *
 * One decorator covers both of the things Signum keeps apart at the field level — a static
 * `MemberInfo.isReadOnly` boolean and the per-property `PropertyValidator.IsReadonly` predicate — because
 * every reader asks the same question through the same resolver.
 *
 * Applies to the LINE (and everything under it — a read-only collection makes its whole EntityTable
 * read-only) and to the serializer's write gate. It is not authorization: property AUTH is per ROLE and
 * lives in altea-auth.
 */
export function isReadOnly<T>(value: boolean | ((entity: T, fi: FieldInfoOf<T>) => boolean | undefined)) {
    return function (target: object, propertyKey?: string | symbol): void {
        const rule = value as boolean | ReadOnlyRule;

        // No propertyKey ⇒ a CLASS decorator (legacy decorators hand a field one the prototype plus the
        // key, and a class one just the constructor).
        if (propertyKey == null) {
            const typeInfo = getOrCreateTypeInfo(target);
            (typeInfo.isReadOnly ??= []).push(rule);
            return;
        }

        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).isReadOnly = rule;
    };
}

// @translatable / @translatable("Html") / @translatable(false) — Signum's [Translatable]: this string
// field carries a PER-INSTANCE translation, edited through @altea/altea-translations' instance pages and
// resolved at read time for the current UI culture. The bare form is plain text; "Html" gets the rich
// editor. Passing FALSE on an embedded field switches translation off for that route and every route
// below it, which is how Signum lets an owner opt a whole sub-tree out.
//
// The marker lives on the compile-time FieldInfo (both tiers), so the client Lines layer can render the
// translate button without any per-request metadata — see FieldInfo.translatable.
export function translatable(target: object, propertyKey: string | symbol): void;
export function translatable(routeType: TranslatableRouteType | false): (target: object, propertyKey: string | symbol) => void;
export function translatable(arg1: unknown, arg2?: string | symbol): unknown {
    if (arg2 !== undefined) {
        getOrCreateFieldInfo(getOrCreateTypeInfo(arg1 as object), String(arg2)).translatable = "Text";
        return;
    }
    const routeType = arg1 as TranslatableRouteType | false;
    return function (target: object, propertyKey: string | symbol): void {
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).translatable = routeType;
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

        // `columnName` is left UNSET when the caller gave none. Defaulting it to the raw property key here
        // looked harmless but silently bypassed the naming convention: SchemaBuilder.columnName falls back to
        // `cap(fi.name)`, so a field carrying any `@column({...})` option got a camelCase column while its
        // undecorated siblings got PascalCase (`exceptionType` beside `ExceptionMessage` on ExceptionEntity).
        // Only SQL Server showed it — Postgres snake_cases both spellings to the same name.
        existing.columnOptions = { ...options };
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

// Signum's [ForceNotNullable] — the exact inverse: the column is generated NOT NULL even though the
// field's type is nullable. For a value the model has no sensible EMPTY for but that is always set by
// the time a row exists: an exception's `exceptionType` is `string | null` because the object is built
// up in pieces, yet no stored exception has none. The stricter column is then a real guarantee for
// every reader, and it is what a Signum database has (`basics.exception.exception_type`,
// `help.type_help_properties.description`).
//
// A field that is nullable in BOTH is just nullable, and one non-null in both just non-null; these two
// decorators exist only for the cases where the model and the column disagree on purpose.
export function forceNotNullable(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).forceNotNullable = true;
}

// Marks the field holding the ELEMENT VALUE of an MList row — the whole of what Signum's `MList<T>` held,
// whether that is a scalar, a reference (`@valueField colaborator: Lite<ArtistEntity>`) or an EMBEDDED
// (`@valueField element: ChartColumnEmbedded`). Mark it only when the field IS the element: a row that
// flattens a RICHER embedded's members (EmailAttachmentEmbedded's `file` + its siblings) has no single
// element field, and neither does one Signum models as an entity.
//
// In legacy mode this is what names the column, because an MList element has no property in Signum: the
// column is named from the element TYPE for a reference/enum, and an embedded's members are inlined with
// NO prefix at all — `file_name`, not altea's `element_file_name`. The embedded case used to be excluded
// here while legacyMListColumnBase already handled it, so that branch was unreachable.
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

// Runtime override of a reference field's @implementedBy (Signum's OverrideAttributes / [ImplementedBy]
// override). Re-points a field's implementations from another module — e.g. a core entity declares
// `@implementedBy(() => [])` (no concrete types, so it needn't reference the app), and the app overrides
// it here. MUST run in an EntityOverrides.start() (on BOTH tiers) before any (de)serialization or schema
// build.
//
// The field is named by a SELECTOR, as Signum names it with an `Expression<Func<T, X>>`: it is checked by
// the compiler, it follows a rename, and it reads like the model rather than like a string key. The lambda
// must be written INLINE at the call (that is where the transformer stamps its AST) and read exactly one
// member of the parameter — an @implementedBy field is a column on THIS type, so there is no path to walk.
export function overrideImplementedBy<T extends Entity>(type: Type<T>, selector: Quoted<(entity: T) => unknown>, types: () => Type<Entity>[]): void {
    const field = memberPath(selector);
    if (field.includes("."))
        throw new Error(`overrideImplementedBy(${(type as { name?: string }).name}, ...): the selector must read a member of the type itself, not a path through it (got "${field}").`);
    getOrCreateFieldInfo(getOrCreateTypeInfo(type), field).implementations = { kind: 'implementedBy', types };
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
// inside `AlbumEntity_Song`. The owner declares the collection as a plain
// `AlbumEntity_Song[]` field (the transformer's `type` thunk supplies the child ctor);
// the SchemaBuilder finds this marked field as the back-pointing FK, so the relationship
// is described from both sides without repeating the property name.
export function backReference(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).isBackReference = true;
}

/**
 * `@bindParent` — Signum's `[BindParent]`: the modifiable(s) this field holds belong to this entity, so
 * they get a back-pointer to it (`tryGetParentEntity` / `getParentEntity`, see data/parentEntity). Put it
 * on an embedded, a `@part` row reference, or a collection of either.
 *
 * What it is FOR is a rule that lives on the child and reads the owner — the `@validate` on
 * `OrderLineEntity.discount` that has to know whether the ORDER is legacy, an `EvalEmbedded` compiling
 * against the entity that carries it. It is not a substitute for a `@part` row's `@backReference` and vice
 * versa: the back reference is a `Lite` the SAVE cascade fills, so it is empty exactly when a rule needs
 * it (while the graph is being edited, and while the owner may still be new).
 *
 * EXPLICIT, as in Signum. Binding every reachable modifiable would work, but the marker is also the
 * documentation — "this member's value is mine" — and it keeps the walk to the fields that meant it.
 */
export function bindParent(target: object, propertyKey: string | symbol): void {
    getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).bindParent = true;
}
