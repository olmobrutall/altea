import path from "node:path";
import ts from "typescript";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { EvalEmbedded, EvalMessage, type CompilationResult, type IEvalCompiler } from "../data/Eval";

// Compiling a stored script is TWO passes:
//
//   1. TYPE-CHECK the generated module with `ts.createProgram` over the app's own compilerOptions, so an
//      author gets real diagnostics ("Property 'foo' does not exist on type 'OrderEntity'") against the
//      real `.d.ts` of every package the app allowed.
//   2. TRANSPILE it to CommonJS (`ts.transpileModule`, which does no resolution) and run it with
//      `new Function(exports, require, module, …)`, where `require` answers ONLY from the module registry.
//
// The registry is SINGLE-SIDED: the same specifier is what generated code imports (so the TYPE resolves)
// and what `require` hands back (so the VALUE is exactly what the app allowed). **An import the app did not
// register fails at run time even if it type-checks against node_modules** — which is the point.
//
// Nothing is ever unloaded (a module here is a closure, not a loaded assembly), so the per-code cache below
// is what keeps that bounded.
//
// A compiled script runs IN PROCESS with the same rights as the rest of the server. Authoring one is gated
// by the owning entity's Save operation and by `EvalPanelPermission`; there is no sandbox, and pretending
// otherwise would be worse than saying so.
//
// Port of the Roslyn half of Signum.Eval's EvalEmbedded.Compile — see docs/port/Eval.md.

/** One module a stored script may import. */
interface RegisteredModule {
    /** The already-imported module object `require` answers with. */
    value: unknown;
    /**
     * Where the TYPES live, when TypeScript cannot find them on its own. `@altea/*` packages resolve through
     * their `exports` map without help; an APP's own modules usually need this, because an app is not
     * installed as a package (nothing depends on it, so there is no node_modules entry for it).
     */
    typesPath?: string;
    /**
     * Names this module exports as TYPES ONLY (an interface, a type alias). {@link specifierExporting} finds a
     * name by looking at the imported module's own properties, which a type never has — so a name a generated
     * wrapper needs but that has no runtime counterpart (altea-workflow's `ICaseMainEntity`) is declared here.
     */
    typeNames?: string[];
}

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

    const modules = new Map<string, RegisteredModule>();
    const resultCache = new Map<string, CompilationResult<unknown>>();

    let options: EvalCompilerOptions | undefined;
    let program: ts.Program | undefined;

    // The generated module's path. Inside `baseDirectory` so `@altea/…` resolves through the app's
    // node_modules, and named so it can never collide with a real file.
    let virtualFile = "";
    let virtualContent = "";

    /**
     * Defaults mirroring altea/tsconfig.base.json — the same dialect every package is written in, so a
     * script reads like the rest of the codebase. `skipLibCheck` and `noEmit` keep the check to the ONE file
     * that matters; `types: []` keeps `@types/node` out unless the app asks for it.
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
            noEmit: true,
            types: [],
        };
    }

    export function configure(opts: EvalCompilerOptions): void {
        options = opts;
        // FORWARD slashes: TypeScript normalises every path it handles, so a Windows `path.join` result
        // would never match the file name the program hands back to `getSourceFile`.
        virtualFile = toTsPath(path.join(opts.baseDirectory, "__altea_eval__.ts"));
        invalidate();
    }

    /** TypeScript's own path convention: forward slashes, whatever the platform. */
    function toTsPath(p: string): string {
        return p.split(path.sep).join("/");
    }

    export function isConfigured(): boolean {
        return options != null;
    }

    /** Allow a module in stored scripts. */
    export function registerModule(specifier: string, value: unknown,
        moduleOptions?: { typesPath?: string; typeNames?: string[] }): void {

        modules.set(specifier, { value, typesPath: moduleOptions?.typesPath, typeNames: moduleOptions?.typeNames });
        // A new module can change what an already-failed script means, so the cache and the program go.
        invalidate();
    }

    export function registeredModules(): string[] {
        return [...modules.keys()].sort();
    }

    /** Drop every cached compilation: a registered module changing can change what a script means. */
    export function invalidate(): void {
        resultCache.clear();
        program = undefined;
    }

    /**
     * Which registered module exports `name`, so a generated wrapper can import a type by NAME alone
     * rather than having to know which module it lives in.
     */
    export function specifierExporting(name: string): string | undefined {
        for (const [specifier, m] of modules) {
            if (m.value != null && Object.hasOwn(m.value as object, name))
                return specifier;
            if (m.typeNames?.includes(name))
                return specifier;
        }
        return undefined;
    }

    /** `import type { Name } from "…"` for a registered type, or undefined when nothing exports it. */
    export function importLineFor(name: string): string | undefined {
        const specifier = specifierExporting(name);
        return specifier == null ? undefined : `import type { ${name} } from "${specifier}";`;
    }

    // ---- The compiler ------------------------------------------------------------------------------------

    export const compiler: IEvalCompiler = {
        compile<F>(code: string, scriptStartLine: number): CompilationResult<F> {
            const cached = resultCache.get(code);
            if (cached != null)
                return cached as CompilationResult<F>;

            const result = compileCore<F>(code, scriptStartLine);
            resultCache.set(code, result as CompilationResult<unknown>);
            return result;
        },
    };

    function compileCore<F>(code: string, scriptStartLine: number): CompilationResult<F> {
        using _prof = HeavyProfiler.log("EvalCompile");

        if (options == null)
            return { compilationErrors: EvalMessage.NoCompilerIsConfigured.niceToString() };

        try {
            const errors = check(code, scriptStartLine);
            if (errors != null)
                return { compilationErrors: errors };

            return { algorithm: evaluate<F>(code) };
        }
        catch (e) {
            return { compilationErrors: e instanceof Error ? e.message : String(e) };
        }
    }

    // ---- 1. Type-check -----------------------------------------------------------------------------------

    function check(code: string, scriptStartLine: number): string | null {
        virtualContent = code;

        const settings = { ...defaultCompilerOptions(), ...options!.compilerOptions };
        program = ts.createProgram({
            rootNames: [virtualFile],
            options: settings,
            host: createHost(settings),
            oldProgram: program,
        });

        const source = program.getSourceFile(virtualFile);
        if (source == null)
            return "Could not create the eval source file";

        const diagnostics = [
            ...program.getSyntacticDiagnostics(source),
            ...program.getSemanticDiagnostics(source),
        ].filter(d => d.category === ts.DiagnosticCategory.Error);

        if (diagnostics.length === 0)
            return null;

        // The offending source line is quoted underneath, and the line number is the one the AUTHOR sees —
        // relative to the script rather than to the generated wrapper.
        const lines = code.split("\n");
        const formatted = diagnostics.map(d => {
            const generatedLine = d.file == null || d.start == null ? 0
                : d.file.getLineAndCharacterOfPosition(d.start).line;
            const scriptLine = generatedLine - scriptStartLine + 1;
            const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
            return EvalMessage.Line0_1.niceToString(scriptLine, message) + "\n" + (lines[generatedLine] ?? "");
        }).join("\n\n");

        return EvalMessage._0Errors.niceToString(diagnostics.length) + "\n" + formatted;
    }

    function createHost(settings: ts.CompilerOptions): ts.CompilerHost {
        const base = ts.createCompilerHost(settings, true);

        // Cache the real source files across compiles: the FIRST check pays for the whole `.d.ts` graph the
        // registered modules pull in; every later one only re-parses the virtual file.
        const cache = sourceFileCache;

        return {
            ...base,
            getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
                if (fileName === virtualFile)
                    return ts.createSourceFile(fileName, virtualContent, languageVersion, true);

                const hit = cache.get(fileName);
                if (hit != null)
                    return hit;

                const file = base.getSourceFile(fileName, languageVersion, onError, shouldCreate);
                if (file != null)
                    cache.set(fileName, file);
                return file;
            },
            fileExists: fileName => fileName === virtualFile || base.fileExists(fileName),
            readFile: fileName => fileName === virtualFile ? virtualContent : base.readFile(fileName),
            getCurrentDirectory: () => toTsPath(options!.baseDirectory),
            writeFile: () => { /* noEmit */ },
            resolveModuleNameLiterals: (literals, containingFile, redirected, compilerOptions) =>
                literals.map(literal => resolveOne(literal.text, containingFile, compilerOptions, base, redirected)),
        };
    }

    const sourceFileCache = new Map<string, ts.SourceFile>();

    function resolveOne(specifier: string, containingFile: string, compilerOptions: ts.CompilerOptions,
        host: ts.CompilerHost, redirected: ts.ResolvedProjectReference | undefined,
    ): ts.ResolvedModuleWithFailedLookupLocations {

        // A registered `typesPath` wins: it is how an APP points at its own modules, which TypeScript cannot
        // find on its own (an app is not installed as a package).
        const registered = modules.get(specifier);
        if (registered?.typesPath != null) {
            return {
                resolvedModule: {
                    resolvedFileName: registered.typesPath,
                    extension: registered.typesPath.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
                    isExternalLibraryImport: false,
                },
            };
        }

        return ts.resolveModuleName(specifier, containingFile, compilerOptions, host, undefined, redirected);
    }

    // ---- 2. Transpile + run ------------------------------------------------------------------------------

    function evaluate<F>(code: string): F {
        const js = ts.transpileModule(code, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
                esModuleInterop: true,
                experimentalDecorators: true,
            },
            fileName: virtualFile,
        }).outputText;

        const exports: Record<string, unknown> = {};
        const module = { exports };

        const requireFn = (specifier: string): unknown => {
            const registered = modules.get(specifier);
            if (registered == null)
                throw new Error(`The eval imports '${specifier}', which is not a registered module. `
                    + `Allow it with EvalLogic.registerModule, or import one of: `
                    + registeredModules().join(", "));
            return registered.value;
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

    /** Plugs this compiler into the isomorphic base (see data/Eval.ts's header). */
    export function install(): void {
        EvalEmbedded.compiler = compiler;
        EvalEmbedded.importFor = importLineFor;
    }
}
