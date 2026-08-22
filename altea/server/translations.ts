import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { XMLParser } from "fast-xml-parser";
import { Metadata } from "../data/metadata";
import type { TypeMetadata } from "../data/metadata";

// Server-side reader for Signum's translation XML files (LocalizedAssembly format) — the per-culture
// half of the metadata blob. Parsed here (Node) with fast-xml-parser into TypeMetadata and merged into
// the Metadata store; the client only ever receives the assembled blob as JSON, so no XML parser ships
// to the browser. File names follow Signum's `<name>.<culture>.xml` convention (e.g. `Southwind.es.xml`).
//
// A translation file names ONLY the pieces it translates, so the TypeMetadata it yields is partial: the
// `kind` is a placeholder ("Entity") that the metadata builder overwrites from the real registry, and
// absent members simply fall back to the humanised identifier.
//
// Shape parsed:
//   <Translations>
//     <Type Name="OrderEntity" Description="Pedido" [PluralDescription=…] [Gender=…]>
//       <Member Name="OrderDate" Description="Fecha del pedido" />
//     </Type>
//   </Translations>
// A "Type" is any named container (entity/embedded/enum/message/operation/symbol) and Name/Member are
// the C# identifiers (PascalCase, suffixes kept).

// attribute keys kept verbatim (no prefix); Type/Member always arrays even when singular.
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: name => name === "Type" || name === "Member",
});

export function parseSignumTranslations(xml: string): Record<string, TypeMetadata> {
    const doc = parser.parse(xml) as { Translations?: { Type?: RawType[] } };
    const result: Record<string, TypeMetadata> = {};
    for (const t of doc.Translations?.Type ?? []) {
        if (t.Name == null) continue;
        const tm: TypeMetadata = { kind: "Entity", fields: {} };
        if (t.Description != null) tm.niceName = String(t.Description);
        if (t.PluralDescription != null) tm.nicePluralName = String(t.PluralDescription);
        if (t.Gender != null) tm.gender = String(t.Gender);
        for (const m of t.Member ?? [])
            if (m.Name != null && m.Description != null)
                tm.fields[String(m.Name)] = { niceName: String(m.Description) };
        result[String(t.Name)] = tm;
    }
    return result;
}

interface RawType {
    Name?: string; Description?: string; PluralDescription?: string; Gender?: string;
    Member?: { Name?: string; Description?: string }[];
}

// Parse an XML string and merge it into a locale.
export function loadSignumTranslations(locale: string, xml: string): void {
    Metadata.merge(locale, parseSignumTranslations(xml));
}

// Load one XML file for an explicit locale.
export function loadTranslationFile(locale: string, path: string): void {
    loadSignumTranslations(locale, readFileSync(path, "utf8"));
}

// Load every `*.<culture>.xml` file in a directory, inferring the locale from each file name.
export function loadTranslationsFromDir(dir: string): void {
    for (const file of readdirSync(dir)) {
        const m = /\.([A-Za-z]{2}(?:-[A-Za-z]{2})?)\.xml$/.exec(file);
        if (m != null)
            loadTranslationFile(m[1], join(dir, file));
    }
}

// ─── Where translation files live ────────────────────────────────────────────────────────────────
// DIVERGENCE from Signum, which copies every module's XML into ONE output folder per application
// (`Southwind/Translations`): here each PACKAGE owns its own `translations/` directory, so a module's
// `<Module>.<culture>.xml` travels with the module and every application that installs it gets the
// translations for free — nothing to copy per app. The application keeps its own directory for its own
// types, and it is loaded LAST so an app file wins any key collision with a module's.
const TRANSLATIONS_DIR_NAME = "translations";

// A package that ships translations is by definition an altea module, so it declares the framework as a
// (peer)dependency. Recursing only through those prunes the whole third-party tree from the boot scan.
const FRAMEWORK_PACKAGE = "@altea/altea";

interface PackageJson {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | undefined {
    try {
        return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
    } catch {
        return undefined; // not a package directory (or unreadable) — nothing to scan
    }
}

function dependsOnFramework(pkg: PackageJson): boolean {
    return pkg.dependencies?.[FRAMEWORK_PACKAGE] != null || pkg.peerDependencies?.[FRAMEWORK_PACKAGE] != null;
}

// The installed directory of `name` as seen from `fromDir`. Node's own resolver first (it honours
// symlinks, workspaces and whatever linker layout is in use), falling back to a plain `node_modules`
// walk for a package whose `exports` map does not publish `./package.json` — which ours do not.
export function tryResolvePackageDir(name: string, fromDir: string): string | undefined {
    try {
        return dirname(createRequire(join(fromDir, "package.json")).resolve(`${name}/package.json`));
    } catch { /* not exported, or not installed — try the walk below */ }
    for (let dir = fromDir, parent = dirname(dir); ; dir = parent, parent = dirname(dir)) {
        const candidate = join(dir, "node_modules", name);
        if (existsSync(join(candidate, "package.json")))
            return candidate;
        if (parent === dir)
            return undefined;
    }
}

// Every module `translations/` directory reachable from the application root, walking the dependency
// graph (a module may pull in another module — altea-auth-azuread brings altea-auth). Sorted by package
// name so the load order, and therefore precedence between modules, is deterministic.
export function collectModuleTranslationsDirs(appRoot: string): string[] {
    const found = new Map<string, string>();
    const visited = new Set<string>();
    const queue: string[] = [appRoot];
    while (queue.length > 0) {
        const dir = queue.shift()!;
        const pkg = readPackageJson(dir);
        if (pkg == null) continue;
        for (const dep of Object.keys(pkg.dependencies ?? {})) {
            if (visited.has(dep)) continue;
            visited.add(dep);
            // From the depending package first (a nested install), then from the app root — a workspace
            // module lives OUTSIDE the app tree, so the walk up from it never reaches the app's packages.
            const depDir = tryResolvePackageDir(dep, dir) ?? tryResolvePackageDir(dep, appRoot);
            const depPkg = depDir == null ? undefined : readPackageJson(depDir);
            if (depDir == null || depPkg == null) continue;
            const translations = join(depDir, TRANSLATIONS_DIR_NAME);
            if (existsSync(translations))
                found.set(dep, translations);
            if (dependsOnFramework(depPkg))
                queue.push(depDir);
        }
    }
    return [...found.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, dir]) => dir);
}

// The application root: where its `package.json` (the dependency graph to scan) and its own
// `translations/` live. Env TRANSLATIONS_ROOT overrides it for a deployment whose cwd is elsewhere.
export function resolveAppRoot(): string {
    return process.env["TRANSLATIONS_ROOT"] || process.cwd();
}

// Resolve the APPLICATION's own translations directory — its own types only, since each module's files
// now live in the module. Precedence:
//   1. the explicit `dir` argument (a host that already knows its layout),
//   2. env TRANSLATIONS_DIR (absolute, or relative to the app root),
//   3. `<appRoot>/translations`.
// In Docker: set WORKDIR to the app root and COPY the app's translations there (or set TRANSLATIONS_ROOT
// to a mounted volume); the modules' files ship inside their packages, so there is nothing else to copy.
export function resolveTranslationsDir(dir?: string): string {
    if (dir != null && dir !== "")
        return dir;
    const base = resolveAppRoot();
    const configured = process.env["TRANSLATIONS_DIR"];
    if (configured != null && configured !== "")
        return isAbsolute(configured) ? configured : resolve(base, configured);
    return join(base, TRANSLATIONS_DIR_NAME);
}

// Load every installed module's translations, then the application's own (all files merge via
// Metadata.merge, later entries winning per key — so an app file can override a module's caption).
// Missing directories are skipped. Returns the directories loaded, in order. Call once at startup.
export function loadAppTranslations(dir?: string): string[] {
    const dirs = collectModuleTranslationsDirs(resolveAppRoot());
    const appDir = resolveTranslationsDir(dir);
    if (existsSync(appDir) && !dirs.includes(appDir))
        dirs.push(appDir);
    for (const d of dirs)
        loadTranslationsFromDir(d);
    return dirs;
}
