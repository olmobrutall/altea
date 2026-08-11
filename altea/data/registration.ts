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
    packageName: string; // owning npm package name, e.g. "@altea/altea-test"
    fileName: string;    // path relative to that package, e.g. "entities/music.ts"
}

// Type registry: maps a type's name to its runtime constructor. Populated at
// class-definition time by @reflect / @entity, so the schema builder can resolve
// a field's `typeName` (e.g. "CustomerEntity") back to its constructor for
// classification (entity / embedded) and recursion. Value types (String, Number,
// Date, Decimal, Temporal.*) are intentionally absent — they resolve by name in
// defaultDbType.
const typeRegistry = new Map<string, Function>();

// Enum registry: maps an enum's name to its runtime enum object. Enums have no
// constructor to hang metadata on, so they are registered explicitly via
// registerEnum. Consumed by the enum-table support.
const enumRegistry = new Map<string, object>();

// Reverse of enumRegistry: the registered name of an enum object. Lets the
// EnumEntity(enumObject) factory name the synthesized entity/table after the enum.
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
export function registerType(ctor: Function, name?: string, fileInfo?: FileInfo): void {
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
    typeRegistry.set(key, ctor);
    // Also register under the clean name (see stripEntitySuffix), so resolveType("Order") works — the
    // clean name is the canonical id used in the JSON wire format and in user-facing URLs (/view/order/1).
    // The full name stays the primary key; the clean alias is only added when free, so a type literally
    // named "Order" is never shadowed by OrderEntity's alias.
    const clean = stripEntitySuffix(key);
    if (clean !== key && !typeRegistry.has(clean)) typeRegistry.set(clean, ctor);
    if (fileInfo != null) locationRegistry.set(key, fileInfo);
}

// All DISTINCT constructors registered via registerType (deduped — each ctor is registered under both
// its full and clean name). Used by ReflectionClient to propagate an abstract base type's operations to
// its concrete subclasses, since altea gives every class its own TypeInfo (operations don't inherit).
export function getRegisteredTypes(): Function[] {
    return [...new Set(typeRegistry.values())];
}

export function resolveType(name: string): Function | undefined {
    // Direct hit for the canonical (PascalCase) names — the full name and the clean alias, incl. every
    // wire $type. The firstLower fallback resolves names that come from URLs, where navigateRouteDefault
    // lower-cases the first letter (`/view/order/1` → "order" → "Order"); PascalCase names never reach it.
    return typeRegistry.get(name)
        ?? (name.length > 0 ? typeRegistry.get(name[0].toUpperCase() + name.slice(1)) : undefined);
}

// The "clean" type name written as the @implementedByAll discriminator (and used
// for @implementedBy column names): the constructor name with a trailing "Entity"
// stripped (e.g. BandEntity -> "Band"). Single source of truth shared by the save
// path (which writes it) and the LINQ SmartEqualizer / Retriever (which compare
// and resolve it).
export function cleanTypeName(ctor: Function): string {
    return stripEntitySuffix(ctor.name);
}

// Strip the "Entity" suffix from each underscore-separated segment (mirrors the schema builder's table
// naming). A plain entity: "BandEntity" -> "Band". A PART entity (altea's MList replacement, named
// `<Owner>Entity_<Field>`): "RuleTypeConditionEntity_Conditions" -> "RuleTypeCondition_Conditions",
// "EmployeeEntity_Territories" -> "Employee_Territories". Per-segment so the OWNER's suffix is stripped
// too, not just a trailing one (the previous trailing-only strip left the part's owner segment mangled,
// disagreeing with the schema builder's own cleanTypeName).
function stripEntitySuffix(name: string): string {
    return name.split('_').map(s => s.replace(/Entity$/, '')).join('_');
}

// Reverse of cleanTypeName: resolves a discriminator string back to its
// constructor. Tries the clean name directly, then with the "Entity" suffix that
// cleanTypeName stripped.
export function resolveCleanType(cleanName: string): Function | undefined {
    return typeRegistry.get(cleanName) ?? typeRegistry.get(cleanName + "Entity");
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
// The schema a package's tables land in (SchemaBuilder consults it per type; server-only — ignored on
// the client). FOLDER-SCOPED: a declaration covers the directory of the file it is written in and every
// file below it, and the most specific (longest matching directory) wins — so a sub-folder overrides its
// package's default without annotating each entity. Placed at the package root ("" directory) it covers
// the whole package. Stored as { packageName, dir, schema }.
interface SchemaScope { packageName: string; dir: string; schema: string; }
const schemaScopes: SchemaScope[] = [];

export function setDefaultDatabaseSchema(schema: string, fileInfo?: FileInfo): void {
    const packageName = fileInfo?.packageName ?? "";
    const dir = fileInfo != null ? dirName(fileInfo.fileName) : "";
    // A second declaration for the same directory replaces the first (also makes re-runs idempotent).
    const existing = schemaScopes.find(s => s.packageName === packageName && s.dir === dir);
    if (existing != null) existing.schema = schema;
    else schemaScopes.push({ packageName, dir, schema });
}

// The schema that applies to a registered type NAME — the longest declared scope whose package matches
// and whose directory is a prefix of the type's file. undefined when no scope covers it (→ the connection
// default schema).
export function schemaForName(name: string): string | undefined {
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

// The minimal shape init() stamps. Declared locally (not `import { Symbol }`) so the
// leaf stays runtime-import-free — the concrete constructor is passed in by init()'s
// caller, and its Entity machinery is irrelevant to the stamping here.
interface SymbolLike { key: string; isNew: boolean }
type SymbolCtor = new () => SymbolLike;

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
export function declaredSymbolsForType(ctor: SymbolCtor): SymbolLike[] {
    const byKey = declaredSymbols.get(ctor);
    return byKey == null ? [] : [...byKey.values()];
}
