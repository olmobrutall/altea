import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getRegisteredTypes, getRegisteredEnums, getLocation } from "@altea/altea/data/registration";
import type { FileInfo } from "@altea/altea/data/registration";
import type { EvalImports, ModuleImport, NameList, SchemaImportOptions } from "../data/EvalImports";

// Turning the DECLARATION (data/EvalImports) into the two things a compile actually needs:
//
//   - the import lines every script gets (the eager half), and
//   - an identifier -> module map (the lazy half), which is what lets a script name `OrderEntity` without
//     importing it.
//
// Both halves need names, and a declaration may say `"*"` instead of listing them, so expansion is the
// bulk of this file. `"*"` is answered either from the module's runtime keys or from its `.d.ts` — the
// latter through a callback, because only the compiler has a `ts.Program` to ask.
//
// FIRST DECLARATION WINS on a duplicated identifier. That is a rule, not an accident: a configuration is
// ordered, `.extend()` appends, so a base configuration keeps priority over what extends it, and a script
// can always override both by writing the import itself.
//
// Expansion is deliberately NOT cached here. EvalCompiler caches it and drops the cache whenever the
// configuration or the schema can have changed, which is the only place that knows.

/** What a compile needs: what is already in scope, and what can be brought into it. */
export interface ResolvedImports {
    /** Prepended to every generated script. */
    eagerLines: readonly string[];
    /** Identifier -> the module that provides it. Lazy modules only; the eager ones are already in scope. */
    byName: ReadonlyMap<string, ModuleImport>;
    /** Every module a script may import, by the specifier it would write. */
    bySpecifier: ReadonlyMap<string, ModuleImport>;
}

export interface ResolveContext {
    /** The app's directory — where `dist` sits and where `node_modules` is resolved from. */
    baseDirectory: string;
    /**
     * The app's own package name. A type declared THERE cannot be imported by package name (an app is not
     * installed as a package), so it is imported by relative path with an explicit `typesPath` instead.
     */
    appPackageName?: string;
    /**
     * The exported names of each module, read from its `.d.ts`. Only the compiler can answer this. The
     * whole {@link ModuleImport} is handed over, not just the specifier, because an app's module is only
     * findable through its `typesPath`.
     */
    discoverDts: (modules: readonly ModuleImport[]) => ReadonlyMap<string, readonly string[]>;
}

export namespace EvalModuleRegistry {

    export function resolve(imports: EvalImports, ctx: ResolveContext): ResolvedImports {
        const modules = [...imports.modules, ...fromSchema(imports.schemaSources, ctx)];

        // One batch for every `"*"` that needs the compiler, so the probe program is built once.
        const needDts = modules.filter(m => m.names === "*" && (m.discover ?? "dts") === "dts");
        const discovered = needDts.length === 0
            ? new Map<string, readonly string[]>()
            : ctx.discoverDts(needDts);

        const eagerLines: string[] = [];
        const byName = new Map<string, ModuleImport>();
        const bySpecifier = new Map<string, ModuleImport>();

        for (const m of modules) {
            bySpecifier.set(m.specifier, m);

            const names = namesOf(m, discovered);

            if (m.eager) {
                if (names.length > 0)
                    eagerLines.push(`import { ${names.join(", ")} } from "${m.specifier}";`);
                continue;
            }

            for (const name of names)
                if (!byName.has(name))     // first declaration wins — see the header
                    byName.set(name, m);
        }

        return { eagerLines, byName, bySpecifier };
    }

    function namesOf(m: ModuleImport, discovered: ReadonlyMap<string, readonly string[]>): readonly string[] {
        if (m.names !== "*")
            return m.names;

        if ((m.discover ?? "dts") === "dts")
            return discovered.get(m.specifier) ?? [];

        // A module registered without its value has nothing to read keys off; `"dts"` is the answer there,
        // and defaulting to it is why this is only reached when the author asked for `"runtime"`.
        return m.value == null ? [] : Object.keys(m.value as object);
    }

    // ---- The schema half ---------------------------------------------------------------------------------

    /**
     * Every registered entity and enum, grouped into ONE module per source file — which is what an import
     * line needs, and what keeps the identifier map small (a file of twenty types is one entry).
     *
     * A type's location is the package and file the quote transformer stamped on it, so this is the same
     * information the build had, read back at run time.
     */
    function fromSchema(sources: readonly SchemaImportOptions[], ctx: ResolveContext): ModuleImport[] {
        if (sources.length === 0)
            return [];

        const result: ModuleImport[] = [];

        for (const source of sources) {
            const kinds = source.kinds ?? ["type", "enum"];

            const candidates: [string, FileInfo][] = [];
            const consider = (name: string): void => {
                const location = getLocation(name);
                if (location == null)
                    return;                                  // a type with no stamped location cannot be imported
                if (source.packages != null && !source.packages.includes(location.packageName))
                    return;
                if (source.filter != null && !source.filter(name, location))
                    return;
                candidates.push([name, location]);
            };

            if (kinds.includes("type"))
                for (const ctor of getRegisteredTypes())
                    consider(ctor.name);
            if (kinds.includes("enum"))
                for (const [name] of getRegisteredEnums())
                    consider(name);

            // Group by FILE, then make one module of each: an import line names a module, not a type, and
            // a file of twenty entities is one entry in the identifier map rather than twenty.
            const byFile = new Map<string, { location: FileInfo; names: string[] }>();
            for (const [name, location] of candidates) {
                const key = location.packageName + "/" + location.fileName;
                let entry = byFile.get(key);
                if (entry == null)
                    byFile.set(key, entry = { location, names: [] });
                entry.names.push(name);
            }

            for (const { location, names } of byFile.values())
                result.push(moduleFor(location, source.exports === "types" ? names : "*", ctx));
        }

        return result;
    }

    /**
     * How a file in `location` is imported.
     *
     * An `@altea/*` package resolves by name through its `exports` map, which maps `./data/User` straight
     * onto `./dist/data/User.js` — so the SOURCE path doubles as the specifier and nothing else is needed.
     * The APP cannot: nothing depends on it, so there is no `node_modules` entry, and both the types and
     * the runtime module have to be pointed at explicitly.
     */
    function moduleFor(location: FileInfo, names: NameList, ctx: ResolveContext): ModuleImport {
        const stem = location.fileName.replace(/\.tsx?$/, "");

        if (location.packageName !== ctx.appPackageName)
            return { specifier: `${location.packageName}/${stem}`, names, eager: false };

        const dist = (ext: string): string =>
            path.join(ctx.baseDirectory, "dist", stem + ext).split(path.sep).join("/");

        return {
            specifier: `./${stem}`,
            names,
            eager: false,
            typesPath: dist(".d.ts"),
            // An absolute URL, because `import("./app/…")` would resolve against THIS file.
            runtimeSpecifier: pathToFileURL(dist(".js")).href,
        };
    }

    // ---- Loading a module's value ------------------------------------------------------------------------

    /**
     * The runtime module behind a declaration. A `value` handed over at registration is used as-is;
     * otherwise the specifier is imported, resolved FROM THE APP rather than from altea-eval — a package
     * only the app depends on is not reachable from here.
     */
    export async function loadValue(m: ModuleImport, baseDirectory: string): Promise<unknown> {
        if (m.value != null)
            return m.value;

        const specifier = m.runtimeSpecifier ?? m.specifier;

        // Already a URL or an absolute path: nothing to resolve.
        if (specifier.startsWith("file:") || path.isAbsolute(specifier))
            return await import(specifier);

        try {
            const require = createRequire(path.join(baseDirectory, "package.json"));
            return await import(pathToFileURL(require.resolve(specifier)).href);
        }
        catch {
            // An ESM-only package has no `require` condition to resolve through; let the plain import try.
            return await import(specifier);
        }
    }
}
