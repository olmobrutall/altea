import type { BaseEntity, Entity, Type, View, ViewType } from "./entity";
// Leaf module: the runtime registries (type / enum / object) plus the FileInfo
// shape. It imports nothing at runtime, so it can be re-exported from BOTH
// reflection.ts and utils/localization.ts without an import cycle (reflection
// imports localization for DescriptionManager, so these registries can't live in
// either of those two modules).

// The npm package + relative source file a type/enum/object was defined in (the
// TS analogue of a .NET assembly + file). The quote-transformer emits one plain
// object literal per file — `const __fileInfo = { module, fileName }` — and
// passes it as the last argument to the register* calls; nothing imports this
// type at runtime, it only describes the literal's shape.
export interface FileInfo {
    packageName: string; // owning npm package name, e.g. "@altea/altea-cache"
    fileName: string;    // path relative to that package, e.g. "entities/music.ts"
}

// Type registry: maps a type's name to its runtime constructor. Populated at
// class-definition time by @reflect / @entity, so the schema builder can resolve
// a field's `typeName` (e.g. "CustomerEntity") back to its constructor for
// classification (entity / embedded) and recursion. Value types (String, Number,
// Date, Decimal, Temporal.*) are intentionally absent — they resolve by name in
// defaultDbType.
const typeRegistry = new Map<string, Type<BaseEntity> | ViewType<View>>();

// Enum registry: maps an enum's name to its runtime enum object. Enums have no
// constructor to hang metadata on, so they are registered explicitly via
// registerEnum. Consumed by the enum-table support.
const enumRegistry = new Map<string, object>();

// Reverse of enumRegistry: the registered name of an enum object. Lets the
// EnumEntity(enumObject) factory name the synthesized entity/table after the enum.
// clean name -> ctor. A SECOND index rather than an alias in typeRegistry, because the clean name is a
// per-SEGMENT strip (`EmployeeEntity_Territory` -> `Employee_Territory`) and so cannot be reversed by
// re-adding a suffix. Where two types clean to the same name the higher-priority SUFFIX wins, which
// makes the answer independent of module evaluation order — the alias this replaces was first-come,
// so `Customer` belonged to whichever of CustomerEntity / CustomerRowModel happened to load first.
const cleanRegistry = new Map<string, Type<BaseEntity> | ViewType<View>>();

// What SIGNUM calls a type this framework renamed — the attribute stores behind the three `@legacy*`
// name decorators, written once at CLASS DEFINITION time and read only while LEGACY MODE is on.
//
// `@legacyClassName` is the one that matters: a class name is what Signum's `TypeEntity.className`
// column holds, so two applications sharing one database — a Signum one and an altea one — disagree
// about that column unless the altea side can say "Signum calls this class WordTemplateEntity". The
// other two are DERIVED from it by the ordinary rules (strip the kind suffix for the clean name, snake
// it for the table), and are declared only where those rules do not land on Signum's answer.
const legacyClassNames = new Map<Type<BaseEntity> | ViewType<View>, string>();
const legacyCleanNames = new Map<Type<BaseEntity> | ViewType<View>, string>();

// Whether the `@legacy*` NAMES apply — the data-layer half of SchemaSettings.legacyMode, which is what
// sets it (and an application's shared entity-overrides module on the CLIENT, which has no schema).
//
// It has to be a runtime flag rather than a decorator-time fact: the same class must be able to say
// "Signum calls me WordTemplateEntity" AND keep altea's own name in an altea-native database. Nothing
// may read a name before it is set — which is why the setter RE-KEYS what is already registered, and
// why an application sets it first thing on both tiers.
let legacyNames = false;

// Which suffix outranks which, when two types share a clean name. A row model beats an entity because
// the only entity it can legitimately collide with is an ABSTRACT one, whose clean name is inert: never
// a `$type` (that is the RUNTIME constructor), never a `basics.type` row (no table), never an
// @implementedBy suffix (those are the concrete implementations). A CONCRETE entity colliding with a row
// model is a modelling error, and SchemaBuilder.complete refuses it rather than ranking it.
function cleanPriority(name: string): number {
    return name.endsWith("RowModel") ? 3 : name.endsWith("Entity") ? 2 : name.endsWith("Symbol") ? 1 : 0;
}

const enumNameRegistry = new WeakMap<object, string>();

// Object registry: named runtime objects (e.g. message containers transformed by
// msg(), and later operation/symbol containers).
const objectRegistry = new Map<string, object>();

// name -> file info, uniform across types, enums and objects.
const locationRegistry = new Map<string, FileInfo>();

// `name` and `fileInfo` are supplied by the quote-transformer (a literal name +
// the per-file __fileInfo object) so registration survives bundling: bundlers can
// strip the `var X = class {}` binding that gives an anonymous class its `.name`,
// leaving ctor.name === "" and breaking name-based resolution. Falls back to
// ctor.name when called directly (e.g. from @reflect at decoration time).
export function registerType(ctor: Type<BaseEntity> | ViewType<View>, name?: string, fileInfo?: FileInfo): void {
    const key = name ?? ctor?.name;
    if (!key) return;
    // Restore ctor.name when the bundler stripped it (anonymous class → name
    // === ""). The class `.name` property is configurable, so redefining it is
    // safe — and fixes *every* consumer that reads it (table/column naming,
    // cleanTypeName, diagnostics), not just the registry below.
    if (name != null && ctor.name !== name) {
        try {
            Object.defineProperty(ctor, "name", { value: name, configurable: true });
        } catch {
            // Some exotic runtimes make .name non-configurable; the registry
            // entry below still keeps name-based resolution working.
        }
    }
    // typeRegistry is keyed by the COMPLETE name alone; the clean name lives in its own index, ranked
    // rather than first-come (see cleanRegistry).
    typeRegistry.set(key, ctor);
    // Under the name `cleanTypeName` will answer with, which in legacy mode is the declared / derived
    // Signum one — decorators evaluate bottom-up, so the two may run in either order and neither may win
    // by accident. A type registered BEFORE legacy mode is turned on is re-keyed by `setLegacyMode`.
    const clean = legacyCleanNameOf(ctor) ?? stripEntitySuffix(key);
    if (clean !== key) {
        const held = cleanRegistry.get(clean);
        if (held == null || cleanPriority(key) > cleanPriority(held.name))
            cleanRegistry.set(clean, ctor);
    }
    if (fileInfo != null) locationRegistry.set(key, fileInfo);
}

// Every constructor registered via registerType. Keyed by the COMPLETE name alone, so the values need
// no dedupe. Used by ReflectionClient to propagate an abstract base type's operations to its concrete
// subclasses, since altea gives every class its own TypeInfo (operations don't inherit).
export function getRegisteredTypes(): (Type<BaseEntity> | ViewType<View>)[] {
    return [...new Set(typeRegistry.values())];
}

/**
 * A clean name back to its constructor — the reverse of {@link cleanTypeName}, read out of the ranked
 * {@link cleanRegistry} rather than derived, since the strip is per underscore-SEGMENT
 * (`EmployeeEntity_Territory` -> `Employee_Territory`) and re-adding a suffix cannot undo that.
 */
function resolveBySuffix(name: string): Type<BaseEntity> | ViewType<View> | undefined {
    // The COMPLETE name first, so a type literally called `QueryModel` is never shadowed by another
    // type's clean name.
    return typeRegistry.get(name) ?? cleanRegistry.get(name);
}

export function resolveType(name: string): Type<BaseEntity> | ViewType<View> | undefined {
    // The canonical (PascalCase) names — the full name, and every clean name through resolveBySuffix.
    // The firstLower fallback resolves names that come from URLs, where navigateRouteDefault lower-cases
    // the first letter (`/view/order/1` → "order" → "Order"); PascalCase names never reach it.
    return resolveBySuffix(name)
        ?? (name.length > 0 ? resolveBySuffix(name[0].toUpperCase() + name.slice(1)) : undefined);
}

// The "clean" type name: the constructor name with a trailing "Entity" stripped
// (e.g. BandEntity -> "Band"). It is the reflection IDENTITY, and it is what
//   - the JSON wire discriminator carries (`$type` / `$lite`, see data/serializer),
//   - TypeEntity.cleanName stores (`resolveCleanType` reads it back),
//   - an @implementedBy field's per-implementation COLUMN NAME is suffixed with
//     ("ownerID_Band" — the schema builder keeps its own copy of this rule).
// NOT the stored @implementedByAll discriminator: that column holds the target's
// TypeEntity int id (server/schema/column.ts's ImplementedByAllTypeColumn), which
// is then resolved through TypeLogic — the clean name only reaches it as the
// TypeEntity ROW's cleanName.
//
// Signum's Reflector.CleanTypeName also strips Embedded / Model / Symbol; here those
// suffixes STAY, because an identity must keep "SongEmbedded" distinct from a "Song"
// beside it. Localization's niceNameFromTypeName strips all four (and RowModel), but only for DISPLAY.
export function cleanTypeName(ctor: Type<BaseEntity> | ViewType<View>): string {
    // LEGACY MODE: SIGNUM's own clean name for this type, when altea renamed it — declared outright with
    // `@legacyCleanName`, or derived from `@legacyClassName` by the same suffix rule as any other name.
    const legacy = legacyCleanNameOf(ctor);
    if (legacy != null)
        return legacy;

    // A closed EnumEntity<E> type (EnumEntity.typeFor) carries the enum as a static `boundEnum`; its clean
    // name comes from the ENUM name ("OrderState"), NOT the "EnumEntity<OrderState>" ctor name — mirrors
    // Signum's `EnumEntity.Extract(tab.Type) ?? tab.Type` (TypeLogic.GenerateSchemaTypes), and is what the
    // TypeEntity.cleanName column + enum ColorPalettes key on. The SUFFIX is stripped from it as from any
    // other name, because Signum runs the extracted enum type through the same Reflector.CleanTypeName:
    // its `enum DashboardEmbedededInEntity` is the type it calls `DashboardEmbedededIn`, with
    // `class_name = 'DashboardEmbedededInEntity'` beside it.
    const boundEnum = (ctor as { boundEnum?: object }).boundEnum;
    if (boundEnum != null) {
        const enumName = enumNameOf(boundEnum);
        if (enumName != null)
            return stripEntitySuffix(enumName);
    }
    return stripEntitySuffix(ctor.name);
}

// Strip the "Entity" / "Symbol" suffix from each underscore-separated segment (mirrors the schema
// builder's table naming). A plain entity: "BandEntity" -> "Band". A symbol: "TypeConditionSymbol" ->
// "TypeCondition". A PART entity (altea's MList replacement, named `<Owner>Entity_<Field>`):
// "RuleTypeConditionEntity_Condition" -> "RuleTypeCondition_Condition", "EmployeeEntity_Territory" ->
// "Employee_Territory". Per-segment so the OWNER's suffix is stripped too, not just a trailing one (the
// previous trailing-only strip left the part's owner segment mangled, disagreeing with the schema
// builder's own cleanTypeName).
//
// Signum's Reflector.CleanTypeName strips FOUR suffixes — Entity, Embedded, Model and Symbol — and altea
// takes Entity, Symbol and RowModel. A clean name is IDENTITY: the `TypeEntity.cleanName` column, the
// `$type` / `$lite` wire discriminator, an @implementedBy column's suffix, a registered QUERY's key and
// the type segment of a URL (`/view/Workflow/3`).
//
// `Model` and `Embedded` are NOT stripped, and the reason is that altea carries a Model beside its
// Entity far more often than Signum does: stripping them makes 10 pairs ambiguous — Customer, Query and
// eight workflow node/model pairs (WorkflowEntity/WorkflowModel, WorkflowActivityEntity/…Model, …).
// Signum survives the same pairs because its clean name is used for DESCRIPTIONS while a Model's runtime
// identity stays the full class name (its generated `new Type<WorkflowActivityModel>("WorkflowActivityModel")`
// beside `new Type<WorkflowActivityEntity>("WorkflowActivity")`), and altea already strips all four (plus
// RowModel) for display in `Localization.Internal.niceNameFromTypeName`.
//
// `RowModel` IS stripped, because it is the one Model whose clean name has to be identity: the row shape
// of a MANUAL query is that query's NAME (altea has no enum-named queries — see data/dynamicQuery/
// queryUtils), so `CustomerRowModel` is the query Signum calls `CustomerQuery.Customer`. It is a marker
// suffix, chosen over `QueryModel` because a type named exactly `QueryModel` already exists (a suffix
// that is also a name has to guard the empty string, as `Symbol` does) and because the type models a
// query's ROW, not a query.
//
// The guard matters for the base class `Symbol` itself, which would otherwise clean to the empty string.
function stripEntitySuffix(name: string): string {
    return name.split('_').map(s => {
        const stripped = s.replace(/(Entity|Symbol|RowModel)$/, '');
        return stripped === '' ? s : stripped;
    }).join('_');
}

// Reverse of cleanTypeName: a wire discriminator back to its constructor — the same derivation
// resolveType uses, without the URL's lower-case tolerance.
export function resolveCleanType(cleanName: string): Type<BaseEntity> | ViewType<View> | undefined {
    return resolveBySuffix(cleanName);
}

/** {@link resolveCleanType}, for a name that must be a modifiable class (entity, embedded, model) — undefined for a view. */
export function resolveModifiableType(cleanName: string): Type<BaseEntity> | undefined {
    const ctor = resolveBySuffix(cleanName);
    return ctor != undefined && isModifiableCtor(ctor) ? ctor : undefined;
}

/** {@link resolveCleanType}, for a name that must be an entity type — undefined for anything else. */
export function resolveEntityType(cleanName: string): Type<Entity> | undefined {
    const ctor = resolveBySuffix(cleanName);
    return ctor != undefined && isEntityType(ctor) ? ctor : undefined;
}

/** Whether a registered type is a modifiable class (entity, embedded, model) rather than a view. */
export function isModifiableType(ctor: Type<BaseEntity> | ViewType<View>): ctor is Type<BaseEntity> {
    return isModifiableCtor(ctor);
}

/** Whether a registered type is an ENTITY (a table row, with an id) — not an embedded, model or view. */
export function isEntityType(ctor: Type<BaseEntity> | ViewType<View>): ctor is Type<Entity> {
    return isModifiableCtor(ctor) && isEntityCtor(ctor);
}

// By prototype NAME chain rather than `instanceof`: this module is imported by ./entity, so it cannot hold
// the classes themselves.
function isModifiableCtor(ctor: Type<BaseEntity> | ViewType<View>): ctor is Type<BaseEntity> {
    return inheritsFromNamed(ctor, "BaseEntity");
}

function isEntityCtor(ctor: Type<BaseEntity>): ctor is Type<Entity> {
    return inheritsFromNamed(ctor, "Entity");
}

function inheritsFromNamed(ctor: Function, baseName: string): boolean {
    for (let c: Function | null = ctor; c != null && c !== Function.prototype; c = Object.getPrototypeOf(c))
        if (c.name === baseName)
            return true;
    return false;
}

// Registers a database enum by name (so the enum-table support can map a field's
// enum type back to its values). The quote-transformer auto-generates the call
// for enums declared in the same file as a referencing entity, and rewrites
// hand-written `registerEnum(MyEnum)` calls (for cross-file enums) to supply the
// name + __fileInfo.
export function registerEnum(enumObject: object, name?: string, fileInfo?: FileInfo): void {
    if (!name) return;
    enumRegistry.set(name, enumObject);
    enumNameRegistry.set(enumObject, name);
    if (fileInfo != null) locationRegistry.set(name, fileInfo);
}

export function resolveEnum(name: string): object | undefined {
    return enumRegistry.get(name);
}

// Every registered enum as [registeredName, enumObject]. Used by the metadata builder to emit one
// TypeMetadata per enum (its member nice names + database ids).
export function getRegisteredEnums(): [string, object][] {
    return [...enumRegistry.entries()];
}

// The registered name of an enum object (reverse of resolveEnum).
export function enumNameOf(enumObject: object): string | undefined {
    return enumNameRegistry.get(enumObject);
}

// Registers a named runtime object (msg() containers, …) with its file info.
export function registerObject(obj: object, name?: string, fileInfo?: FileInfo): void {
    if (!name) return;
    objectRegistry.set(name, obj);
    if (fileInfo != null) locationRegistry.set(name, fileInfo);
}

export function resolveObject(name: string): object | undefined {
    return objectRegistry.get(name);
}

// Every registered named object as [registeredName, object] — the msg() message containers. Used by the
// metadata builder to emit one "Container" TypeMetadata per message container.
export function getRegisteredObjects(): [string, object][] {
    return [...objectRegistry.entries()];
}

// The package + file a registered type / enum / object was defined in, by name.
export function getLocation(name: string): FileInfo | undefined {
    return locationRegistry.get(name);
}

// ---------------------------------------------------------------------------
// Default-language descriptions declared in code (no translation file needed).
//
// Signum derived a member/type's default label from the C# identifier (humanized) and let a
// `[Description("…")]` attribute override it. altea has no attributes, so authors set the DEFAULT
// display name explicitly — the `@niceName` / `@nicePluralName` decorators (entities/decorators) for
// types + entity members, and operation `init({ niceName })` (below) for operation symbols. Enums use
// their own object-keyed store (entities/enum), since an enum object has no registered name at the
// point `Enum.setNiceName` is called.
//
// These are the DEFAULT-language names: DescriptionManager (utils/localization) consults them only
// when no loaded translation covers the key, so a translation file for ANY culture still wins. Kept in
// this import-free leaf so the decorators (via reflection), init() (here), and DescriptionManager
// (localization imports registration) all share ONE store without a cycle. Keyed by the same
// type/container name the translations use; `members` maps member → description (entity fields, enum
// values, operation members).
interface DefaultDescription {
    description?: string;
    pluralDescription?: string;
    gender?: string;
    members: Record<string, string>;
}
const defaultDescriptions = new Map<string, DefaultDescription>();

function orCreateDefaultDescription(name: string): DefaultDescription {
    let d = defaultDescriptions.get(name);
    if (d == null) { d = { members: {} }; defaultDescriptions.set(name, d); }
    return d;
}

// Set a type's default description / plural / gender (the `@niceName` / `@nicePluralName` class
// decorators). Only the provided fields are overwritten, so the two decorators compose on one type.
export function setDefaultTypeDescription(name: string, opts: { description?: string; pluralDescription?: string; gender?: string }): void {
    const d = orCreateDefaultDescription(name);
    if (opts.description != null) d.description = opts.description;
    if (opts.pluralDescription != null) d.pluralDescription = opts.pluralDescription;
    if (opts.gender != null) d.gender = opts.gender;
}

// Set a member's default description (a `@niceName` field decorator or an operation `init({ niceName })`).
export function setDefaultMemberDescription(name: string, member: string, description: string): void {
    orCreateDefaultDescription(name).members[member] = description;
}

// The code-declared defaults for a type/container name, or undefined. Read by DescriptionManager as the
// fallback below any loaded translation.
export function getDefaultDescription(name: string): DefaultDescription | undefined {
    return defaultDescriptions.get(name);
}

// ---------------------------------------------------------------------------
// Package / folder defaults (Signum's assembly-level [DefaultAssemblyCulture] + default schema name).
//
// Written as bare top-level calls — `setDefaultCulture("en")`, `setDefaultDatabaseSchema("dbo")` — that
// the quote-transformer augments with the per-file `__fileInfo` (exactly as it does for msg() / init()),
// so each call knows the package + source path it was written in WITHOUT the author repeating them:
//   setDefaultCulture("en");            →  setDefaultCulture("en", __fileInfo);
//   setDefaultDatabaseSchema("dbo");    →  setDefaultDatabaseSchema("dbo", __fileInfo);
//
// Kept in this import-free leaf so both the localization layer and the schema layer can resolve a type's
// defaults through its FileInfo (locationRegistry) without an import cycle.

// The directory a source path lives in, with a trailing "/", or "" for a package-root file. fileName is
// always forward-slashed (the transformer normalizes it), so splitting on "/" alone is safe.
function dirName(fileName: string): string {
    const i = fileName.lastIndexOf("/");
    return i < 0 ? "" : fileName.slice(0, i + 1);
}

// --- Default culture (per package) ---------------------------------------------------------------
// The language a package's code-declared strings (@niceName / @nicePluralName / @gender / operation
// init({ niceName }) and the humanized member names) are written in — the source culture for translation
// export/sync, and what an app boot can seed the process UI culture from. Culture is a whole-package
// trait (not folder-scoped), so it keys on packageName; an unresolvable location registers under "" as a
// process-wide fallback.
const packageCultures = new Map<string, string>();

export function setDefaultCulture(culture: string, fileInfo?: FileInfo): void {
    packageCultures.set(fileInfo?.packageName ?? "", culture);
}

// The default culture declared for a package (falling back to the process-wide "" default), or undefined.
export function getPackageCulture(packageName: string): string | undefined {
    return packageCultures.get(packageName) ?? packageCultures.get("");
}

// The default culture that applies to a registered type/enum/symbol NAME, via its owning package.
export function cultureForName(name: string): string | undefined {
    return getPackageCulture(locationRegistry.get(name)?.packageName ?? "");
}

// --- Default DB schema (per folder) --------------------------------------------------------------
// Stored as { packageName, dir, schema }.
interface SchemaScope { packageName: string; dir: string; schema: string; }
const schemaScopes: SchemaScope[] = [];

/**
 * The database schema a package's tables live in — altea's counterpart of Signum's
 * `[assembly: AssemblySchemaName("alerts")]`.
 *
 * FOLDER-SCOPED: a declaration covers the directory of the file it is written in and every file below it,
 * and the most specific (longest matching directory) wins — so a sub-folder overrides its package's default
 * without annotating each entity. Placed at the package root it covers the whole package.
 *
 * The name is LOGICAL and gets dialect-mapped (`schemaForType`), so Postgres sees it snaked. Consulted by
 * SchemaBuilder per type; server-only — ignored on the client.
 *
 * Written as a bare top-level call; the quote-transformer supplies `fileInfo`.
 *
 *     setDefaultDatabaseSchema("alerts");
 *
 * For a PER-TYPE override of this folder default, see {@link setDatabaseSchema}.
 */
export function setDefaultDatabaseSchema(schema: string, fileInfo?: FileInfo): void {
    const packageName = fileInfo?.packageName ?? "";
    const dir = fileInfo != null ? dirName(fileInfo.fileName) : "";
    // A second declaration for the same directory replaces the first (also makes re-runs idempotent).
    const existing = schemaScopes.find(s => s.packageName === packageName && s.dir === dir);
    if (existing != null) existing.schema = schema;
    else schemaScopes.push({ packageName, dir, schema });
}

// A PER-TYPE override of that folder default, keyed by registered name.
//
// Signum resolves a schema from the (assembly, NAMESPACE) pair — the Signum core assembly alone declares
// five, one per namespace: `framework`, and `basics` / `entities` / `operations` / `queries` for
// Signum.Basics / .Entities / .Operations / .DynamicQuery. A namespace is a per-DECLARATION grouping that
// altea's per-FOLDER scope cannot always follow, because altea groups its core model by role rather than
// by target schema: all twelve DynamicQuery enums sit in one file beside the `basics` types, and
// PermissionSymbol — Signum.Basics there — is declared inside the auth package that uses it.
//
// So this is the counterpart of Signum's own escape hatch, `AssemblySchemaNameAttribute.OverridenAssembly`,
// which likewise says "resolve this ONE type as though it were declared elsewhere". Written beside the
// declarations it names, so the answer is visible where the types are:
//
//   setDatabaseSchema("basics", PermissionSymbol);
//
// Takes an entity/symbol CONSTRUCTOR or a registered ENUM object (which cannot carry a decorator), and
// must come AFTER that type's `@reflect` / `registerEnum` so the name is resolvable.
const typeSchemas = new Map<string, string>();

export function setDatabaseSchema(schema: string, ...types: (Function | object)[]): void {
    for (const type of types) {
        const name = typeof type === "function" ? type.name : enumNameOf(type);
        if (name == null || name === "")
            throw new Error(`setDatabaseSchema("${schema}"): the type is not registered yet — `
                + `place the call after its @reflect / registerEnum.`);
        typeSchemas.set(name, schema);
    }
}

// The schema that applies to a registered type NAME — a per-type override if one was declared, else the
// longest declared scope whose package matches and whose directory is a prefix of the type's file.
// undefined when nothing covers it (→ the connection default schema). NOTE: for an enum table, callers
// must pass the ENUM's own registered name (not the anonymous EnumEntity.typeFor class name), so the enum
// resolves to the schema of the package it is DEFINED in — not to EnumEntity's own file
// (@altea/altea/data). See SchemaSettings.schemaForType.
export function schemaForName(name: string): string | undefined {
    const own = typeSchemas.get(name);
    if (own != null) return own;
    const loc = locationRegistry.get(name);
    if (loc == null) return undefined;
    let best: SchemaScope | undefined;
    for (const s of schemaScopes) {
        if (s.packageName !== loc.packageName || !loc.fileName.startsWith(s.dir)) continue;
        if (best == null || s.dir.length > best.dir.length) best = s;
    }
    return best?.schema;
}

// ---------------------------------------------------------------------------
// Symbol support (Signum's Symbol / SymbolLogic, client/declaration side).
//
// A "symbol" is a SystemString entity keyed by a unique string (OperationSymbol,
// TypeConditionSymbol, …). Containers are declared as
//   export namespace XOperation { export const Y: ExecuteSymbol<E> = init(); }
// and the quote-transformer rewrites each `init()` into
//   init(OperationSymbol, "XOperation.Y", __fileInfo)
// passing the concrete Symbol CONSTRUCTOR (base-walked from the declared container type
// — the class directly extending `Symbol`) as a value, plus a value import of it. So
// init just `new`s it — no kind string, no ctor registry (this mirrors Signum's AutoInit
// `new OperationSymbol(typeof(Container), field)`). Kept in this import-free leaf so any
// entity file can `init()` without a runtime cycle (as with `msg()`).

/**
 * The attribute store behind `@legacyClassName` — the name of the C# CLASS Signum has for a type this
 * framework renamed (@altea/altea-office-template's Word* -> Office*, @altea/altea-migrations'
 * CSharpMigration -> TypeScriptMigration).
 *
 * It is the ROOT of the three legacy names, because it is the one Signum itself stores: `TypeEntity`
 * carries `className` beside `cleanName`, and a Signum application pointed at the same database keeps
 * synchronizing that column back to its own answer. Declaring it makes both sides agree; the clean name
 * and the table name are then DERIVED from it by the ordinary rules, and only need declaring where those
 * rules do not land on Signum's answer.
 *
 * Read only while legacy mode is on (see {@link setLegacyMode}) — an altea-native database gets altea's
 * own names.
 */
export function declareLegacyClassName(ctor: Type<BaseEntity>, className: string): void {
    legacyClassNames.set(ctor, className);
    indexLegacyAliases(ctor);
}

/** The attribute store behind `@legacyCleanName` — an OVERRIDE, for the rare type whose Signum clean
 *  name does not follow from its Signum class name by the ordinary suffix rule. */
export function declareLegacyCleanName(ctor: Type<BaseEntity>, cleanName: string): void {
    legacyCleanNames.set(ctor, cleanName);
    indexLegacyAliases(ctor);
}

/** SIGNUM's class name for this type, while legacy mode is on. */
export function legacyClassName(ctor: Type<BaseEntity> | ViewType<View>): string | undefined {
    return legacyNames ? legacyClassNames.get(ctor) : undefined;
}

/**
 * SIGNUM's CLEAN name for this type, while legacy mode is on: the one `@legacyCleanName` declared, else
 * the one that follows from `@legacyClassName` by the ordinary suffix rule ("WordTemplateEntity" →
 * "WordTemplate"). Undefined outside legacy mode, and for a type that declared neither.
 *
 * The single resolution both copies of `cleanTypeName` use — this one and the schema builder's, which
 * names tables and @implementedBy columns.
 */
export function legacyCleanNameOf(ctor: Type<BaseEntity> | ViewType<View>): string | undefined {
    if (!legacyNames)
        return undefined;
    const declared = legacyCleanNames.get(ctor);
    if (declared != null)
        return declared;
    const className = legacyClassNames.get(ctor);
    return className != null ? stripEntitySuffix(className) : undefined;
}

/** Whether the `@legacy*` names apply. */
export function isLegacyMode(): boolean {
    return legacyNames;
}

/**
 * Every `@legacyClassName` DECLARED in the process, Signum's name → the altea constructor, whatever mode
 * is on — the static fact of the declaration rather than {@link legacyClassName}'s "which name should
 * this runtime use", which is mode-dependent because a name is what a DATABASE is keyed by.
 *
 * The question the two answers apart is asked off-line, by a tool converting Signum ARTEFACTS to altea
 * ones — @altea/altea-translations' translation port is the first: which altea type is Signum's
 * `WordTemplateEntity` is the same answer whichever database the process happens to point at, and a
 * porting run must not have to flip a global to get it.
 */
export function declaredLegacyClassNames(): Map<string, Type<BaseEntity> | ViewType<View>> {
    return new Map([...legacyClassNames].map(([ctor, className]) => [className, ctor]));
}

/**
 * Turn the `@legacy*` names on or off — `SchemaSettings.legacyMode` on the server, an application's
 * shared entity-overrides module on the client (which has no schema to carry the flag).
 *
 * Types register as their modules are IMPORTED, which happens before an application can say which
 * database it is pointed at, so flipping this re-keys the clean-name index for every type that declared
 * a legacy name. Nothing else caches a clean name: every other consumer asks `cleanTypeName` when it
 * needs one.
 */
export function setLegacyMode(enabled: boolean): void {
    if (legacyNames === enabled)
        return;
    legacyNames = enabled;
    for (const ctor of new Set([...legacyClassNames.keys(), ...legacyCleanNames.keys()]))
        indexLegacyAliases(ctor);
}

/**
 * Index `ctor` under EVERY clean name it can be known by — altea's own, and Signum's.
 *
 * Writing is one name (whatever `cleanTypeName` answers in this mode); READING is tolerant, which is the
 * rule the rest of the model follows: a `$type` on the wire, a `basics.type` row, a stored query key or a
 * user-asset XML exported from the other framework resolves to the same class either way, so nothing
 * stored has to be migrated to be readable. Nothing else can own these names — they are two spellings of
 * one type — and the priority guard below is the same one `registerType` applies.
 */
function indexLegacyAliases(ctor: Type<BaseEntity> | ViewType<View>): void {
    const legacy = legacyCleanNames.get(ctor) ?? legacyClassNameStripped(ctor);
    for (const name of [cleanTypeName(ctor), stripEntitySuffix(ctor.name), legacy]) {
        if (name == null)
            continue;
        const held = cleanRegistry.get(name);
        if (held == null || cleanPriority(ctor.name) > cleanPriority(held.name))
            cleanRegistry.set(name, ctor);
    }
}

function legacyClassNameStripped(ctor: Type<BaseEntity> | ViewType<View>): string | undefined {
    const className = legacyClassNames.get(ctor);
    return className != null ? stripEntitySuffix(className) : undefined;
}

/**
 * Re-key every DECLARED symbol of one container — the symbol-key sibling of `@legacyTableName` /
 * `@legacyColumnName`, and NEW here (Signum needs none: it is the framework being ported from).
 *
 * A symbol's key is `<Container>.<Member>`, stamped by the quote-transformer from the namespace the
 * symbol is declared in, and it is the `key` COLUMN of that symbol's table. So an application ported
 * from a Signum one under a different name declares `EastwindTypeCondition.UserEntities` where the
 * database it is pointed at holds `SouthwindTypeCondition.UserEntities` — a rename the sync offers per
 * symbol, whose wrong answer is a DELETE + INSERT that re-ids the symbol and orphans every rule
 * pointing at it.
 *
 * Called from the app's shared entity-overrides module, so BOTH TIERS agree: the key is model identity,
 * and a client that kept the other spelling could not be handed its id by the metadata blob — every
 * `toLite()` on that symbol would then throw. Which is also why this must run before ANYTHING reads a
 * symbol by key (the schema build, SymbolLogic's caches, the blob); the overrides module is first on
 * both tiers, which is what makes it the right home.
 *
 * The container is passed as the NAMESPACE OBJECT, not as its name: a string would be a second
 * spelling of something the compiler already knows, silently stale after a rename and silently wrong
 * after a typo. Passing the object also means the symbols are found by IDENTITY rather than by a key
 * prefix, so the rename reaches exactly the members that container declares.
 *
 * A MEMBER may be renamed too, through the optional third argument — `Word*` became `Office*` on the
 * members as well as on the container. Its keys are `keyof` the container, so they are checked the
 * same way the container is; a member not named there keeps its own.
 *
 * THROWS when the container held no declared symbol — an empty or wrong object, or a call made before
 * the declaring module was evaluated, are the same silent no-op otherwise.
 */
export function renameSymbolContainer<T extends SymbolContainer>(
    container: T, to: string, members?: Partial<Record<keyof T & string, string>>): void {
    // A SemiSymbol's key is NULLABLE — a row a user created has a name and no key — so a container's
    // value may legitimately have none, and only the keyed ones are renameable.
    const renames = new Map<unknown, string>();
    for (const [name, sym] of Object.entries(container))
        if (sym?.key != null)
            renames.set(sym, members?.[name as keyof T & string] ?? sym.key.slice(sym.key.indexOf(".") + 1));

    let matched = 0;
    for (const byKey of declaredSymbols.values()) {
        for (const [key, sym] of [...byKey]) {
            const member = renames.get(sym);
            if (member == null)
                continue;

            const renamed = to + "." + member;
            byKey.delete(key);
            sym.key = renamed;
            byKey.set(renamed, sym);

            // The location registry is keyed by the symbol key too (it is what groups a symbol by
            // package + folder for the schema map and the translation index).
            const location = locationRegistry.get(key);
            if (location != null) {
                locationRegistry.delete(key);
                locationRegistry.set(renamed, location);
            }
            matched++;
        }
    }

    if (matched === 0)
        throw new Error(`renameSymbolContainer(…, '${to}'): the container declared no symbol.`
            + ` Check that the module declaring it is imported before this runs.`);
}

// The minimal shape init() stamps. Declared locally (not `import { Symbol }`) so the
// leaf stays runtime-import-free — the concrete constructor is passed in by init()'s
// caller, and its Entity machinery is irrelevant to the stamping here.
interface SymbolLike { key: string; isNew: boolean; id?: string | number }
type SymbolCtor = new () => SymbolLike;

/** What {@link renameSymbolContainer} takes: a symbol namespace. A SemiSymbol's key is nullable. */
type SymbolContainer = Record<string, { key: string | null }>;

// ctor → (key → declared symbol instance). Every init() records its symbol here so
// SymbolLogic can enumerate the declared symbols of a type (Signum's getSymbols()).
const declaredSymbols = new Map<SymbolCtor, Map<string, SymbolLike>>();

// Options an author may pass to `init({ … })` — currently just a default-language `niceName`
// (Signum set an operation's label via [Description] on the AutoInit field; altea has no attributes,
// so it rides on init). Consulted by the client Operations layer via DescriptionManager.translate
// unless a translation for the operation is loaded.
export interface InitOptions {
    niceName?: string;
}

// Developer-facing: authors write `= init()` (or `= init({ niceName })`); the quote-transformer
// supplies (SymbolClass, key, fileInfo[, opts]). The developer overloads return the declared symbol
// type S so the const type-checks before transformation (no cast needed).
export function init<S>(): S;
export function init<S>(opts: InitOptions): S;
export function init(ctor: SymbolCtor, key: string, fileInfo?: FileInfo, opts?: InitOptions): SymbolLike;
export function init(ctor?: SymbolCtor | InitOptions, key?: string, fileInfo?: FileInfo, opts?: InitOptions): unknown {
    // The developer forms `init()` / `init({ niceName })` reach here only if the transformer did not
    // run: the augmented form always passes the Symbol CONSTRUCTOR (a function) as the first arg.
    if (typeof ctor !== "function" || key == null)
        throw new Error("init() was not processed by the quote-transformer. Declare the symbol as `export const X: SomeSymbol = init()` inside an `export namespace`, with the transformer enabled for this package.");

    const sym = new ctor();
    sym.key = key;
    sym.isNew = false; // symbols are pre-existing rows; SymbolLogic assigns the id

    // A SemiSymbol also carries a NAME, and for a code-declared one Signum fills it from the field name:
    // `SemiSymbol(declaringType, fieldName)` sets `Key = Type.field` and `Name = field`. Without this the
    // seed INSERT writes a null name — which its own NOT NULL rejects, so a database with a declared
    // SemiSymbol (an alert type, a note type, an agent) could not be generated at all.
    //
    // Detected by the FIELD rather than by the class, so this module keeps importing nothing: a Symbol has
    // no `name`, a SemiSymbol declares one, and the property exists on the instance either way.
    if ("name" in sym && (sym as { name?: string }).name == null)
        (sym as { name?: string }).name = key.slice(key.indexOf(".") + 1);

    let byKey = declaredSymbols.get(ctor);
    if (byKey == null) declaredSymbols.set(ctor, byKey = new Map());
    byKey.set(key, sym);

    if (fileInfo != null) locationRegistry.set(key, fileInfo);

    // A default-language operation label — registered under the container/member split of the key
    // ("OrderOperation.Ship" → container "OrderOperation", member "Ship"), matching how the client
    // Operations layer resolves an operation's niceName (ReflectionClient) and how a translation file
    // keys it — so a loaded translation overrides it.
    if (opts?.niceName != null) {
        const dot = key.indexOf(".");
        if (dot >= 0) setDefaultMemberDescription(key.slice(0, dot), key.slice(dot + 1), opts.niceName);
    }

    return sym;
}

// All declared symbols of a concrete Symbol type (Signum's getSymbols()); consumed by
// SymbolLogic<T>.
export function declaredSymbolsForType(ctor: abstract new (...args: any[]) => SymbolLike): SymbolLike[] {
    // A lookup, not a construction: the map is keyed by the constructor object itself, so an
    // abstract-tolerant `Type<T>` is a perfectly good key. Only `init` needs a real `SymbolCtor`.
    const byKey = declaredSymbols.get(ctor as SymbolCtor);
    return byKey == null ? [] : [...byKey.values()];
}

// Every declared symbol, of every concrete Symbol type. The metadata builder groups these by the
// container half of the key ("OrderOperation.Ship" → "OrderOperation") to emit one "Container"
// TypeMetadata per symbol namespace, carrying each member's label and database id. The ids are read
// back from the DB by SymbolLogic, which stamps them onto these very instances, so reading `.id` here
// is correct once the schema has loaded (and undefined before, which the builder simply omits).
export function allDeclaredSymbols(): SymbolLike[] {
    const result: SymbolLike[] = [];
    for (const byKey of declaredSymbols.values())
        result.push(...byKey.values());
    return result;
}
