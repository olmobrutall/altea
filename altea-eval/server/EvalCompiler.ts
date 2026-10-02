import path from "node:path";
import fs from "node:fs";
import ts from "typescript";
import quoteTransformerModule from "quote-transformer";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { EvalEmbedded, EvalMessage, type CompilationResult, type IEvalCompiler } from "../data/Eval";
import { EvalImports, type ModuleImport } from "../data/EvalImports";
import { EvalModuleRegistry, type ResolvedImports } from "./EvalModuleRegistry";

/**
 * The third argument ts-patch passes a transformer. Taken from the transformer's own signature rather
 * than imported, so altea-eval needs no direct dependency on ts-patch.
 */
type TransformerExtras = Parameters<typeof quoteTransformer>[2];

/**
 * The transformer ships as CommonJS, and Node's ESM interop makes a CJS module's `default` the whole
 * `module.exports` rather than its `default` property - so the import above lands on the NAMESPACE, not
 * the function, and calling it throws `quoteTransformer is not a function`. A bundler resolves the same
 * import to the function directly, hence the fallback.
 */
const quoteTransformer = (quoteTransformerModule as unknown as
    { default?: typeof quoteTransformerModule }).default ?? quoteTransformerModule;

// Compiling a stored script is FOUR passes:
//
//   1. TYPE-CHECK the generated module with `ts.createProgram` over the app's own compilerOptions, so an
//      author gets real diagnostics ("Property 'foo' does not exist on type 'OrderEntity'") against the
//      real `.d.ts` of every package the configuration allows.
//   2. RESOLVE the names that pass could not find against the LAZY half of the configuration, write the
//      imports for them, and check again. This is what makes most scripts import-free.
//   3. EMIT through that same program, with the quote transformer as a `before` transformer. The
//      transformer is type-driven, so it needs the checker: this is what makes a query written in a
//      stored script (`table(X).filter(x => ...)`) lower to SQL like one written in a source file.
//   4. Lower the emitted ESM to CommonJS (`ts.transpileModule`, a purely syntactic step), load the
//      modules it requires, and run it with `new Function(exports, require, module, ...)`.
//
// The configuration (data/EvalImports) is BOTH SIDES of the same list: what a generated import may name,
// and what `require` will answer with. Every specifier a script writes is checked BY NAME (see
// `disallowedImports`), so an unregistered one fails as a COMPILE ERROR in the editor rather than as a
// surprise the first time the script runs — which is what it used to do, since a real package
// type-checks against node_modules whether or not the app allowed it.
//
// Nothing is ever unloaded (a module here is a closure, not a loaded assembly), so the per-code cache
// below is what keeps that bounded.
//
// A compiled script runs IN PROCESS with the same rights as the rest of the server. Authoring one is
// gated by the owning entity's Save operation and by `EvalPanelPermission`; there is no sandbox, and
// pretending otherwise would be worse than saying so.
//
// Port of the Roslyn half of Signum.Eval's EvalEmbedded.Compile — see port/Eval.md.

export interface EvalCompilerOptions {
    /**
     * The directory a generated eval pretends to live in. Module resolution and `node_modules` lookup start
     * here, so this should be the APP's directory — the one whose node_modules has the `@altea/*` links.
     */
    baseDirectory: string;
    /** Overrides merged over the defaults below (which mirror altea's tsconfig.base). */
    compilerOptions?: ts.CompilerOptions;
}

export namespace EvalCompiler {

    let options: EvalCompilerOptions | undefined;
    let program: ts.Program | undefined;

    /** The app's own package name, read once — see {@link EvalModuleRegistry.ResolveContext}. */
    let appPackageName: string | undefined;

    /** The configuration an eval gets when it does not name its own. */
    let defaults: EvalImports = EvalImports.empty;

    // Per configuration, because two eval kinds may see different modules and so compile the same text to
    // different things. Weak, so a configuration built and dropped on the fly is not retained.
    const resolvedCache = new WeakMap<EvalImports, ResolvedImports>();
    const resultCache = new WeakMap<EvalImports, Map<string, Promise<CompilationResult<unknown>>>>();

    // The generated files, by the name the compiler host answers on. Inside `baseDirectory` so `@altea/…`
    // resolves through the app's node_modules, and named so they can never collide with a real file.
    const virtualFiles = new Map<string, string>();
    let virtualFile = "";
    let discoveryFile = "";

    /**
     * Where a specifier's types live, when TypeScript cannot find them on its own. Kept apart from the
     * resolved configuration because module DISCOVERY needs it before that configuration exists.
     */
    const typesBySpecifier = new Map<string, string>();

    /**
     * Defaults mirroring altea/tsconfig.base.json — the same dialect every package is written in, so a
     * script reads like the rest of the codebase. `skipLibCheck` keeps the check to the ONE file that
     * matters; `types: []` keeps `@types/node` out unless the app asks for it.
     */
    function defaultCompilerOptions(): ts.CompilerOptions {
        return {
            target: ts.ScriptTarget.ES2022,
            lib: ["lib.es2022.d.ts", "lib.esnext.disposable.d.ts"],
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            strict: true,
            strictPropertyInitialization: false,
            experimentalDecorators: true,
            esModuleInterop: true,
            skipLibCheck: true,
            // NOT `noEmit`: the script is emitted BY THE PROGRAM so the quote transformer can run with a
            // type checker (see `emit`). Declarations and source maps are dead weight here.
            noEmit: false,
            declaration: false,
            sourceMap: false,
            inlineSourceMap: false,
            types: [],
        };
    }

    export function configure(opts: EvalCompilerOptions): void {
        options = opts;
        // FORWARD slashes: TypeScript normalises every path it handles, so a Windows `path.join` result
        // would never match the file name the program hands back to `getSourceFile`.
        virtualFile = toTsPath(path.join(opts.baseDirectory, "__altea_eval__.ts"));
        discoveryFile = toTsPath(path.join(opts.baseDirectory, "__altea_eval_discovery__.ts"));
        appPackageName = readAppPackageName(opts.baseDirectory);
        invalidate();
    }

    /** TypeScript's own path convention: forward slashes, whatever the platform. */
    function toTsPath(p: string): string {
        return p.split(path.sep).join("/");
    }

    function readAppPackageName(baseDirectory: string): string | undefined {
        try {
            const json = JSON.parse(fs.readFileSync(path.join(baseDirectory, "package.json"), "utf8")) as
                { name?: string };
            return json.name;
        }
        catch {
            return undefined;   // an app with no package.json simply has no modules of its own to import
        }
    }

    export function isConfigured(): boolean {
        return options != null;
    }

    // ---- The configuration -------------------------------------------------------------------------------

    /** The configuration an eval that does not name its own gets. */
    export function imports(): EvalImports {
        return defaults;
    }

    /** Derive the default configuration, e.g. `EvalCompiler.configureImports(i => i.lazy(...))`. */
    export function configureImports(configure: (imports: EvalImports) => EvalImports): void {
        defaults = configure(defaults);
        EvalEmbedded.defaultImports = defaults;
        invalidate();
    }

    /**
     * Drop every cached compilation: a module joining the configuration can change what an
     * already-compiled — or already-failed — script means.
     *
     * The caches are WeakMaps keyed by configuration, so they cannot be cleared outright; an entry is
     * instead ignored once it predates the current generation.
     */
    export function invalidate(): void {
        virtualFiles.clear();
        typesBySpecifier.clear();
        sourceFileCache.clear();
        program = undefined;
        generation++;
    }

    let generation = 0;
    const generationOf = new WeakMap<object, number>();

    function fresh(key: object): boolean {
        return generationOf.get(key) === generation;
    }

    // ---- The compiler ------------------------------------------------------------------------------------

    export const compiler: IEvalCompiler = {
        compile<F>(code: string, scriptStartLine: number, imports: EvalImports,
            hoistedAt: readonly number[] = []):
            Promise<CompilationResult<F>> {

            let cache = resultCache.get(imports);
            if (cache == null || !fresh(imports)) {
                cache = new Map();
                resultCache.set(imports, cache);
                resolvedCache.delete(imports);
                generationOf.set(imports, generation);
            }

            const cached = cache.get(code);
            if (cached != null)
                return cached as Promise<CompilationResult<F>>;

            // The PROMISE is cached, not its value, so two entities holding the same script compile once
            // even when both are validated concurrently. A compilation ERROR is cached — it is a property
            // of the script, not a transient — but a THROW is evicted, since that one may well be.
            const promise = compileCore<F>(code, scriptStartLine, imports, hoistedAt)
                .catch((e: unknown) => {
                    cache.delete(code);
                    return { compilationErrors: e instanceof Error ? e.message : String(e) };
                });

            cache.set(code, promise as Promise<CompilationResult<unknown>>);
            return promise as Promise<CompilationResult<F>>;
        },
    };

    async function compileCore<F>(code: string, scriptStartLine: number, imports: EvalImports,
        hoistedAt: readonly number[]): Promise<CompilationResult<F>> {

        using _prof = HeavyProfiler.log("EvalCompile");

        if (options == null)
            return { compilationErrors: EvalMessage.NoCompilerIsConfigured.niceToString() };

        try {
            const resolved = resolveImports(imports);

            // The eager half is in scope in every script; the lazy half is written in only where a name
            // asks for it, which is what the second pass below discovers.
            let prefix = [...resolved.eagerLines];
            let checked = check(withPrefix(prefix, code), resolved);

            const implicit = implicitImports(checked, resolved);
            if (implicit.length > 0) {
                prefix = [...prefix, ...implicit];
                checked = check(withPrefix(prefix, code), resolved);
            }

            const text = withPrefix(prefix, code);
            const lines = { start: scriptStartLine + prefix.length, hoistedAt };

            const errors = formatDiagnostics(checked.diagnostics, text, lines);
            if (errors != null)
                return { compilationErrors: errors };

            const emitted = emit(text, lines);
            if (typeof emitted !== "string")
                return { compilationErrors: emitted.errors };

            return { algorithm: await evaluate<F>(emitted, resolved) };
        }
        catch (e) {
            return { compilationErrors: e instanceof Error ? e.message : String(e) };
        }
    }

    /**
     * Where the author's own text sits inside the generated module.
     *
     * `start` is the generated line the BODY begins at. `hoistedAt` says which script line each import
     * the author wrote at the top of the script came from: `wrap` lifted them above the signature
     * (TypeScript has no import inside a function), and they sit immediately before it.
     */
    interface ScriptLines { start: number; hoistedAt: readonly number[] }

    function withPrefix(prefix: readonly string[], code: string): string {
        return prefix.length === 0 ? code : prefix.join("\n") + "\n" + code;
    }

    function resolveImports(imports: EvalImports): ResolvedImports {
        const cached = resolvedCache.get(imports);
        if (cached != null && fresh(imports))
            return cached;

        const resolved = EvalModuleRegistry.resolve(imports, {
            baseDirectory: options!.baseDirectory,
            appPackageName,
            discoverDts,
        });

        // What the host needs to find an app module's `.d.ts` in the real compile that follows.
        for (const m of resolved.bySpecifier.values())
            if (m.typesPath != null)
                typesBySpecifier.set(m.specifier, m.typesPath);

        resolvedCache.set(imports, resolved);
        generationOf.set(imports, generation);
        return resolved;
    }

    // ---- 1. Type-check -----------------------------------------------------------------------------------

    interface Checked { source: ts.SourceFile; text: string; diagnostics: readonly ts.Diagnostic[] }

    function check(text: string, resolved: ResolvedImports): Checked {
        virtualFiles.set(virtualFile, text);

        const settings = { ...defaultCompilerOptions(), ...options!.compilerOptions };
        program = ts.createProgram({
            rootNames: [virtualFile],
            options: settings,
            host: createHost(settings),
            oldProgram: program,
        });

        const source = program.getSourceFile(virtualFile);
        if (source == null)
            throw new Error("Could not create the eval source file");

        const disallowed = disallowedImports(source, resolved);
        const named = new Set(disallowed.map(d => d.source));

        const diagnostics = [
            ...disallowed,
            ...program.getSyntacticDiagnostics(source),
            ...program.getSemanticDiagnostics(source),
        ].filter(d => d.category === ts.DiagnosticCategory.Error
            // "Cannot find module 'X'" about a module we have already refused by name is the same
            // complaint twice; the one that says WHY survives.
            && !(d.code === 2307 && named.has(moduleNameOf(d))));

        return { source, text, diagnostics };
    }

    /**
     * THE ALLOW-LIST. The configuration, not the file system, decides what a stored script may reach — so
     * every module specifier the script writes is checked by NAME here.
     *
     * Refusing to RESOLVE an unregistered specifier would be the obvious implementation and is not enough:
     * a module declared ambiently (`declare module "node:fs"`, which `@types/node` brings in through the
     * `.d.ts` graph whether or not the app asked for it) never reaches module resolution at all, and so
     * type-checked clean and failed only when the script first ran.
     *
     * Type-only imports count. They load nothing, but the configuration decides what is VISIBLE as much as
     * what is callable.
     */
    function disallowedImports(source: ts.SourceFile, resolved: ResolvedImports): ts.Diagnostic[] {
        const allowed = [...resolved.bySpecifier.keys()].sort().join(", ");
        const out: ts.Diagnostic[] = [];

        const report = (literal: ts.StringLiteralLike): void => {
            if (resolved.bySpecifier.has(literal.text))
                return;
            out.push({
                category: ts.DiagnosticCategory.Error,
                code: NOT_ALLOWED,
                file: source,
                start: literal.getStart(source),
                length: literal.getWidth(source),
                messageText: EvalMessage.TheModule0IsNotAllowed1.niceToString(literal.text, allowed),
                source: literal.text,
            });
        };

        const visit = (node: ts.Node): void => {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
                && node.moduleSpecifier != null && ts.isStringLiteralLike(node.moduleSpecifier))
                report(node.moduleSpecifier);
            else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
                && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]))
                report(node.arguments[0]);

            ts.forEachChild(node, visit);
        };
        visit(source);

        return out;
    }

    /** Not a TypeScript error code: this one is altea's own. */
    const NOT_ALLOWED = 9877;

    // ---- 2. Implicit imports -----------------------------------------------------------------------------

    /**
     * The import lines for the names the first check could not find, so a script can say `OrderEntity`
     * without importing it.
     *
     * The unresolved names come from TypeScript itself rather than from a walk of the AST: "cannot find
     * name" IS the question being asked, and the compiler answers it exactly — including in type position
     * and inside a generic argument, which a hand-written scan would get wrong.
     *
     * A name the script imports EXPLICITLY never reaches here, because it resolved. That is what makes an
     * explicit import the way to override the configuration when two modules export the same name.
     */
    function implicitImports(checked: Checked, resolved: ResolvedImports): string[] {

        // 2304 "Cannot find name 'X'", 2552 the same with a suggestion attached. The span IS the
        // identifier, so the name is read off the source rather than scraped out of the message.
        const names = new Set<string>();
        for (const d of checked.diagnostics)
            if ((d.code === 2304 || d.code === 2552) && d.start != null && d.length != null)
                names.add(checked.text.substr(d.start, d.length));

        const grouped = new Map<string, string[]>();
        for (const name of names) {
            const m = resolved.byName.get(name);
            if (m == null)
                continue;       // genuinely unknown: it stays the error it already is
            let group = grouped.get(m.specifier);
            if (group == null)
                grouped.set(m.specifier, group = []);
            group.push(name);
        }

        return [...grouped].map(([specifier, imported]) =>
            `import { ${imported.sort().join(", ")} } from "${specifier}";`);
    }

    // ---- Diagnostics -------------------------------------------------------------------------------------

    /** The specifier a "cannot find module" diagnostic is about, out of its own message. */
    function moduleNameOf(d: ts.Diagnostic): string | undefined {
        return /'([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, " "))?.[1];
    }

    /**
     * Diagnostics as the AUTHOR sees them: the line number is the one in the editor rather than the one in
     * the generated module, and the offending source line is quoted underneath. Shared by the type-check
     * pass and by the emit pass, whose quote-transformer errors arrive through `addDiagnostic`.
     */
    function formatDiagnostics(diagnostics: readonly ts.Diagnostic[], code: string,
        lines: ScriptLines): string | null {

        if (diagnostics.length === 0)
            return null;

        const text = code.split("\n");
        const formatted = diagnostics.map(d => {
            const generatedLine = d.file == null || d.start == null ? 0
                : d.file.getLineAndCharacterOfPosition(d.start).line;
            const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
            const scriptLine = authorLine(generatedLine, lines);
            const quoted = "\n" + (text[generatedLine] ?? "");

            return scriptLine == null
                // A generated line: the author has nothing to look at, so saying "line -2" would be worse
                // than saying nothing. This is a bug in the wrapper (or in the configuration), not in the
                // script.
                ? EvalMessage.InTheGeneratedWrapper0.niceToString(message) + quoted
                : EvalMessage.Line0_1.niceToString(scriptLine, message) + quoted;
        }).join("\n\n");

        return EvalMessage._0Errors.niceToString(diagnostics.length) + "\n" + formatted;
    }

    /**
     * The line the author sees, for a line of the generated module — or null when that line is not theirs.
     *
     * The body is the easy half. The hoisted imports are the other one: `wrap` lifted them out of the top
     * of the script and left blank lines behind, so they sit in the header, immediately before
     * the blank line and the signature.
     */
    function authorLine(generatedLine: number, lines: ScriptLines): number | null {
        if (generatedLine >= lines.start)
            return generatedLine - lines.start + 1;

        const index = generatedLine - (lines.start - 2 - lines.hoistedAt.length);
        return lines.hoistedAt[index] ?? null;
    }

    // ---- The compiler host -------------------------------------------------------------------------------

    const sourceFileCache = new Map<string, ts.SourceFile>();

    function createHost(settings: ts.CompilerOptions): ts.CompilerHost {
        const base = ts.createCompilerHost(settings, true);

        return {
            ...base,
            getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
                const virtual = virtualFiles.get(fileName);
                if (virtual != null)
                    return ts.createSourceFile(fileName, virtual, languageVersion, true);

                // Cache the real source files across compiles: the FIRST check pays for the whole `.d.ts`
                // graph the configuration pulls in; every later one only re-parses the generated file.
                const hit = sourceFileCache.get(fileName);
                if (hit != null)
                    return hit;

                const file = base.getSourceFile(fileName, languageVersion, onError, shouldCreate);
                if (file != null)
                    sourceFileCache.set(fileName, file);
                return file;
            },
            fileExists: fileName => virtualFiles.has(fileName) || base.fileExists(fileName),
            readFile: fileName => virtualFiles.get(fileName) ?? base.readFile(fileName),
            getCurrentDirectory: () => toTsPath(options!.baseDirectory),
            writeFile: () => { /* captured per emit */ },
            resolveModuleNameLiterals: (literals, containingFile, redirected, compilerOptions) =>
                literals.map(literal =>
                    resolveOne(literal.text, containingFile, compilerOptions, base, redirected)),
        };
    }

    function resolveOne(specifier: string, containingFile: string, compilerOptions: ts.CompilerOptions,
        host: ts.CompilerHost, redirected: ts.ResolvedProjectReference | undefined,
    ): ts.ResolvedModuleWithFailedLookupLocations {

        // A registered `typesPath` wins: it is how an APP points at its own modules, which TypeScript
        // cannot find on its own (an app is not installed as a package).
        const typesPath = typesBySpecifier.get(specifier);
        if (typesPath != null) {
            return {
                resolvedModule: {
                    resolvedFileName: typesPath,
                    extension: typesPath.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
                    isExternalLibraryImport: false,
                },
            };
        }


        return ts.resolveModuleName(specifier, containingFile, compilerOptions, host, undefined, redirected);
    }

    // ---- Module discovery --------------------------------------------------------------------------------

    /**
     * The exported names of each module, read from its `.d.ts` — which is what makes `"*"` see a name that
     * exists only as a TYPE. A module's runtime object cannot: an interface has no runtime counterpart, so
     * `Object.keys` silently omits exactly the names a script is most likely to write in a signature.
     *
     * The modules are pulled into a program of their own (one generated file importing all of them),
     * because the checker can only answer about a module it has actually loaded.
     */
    function discoverDts(modules: readonly ModuleImport[]): ReadonlyMap<string, readonly string[]> {
        // The type paths come straight from the modules being discovered: the configuration they will
        // belong to does not exist yet.
        for (const m of modules)
            if (m.typesPath != null)
                typesBySpecifier.set(m.specifier, m.typesPath);

        try {
            virtualFiles.set(discoveryFile, modules
                .map((m, i) => `import * as __m${i} from "${m.specifier}";`)
                .join("\n") + "\nexport { };\n");

            const settings = { ...defaultCompilerOptions(), ...options!.compilerOptions };
            const host = createHost(settings);
            const discovery = ts.createProgram({ rootNames: [discoveryFile], options: settings, host });
            const checker = discovery.getTypeChecker();

            const result = new Map<string, readonly string[]>();
            for (const m of modules) {
                const file = resolveOne(m.specifier, discoveryFile, settings, host, undefined)
                    .resolvedModule?.resolvedFileName;
                const source = file == null ? undefined : discovery.getSourceFile(file);
                const symbol = source == null ? undefined : checker.getSymbolAtLocation(source);

                result.set(m.specifier, symbol == null ? []
                    : checker.getExportsOfModule(symbol).map(s => s.getName()));
            }

            return result;
        }
        finally {
            virtualFiles.delete(discoveryFile);
        }
    }

    // ---- Declarations for the editor ---------------------------------------------------------------------

    /** What the EDITOR needs to resolve a name the same way the compiler does. */
    export interface ClientConfiguration {
        /** The import lines every script gets, which the editor must show above the author's own text. */
        eagerLines: readonly string[];
        /** Identifier -> module, so the editor can write the same implicit import the compiler would. */
        names: readonly (readonly [string, string])[];
    }

    /**
     * The lazy half as DATA. The editor runs the same implicit-import pass as the compiler — it has to, or
     * it would underline a name the server resolves perfectly well — and this is the map it runs it over.
     *
     * The declarations are NOT included: the map is small and the same for everyone, while a module's
     * `.d.ts` closure is neither, and the whole point of the lazy half is that most of it is never needed.
     */
    export function clientConfiguration(imports: EvalImports): ClientConfiguration {
        if (options == null)
            return { eagerLines: [], names: [] };

        const resolved = resolveImports(imports);
        return {
            eagerLines: resolved.eagerLines,
            names: [...resolved.byName].map(([name, m]) => [name, m.specifier] as const),
        };
    }

    /** One `.d.ts` the editor needs, at the path the editor must serve it from. */
    export interface DeclarationFile { path: string; content: string }

    /**
     * Every `.d.ts` the editor needs in order to check a script against `specifiers` — the TRANSITIVE
     * closure, because a declaration is useless without the ones it imports.
     *
     * The closure is not computed; it is OBSERVED. A program is built over the specifiers and asked which
     * source files it loaded, which is by definition exactly what the checker needed — a hand-rolled import
     * walk would have to re-implement module resolution to get the same answer, and would get it wrong.
     *
     * The paths are rewritten into a layout the editor's own resolver can walk (see {@link clientPath}),
     * and `have` is what the editor already holds, so a second module costs only what it adds.
     *
     * `imports` is RESOLVED first, not just read: resolution is what teaches the host where an app's own
     * `.d.ts` lives (an app is not a package, so nothing else can find it). Leaving that to whoever called
     * first made this quietly return nothing for every app module until something else had resolved.
     */
    export function declarationsFor(imports: EvalImports, specifiers: readonly string[],
        have: ReadonlySet<string> = new Set()): DeclarationFile[] {

        if (options == null || specifiers.length === 0)
            return [];

        resolveImports(imports);

        try {
            virtualFiles.set(discoveryFile, specifiers
                .map((s, i) => `import * as __m${i} from "${s}";`)
                .join("\n") + "\nexport { };\n");

            const settings = { ...defaultCompilerOptions(), ...options.compilerOptions };
            const program = ts.createProgram({
                rootNames: [discoveryFile],
                options: settings,
                host: createHost(settings),
            });

            const files: DeclarationFile[] = [];
            for (const source of program.getSourceFiles()) {
                if (!source.fileName.endsWith(".d.ts") || program.isSourceFileDefaultLibrary(source))
                    continue;       // the editor ships TypeScript's own libs

                const path = clientPath(source.fileName);
                if (path == null || have.has(path) || isAmbientPlumbing(path))
                    continue;

                files.push({ path, content: source.text });
            }

            return files;
        }
        finally {
            virtualFiles.delete(discoveryFile);
        }
    }

    /**
     * Where a declaration has to sit for the EDITOR's resolver to find it.
     *
     * The layout is chosen so that nothing has to be configured: classic node resolution, which is what a
     * browser-side TypeScript runs, looks for `<dir>/node_modules/<package>/<subpath>.d.ts` and walks up.
     * So a package's files go under `node_modules/<its name>/` with the `dist/` segment REMOVED — which is
     * what the package's `exports` map does on the server, and what makes `@altea/altea/data/basics` land on
     * the file it names. The relative imports inside the package still line up, because the prefix is
     * stripped uniformly.
     *
     * The APP's own files are not a package at all: they are addressed by relative path from the script
     * (`./app/orders/Order.data`), so they go beside it.
     */
    function clientPath(fileName: string): string | undefined {
        const file = toTsPath(fileName);
        const base = toTsPath(options!.baseDirectory);

        if (file.startsWith(base + "/dist/"))
            return CLIENT_ROOT + "/" + file.slice((base + "/dist/").length);

        const pkg = nearestPackage(path.dirname(fileName));
        if (pkg == null)
            return undefined;

        const relative = file.slice(toTsPath(pkg.dir).length + 1).replace(/^dist\//, "");
        return `${CLIENT_ROOT}/node_modules/${pkg.name}/${relative}`;
    }

    /** The directory the editor pretends the script lives in. Relative specifiers resolve from here. */
    export const CLIENT_ROOT = "file:///eval";

    /**
     * Declarations the editor is not sent.
     *
     * `@types/node` alone is 2.3 MB — FOUR FIFTHS of everything the eager closure pulls in — and a stored
     * script cannot reach a line of it: `node:fs` and friends are refused by the allow-list, so nothing an
     * author can write will ever name these types. They are in the closure only because altea's own server
     * declarations mention `Buffer` and `NodeJS.*` in passing, and `skipLibCheck` means their absence is
     * never reported. The same goes for the other `@types/*` packages (express's, and the `undici-types`
     * that `@types/node` drags along), which arrive the same way and are just as unreachable.
     *
     * Dropping them is what turns "ship the declarations to the browser" from megabytes into something a
     * page can simply load.
     */
    function isAmbientPlumbing(clientPath: string): boolean {
        return /\/node_modules\/(@types\/|undici-types\/)/.test(clientPath);
    }

    const packageOfDir = new Map<string, { name: string; dir: string } | undefined>();

    /** The nearest `package.json` with a name, walking up — the same rule node resolution itself uses. */
    function nearestPackage(from: string): { name: string; dir: string } | undefined {
        const cached = packageOfDir.get(from);
        if (cached !== undefined || packageOfDir.has(from))
            return cached;

        let found: { name: string; dir: string } | undefined;
        try {
            const json = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8")) as
                { name?: string };
            if (json.name != null)
                found = { name: json.name, dir: from };
        }
        catch { /* no package.json here */ }

        const parent = path.dirname(from);
        if (found == null && parent !== from)
            found = nearestPackage(parent);

        packageOfDir.set(from, found);
        return found;
    }

    // ---- 3. Emit through the program, with the quote transformer -----------------------------------------

    /**
     * The script is emitted BY THE PROGRAM rather than by `ts.transpileModule`, because the quote
     * transformer is type-driven: it decides whether an arrow function is assigned to a `Quoted<...>` by
     * asking the type checker, so it needs the very program the check pass just built. `transpileModule`
     * has no checker, which is why a query written in a stored script used to reach the runtime as a plain
     * lambda with no AST attached, and so could never lower to SQL.
     *
     * The output is ESM (the program's `module` setting); lowering it to CommonJS is a separate, purely
     * syntactic step in {@link evaluate}.
     *
     * A transformer error (an expression a quoted lambda cannot express) arrives through `addDiagnostic`
     * and is reported exactly like a type error, at the line the AUTHOR sees.
     */
    function emit(code: string, lines: ScriptLines): string | { errors: string } {
        const source = program!.getSourceFile(virtualFile)!;
        const transformerDiagnostics: ts.Diagnostic[] = [];

        // ts-patch hands a transformer the whole TransformerExtras; this one destructures just these two.
        const extras = { ts, addDiagnostic: (d: ts.Diagnostic) => transformerDiagnostics.push(d) };

        let output: string | undefined;
        const result = program!.emit(source,
            (fileName, text) => { if (fileName.endsWith(".js")) output = text; },
            undefined, false,
            { before: [quoteTransformer(program!, undefined, extras as unknown as TransformerExtras)] });

        const errors = formatDiagnostics(
            [...transformerDiagnostics, ...result.diagnostics]
                .filter(d => d.category === ts.DiagnosticCategory.Error),
            code, lines);

        if (errors != null)
            return { errors };

        if (output == null)
            return { errors: "The eval produced no JavaScript output" };

        return output;
    }

    // ---- 4. Run ------------------------------------------------------------------------------------------

    async function evaluate<F>(esm: string, resolved: ResolvedImports): Promise<F> {
        // ESM to CommonJS, so `require` can answer from the configuration. Purely syntactic (no
        // resolution, no checker), which is what `transpileModule` is genuinely good for.
        const js = ts.transpileModule(esm, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
                esModuleInterop: true,
            },
            fileName: virtualFile,
        }).outputText;

        // Load exactly what the emitted module asks for, and no more. An import used only in type position
        // was elided by the emit, so a script that merely NAMES an entity costs nothing at run time — which
        // is the whole of "lazy": the module graph a configuration describes is never loaded wholesale.
        const values = new Map<string, unknown>();
        for (const specifier of requiredSpecifiers(js)) {
            const m = resolved.bySpecifier.get(specifier);
            if (m == null)
                continue;       // refused at check time; `requireFn` says so if it somehow got this far
            values.set(specifier, await EvalModuleRegistry.loadValue(m, options!.baseDirectory));
        }

        const exports: Record<string, unknown> = {};
        const module = { exports };

        const requireFn = (specifier: string): unknown => {
            if (!values.has(specifier))
                throw new Error(`The eval imports '${specifier}', which the configuration does not allow. `
                    + `Add it with EvalLogic.configureImports, or import one of: `
                    + [...resolved.bySpecifier.keys()].sort().join(", "));
            return values.get(specifier);
        };

        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const factory = new Function("exports", "require", "module", "__filename", "__dirname", js) as
            (e: object, r: (s: string) => unknown, m: object, f: string, d: string) => void;

        factory(exports, requireFn, module, virtualFile, options!.baseDirectory);

        const algorithm = (module.exports as Record<string, unknown>)["default"];
        if (typeof algorithm !== "function")
            throw new Error("The eval's default export is not a function");

        return algorithm as F;
    }

    /** The specifiers the emitted CommonJS will actually ask `require` for. */
    function requiredSpecifiers(js: string): string[] {
        const found = new Set<string>();
        for (const m of js.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g))
            found.add(m[1]);
        return [...found];
    }

    /** Plugs this compiler into the isomorphic base (see data/Eval.ts's header). */
    export function install(): void {
        EvalEmbedded.compiler = compiler;
        EvalEmbedded.defaultImports = defaults;
    }
}
