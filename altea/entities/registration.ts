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
    // Also register under the clean name (trailing "Entity" stripped), so
    // resolveType("Order") works — the clean name is the canonical id used in the JSON
    // wire format and in user-facing URLs (/view/order/1). The full name stays the
    // primary key; the clean alias is only added when free, so a type literally named
    // "Order" is never shadowed by OrderEntity's alias.
    const clean = key.replace(/Entity$/, '');
    if (clean !== key && !typeRegistry.has(clean)) typeRegistry.set(clean, ctor);
    if (fileInfo != null) locationRegistry.set(key, fileInfo);
}

export function resolveType(name: string): Function | undefined {
    return typeRegistry.get(name);
}

// The "clean" type name written as the @implementedByAll discriminator (and used
// for @implementedBy column names): the constructor name with a trailing "Entity"
// stripped (e.g. BandEntity -> "Band"). Single source of truth shared by the save
// path (which writes it) and the LINQ SmartEqualizer / Retriever (which compare
// and resolve it).
export function cleanTypeName(ctor: Function): string {
    return ctor.name.replace(/Entity$/, '');
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

// Developer-facing: authors write `= init()`; the quote-transformer supplies
// (SymbolClass, key, fileInfo). The zero-arg overload returns the declared symbol type S
// so the const type-checks before transformation (no cast needed).
export function init<S>(): S;
export function init(ctor: SymbolCtor, key: string, fileInfo?: FileInfo): SymbolLike;
export function init(ctor?: SymbolCtor, key?: string, fileInfo?: FileInfo): unknown {
    if (ctor == null || key == null)
        throw new Error("init() was not processed by the quote-transformer. Declare the symbol as `export const X: SomeSymbol = init()` inside an `export namespace`, with the transformer enabled for this package.");

    const sym = new ctor();
    sym.key = key;
    sym.isNew = false; // symbols are pre-existing rows; SymbolLogic assigns the id

    let byKey = declaredSymbols.get(ctor);
    if (byKey == null) declaredSymbols.set(ctor, byKey = new Map());
    byKey.set(key, sym);

    if (fileInfo != null) locationRegistry.set(key, fileInfo);
    return sym;
}

// All declared symbols of a concrete Symbol type (Signum's getSymbols()); consumed by
// SymbolLogic<T>.
export function declaredSymbolsForType(ctor: SymbolCtor): SymbolLike[] {
    const byKey = declaredSymbols.get(ctor);
    return byKey == null ? [] : [...byKey.values()];
}
