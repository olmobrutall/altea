import type { FileInfo } from "@altea/altea/data/registration";

// WHAT a stored script may reach, as a VALUE rather than as a global registry.
//
// Signum configures an `Eval<T>`'s compilation with a list of assemblies and namespaces, per eval kind.
// This is the TypeScript counterpart, with the split TypeScript forces and C# does not: a name is in scope
// only if something imported it.
//
//  - **eager**: imported into EVERY generated script, so the name is simply in scope. Keep this small —
//    it is the common vocabulary (a query, an operation, the current user), not a dumping ground.
//  - **lazy**: an identifier -> module MAP. Nothing is imported until a script actually names the
//    identifier, at which point the compiler writes the import for it (see EvalCompiler's implicit-import
//    pass) and loads the module. This is what carries the entity domain, which is far too large to be eager.
//
// The result is that most scripts are import-free, and the ones that are not can still write a normal
// `import` line — which WINS over the implicit one, and is the escape hatch when two modules export the
// same name (otherwise the first listed wins; see EvalModuleRegistry).
//
// An EvalImports is IMMUTABLE: every method returns a new one. That is the point of it being a value —
// a base configuration is shared, and one eval kind derives its own with `.extend(...)` instead of
// mutating what everything else sees.
//
// Nothing here resolves anything. Expanding `"*"`, walking the schema, finding a `.d.ts` and loading a
// module are all the SERVER's job (server/EvalModuleRegistry), which keeps this file isomorphic: the
// client needs the same declaration to drive the editor, and must not carry a compiler.

/** The identifiers a module contributes, or `"*"` for all of them. */
export type NameList = readonly string[] | "*";

export interface ModuleImportOptions {
    /**
     * How `"*"` is expanded.
     *
     *  - `"runtime"` reads the imported module's own keys. Cheap, but a name that exists only as a TYPE
     *    (an interface, a type alias) has no runtime counterpart and is therefore invisible.
     *  - `"dts"` asks the TypeScript compiler for the module's exported symbols, which sees those too.
     *
     * Defaults to `"dts"` — a stored script names types at least as often as values.
     */
    discover?: "runtime" | "dts";
    /**
     * The already-imported module object. Hand it over when the module is awkward to reach by specifier
     * alone; omitted, the compiler imports `specifier` itself the first time a script needs it.
     */
    value?: unknown;
    /**
     * Where the `.d.ts` lives, when TypeScript cannot find it on its own. `@altea/*` packages resolve
     * through their `exports` map without help; an APP's own modules need this, because an app is not
     * installed as a package — nothing depends on it, so there is no `node_modules` entry to follow.
     */
    typesPath?: string;
    /**
     * What to import at RUN time, when that differs from the specifier written in source. An app's module
     * is written `./app/orders/Order.data` (its source path, which is what the `.d.ts` sits next to) but
     * lives at `dist/app/orders/Order.data.js` when the server runs.
     */
    runtimeSpecifier?: string;
}

/** One module a stored script may reach. */
export interface ModuleImport extends ModuleImportOptions {
    /** The specifier a generated `import` writes. */
    specifier: string;
    names: NameList;
    /** Imported into every script (`eager`), or only when a script names one of `names` (`lazy`). */
    eager: boolean;
}

/**
 * Entity and enum types taken straight from reflection, so a domain does not have to be listed twice.
 * Every registered type carries the package and file it was declared in, which is exactly what an import
 * needs.
 */
export interface SchemaImportOptions {
    /** Only types declared in these packages. Omitted: every package. */
    packages?: readonly string[];
    /** Which kinds to take. Defaults to both. */
    kinds?: readonly ("type" | "enum")[];
    /** A final say per type, after `packages` and `kinds`. */
    filter?: (name: string, location: FileInfo) => boolean;
    /**
     * What a matching type brings in with it.
     *
     *  - `"file"` (the default): every export of the FILE it was declared in. An entity rarely travels
     *    alone — its operations, its state enum and its symbols live beside it, and a script that reaches
     *    for one reaches for the others.
     *  - `"types"`: only the matching names themselves.
     */
    exports?: "file" | "types";
}

export class EvalImports {

    private constructor(
        /** In declaration order, which is also RESOLUTION order when two modules export the same name. */
        readonly modules: readonly ModuleImport[],
        /** Expanded lazily, at compile time: a type registered after `start()` still counts. */
        readonly schemaSources: readonly SchemaImportOptions[],
    ) { }

    static readonly empty = new EvalImports([], []);

    /** In scope in every script, with no import line. */
    eager(specifier: string, names: NameList, options?: ModuleImportOptions): EvalImports {
        return this.add({ ...options, specifier, names, eager: true });
    }

    /** Importable by name: written into the script, and loaded, only when a script names one. */
    lazy(specifier: string, names: NameList, options?: ModuleImportOptions): EvalImports {
        return this.add({ ...options, specifier, names, eager: false });
    }

    /** Every entity and enum the schema knows, importable by its own name. Always lazy. */
    fromSchema(options?: SchemaImportOptions): EvalImports {
        return new EvalImports(this.modules, [...this.schemaSources, options ?? {}]);
    }

    /**
     * Everything `other` declares, after everything this one does — so THIS configuration keeps priority
     * on a name both of them export.
     */
    extend(other: EvalImports): EvalImports {
        return new EvalImports(
            [...this.modules, ...other.modules],
            [...this.schemaSources, ...other.schemaSources]);
    }

    /** Drop a module, by specifier. The way a derived configuration narrows the one it extends. */
    without(specifier: string): EvalImports {
        return new EvalImports(this.modules.filter(m => m.specifier !== specifier), this.schemaSources);
    }

    /**
     * A later registration REPLACES the earlier one in place, rather than being appended: re-declaring a
     * module is how its names or options are corrected, and a stale duplicate earlier in the list would
     * keep winning.
     *
     * Eager and lazy are separate entries for the same specifier, on purpose — a module usually has a
     * couple of names worth putting in scope everywhere and a long tail that is only worth importing when
     * a script asks for it.
     */
    private add(m: ModuleImport): EvalImports {
        const at = this.modules.findIndex(x => x.specifier === m.specifier && x.eager === m.eager);
        const modules = at < 0 ? [...this.modules, m] : this.modules.map((x, i) => i === at ? m : x);
        return new EvalImports(modules, this.schemaSources);
    }
}
