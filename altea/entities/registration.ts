// Leaf module: the runtime registries (type / enum / object) plus the FileInfo
// helper. It imports nothing at runtime, so it can be re-exported from BOTH
// reflection.ts and utils/localization.ts without creating an import cycle
// (reflection imports localization for DescriptionManager, so these registries
// can't live in either of those two modules).

// The npm package + relative source file a type/enum/object was defined in (the
// TS analogue of a .NET assembly + file). Supplied by the quote-transformer;
// used for package→schema attribution and diagnostics.
export interface SourceLocation {
    packageName: string;
    fileName: string;
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

// Object registry: named runtime objects (e.g. message containers transformed by
// msg(), and later operation/symbol containers).
const objectRegistry = new Map<string, object>();

// name -> source location, uniform across types, enums and objects.
const locationRegistry = new Map<string, SourceLocation>();

// `name`, `packageName` and `fileName` are supplied by the quote-transformer
// (literals, from the source) so registration survives bundling: bundlers can
// strip the `var X = class {}` binding that gives an anonymous class its
// `.name`, leaving ctor.name === "" and breaking name-based resolution. Falls
// back to ctor.name when called directly (e.g. from @reflect at decoration time).
export function registerType(ctor: Function, name?: string, packageName?: string, fileName?: string): void {
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
    if (packageName != null && fileName != null)
        locationRegistry.set(key, { packageName, fileName });
}

export function resolveType(name: string): Function | undefined {
    return typeRegistry.get(name);
}

// Registers a database enum by name (so the enum-table support can map a field's
// enum type back to its values). Mirrors registerType for enums.
export function registerEnum(enumObject: object, name?: string, packageName?: string, fileName?: string): void {
    if (!name) return;
    enumRegistry.set(name, enumObject);
    if (packageName != null && fileName != null)
        locationRegistry.set(name, { packageName, fileName });
}

export function resolveEnum(name: string): object | undefined {
    return enumRegistry.get(name);
}

// Registers a named runtime object (message containers, …) with its location.
export function registerObject(obj: object, name?: string, packageName?: string, fileName?: string): void {
    if (!name) return;
    objectRegistry.set(name, obj);
    if (packageName != null && fileName != null)
        locationRegistry.set(name, { packageName, fileName });
}

export function resolveObject(name: string): object | undefined {
    return objectRegistry.get(name);
}

// The package + file a registered type / enum / object was defined in, by name.
export function getLocation(name: string): SourceLocation | undefined {
    return locationRegistry.get(name);
}

// Per-file helper emitted by the quote-transformer to avoid repeating the
// package + file literals on every registration:
//   const __fileInfo = new FileInfo("@altea/altea-test", "entities/music.ts");
//   __fileInfo.registerType(AlbumEntity, "AlbumEntity");
//   __fileInfo.registerEnum(Sex, "Sex");
//   __fileInfo.registerObject(ValidationMessage, "ValidationMessage");
export class FileInfo {
    constructor(
        public readonly packageName: string,
        public readonly fileName: string,
    ) { }

    registerType(ctor: Function, name?: string): void {
        registerType(ctor, name, this.packageName, this.fileName);
    }

    registerEnum(enumObject: object, name?: string): void {
        registerEnum(enumObject, name, this.packageName, this.fileName);
    }

    registerObject(obj: object, name?: string): void {
        registerObject(obj, name, this.packageName, this.fileName);
    }
}
