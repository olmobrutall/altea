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
    if (fileInfo != null) locationRegistry.set(key, fileInfo);
}

export function resolveType(name: string): Function | undefined {
    return typeRegistry.get(name);
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
