import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Port of Signum.Dynamic's `DynamicLogic.CompileDynamicCode` — the half that turns GENERATED SOURCE into
// live types.
//
// Signum writes C# into a `CodeGen` directory, compiles it with Roslyn against the app's assemblies, loads
// the resulting assembly, and restarts the application so the schema is rebuilt with the new types in it.
// altea does the same three steps with the TypeScript compiler, and the one that needs saying is the
// middle one:
//
//   1. WRITE the generated `.ts` files into a CodeGen directory (readable, diffable, in source control if
//      the app wants — Signum's whole reason for generating source rather than building types in memory);
//   2. COMPILE them with `ts.createProgram` + `program.emit`, **with the quote-transformer applied as a
//      custom transformer**. This is what makes generated code a first-class altea citizen: the
//      transformer is what synthesises `@field({ typeName … })` from a type annotation, stamps
//      `__fileInfo`, rewrites `init()` / `registerEnum()` with their names, and turns a `@quoted` lambda
//      into the expression TREE the LINQ provider needs. Generated code that skipped it would compile and
//      then be invisible to reflection and unquotable in a query. Its factory takes a `ts.Program` and
//      returns an ordinary `ts.TransformerFactory`, so it composes here exactly as it does under `tspc`;
//   3. LOAD each emitted module so its top-level `registerType(...)` calls run, which is what puts the type
//      in the reflection registries.
//
// Divergences from Signum:
//  - Roslyn's `MetadataReference` list becomes ordinary module RESOLUTION: generated code imports
//    `@altea/altea/data/entity` and TypeScript finds it through the app's node_modules, so there is no list
//    to maintain. What an app must still say is where ITS OWN modules live, because an app is not installed
//    as a package — the `typesPaths` option, the same accommodation @altea/altea-eval documents.
//  - Signum compiles to an in-memory assembly and loads it into a fresh `AssemblyLoadContext`. There is no
//    JS counterpart and no need for one: a module here is a closure. The emitted `.js` is written to disk
//    beside its source (so a stack trace points at something real) and loaded with `import()`, which is
//    what makes it share the SAME module instances as the rest of the server — Node keys its ESM cache by
//    resolved URL, so the generated module's `@altea/altea/data/reflection` IS the one the process already
//    holds. A second copy would register the new type into registries nobody reads.
//  - the emit is ESM, exactly as the real build (`tspc`) emits it, and that is not a free choice: the
//    transformer SYNTHESISES import statements (for `field`, `registerType`, each Symbol class an
//    `init()` names), and TypeScript's CommonJS module transform ELIDES a synthesised import it cannot
//    tie back to a checker symbol — the generated module then loads and dies on `field is not defined`.
//    Emitting ESM leaves those imports verbatim, which is why it works under tspc and must work the same
//    way here.
//  - a compile failure is DATA, not an exception: the caller stores it on the row and the panel shows it,
//    exactly as Signum surfaces its Roslyn diagnostics.
//  - generated code runs IN PROCESS with the server's rights, as Signum's Roslyn-compiled C# does. There is
//    no sandbox; authoring is gated by the owning entity's Save operation and by DynamicPanelPermission.

/** What a caller hands over: one generated module. */
export interface GeneratedModule {
    /** Path RELATIVE to the code-gen directory, with extension — e.g. `"Entities/Customer.ts"`. */
    fileName: string;
    /** The TypeScript source, as generated. */
    content: string;
}

export interface DynamicCodeCompilerOptions {
    /**
     * Where the generated `.ts` (and emitted `.js`) live — Signum's `CodeGen` folder.
     *
     * Inside the APP's own directory, because two things resolve from it: `node_modules` (so generated code
     * can import `@altea/*`), and the transformer's `__fileInfo`, which walks up to the nearest
     * package.json — so a generated type reports the app as its owning package, which is what it is.
     */
    codeGenDirectory: string;
    /**
     * Where an app's OWN modules' types live, by import specifier — e.g.
     * `{ "eastwind/orders/Order.data": "D:/…/eastwind/orders/Order.data.ts" }`.
     *
     * Needed for the same reason @altea/altea-eval needs it: nothing depends on an app, so there is no
     * node_modules entry for TypeScript to follow. A `@altea/*` specifier needs no entry.
     */
    typesPaths?: { [specifier: string]: string };
    /**
     * Where a whole PACKAGE's sources live, by package name — e.g. `{ eastwind: "D:/…/eastwind" }`.
     *
     * The same accommodation as `typesPaths` and the one an APP actually needs: nothing depends on an
     * app, so TypeScript cannot resolve `eastwind/shippers/Shipper.data` — and listing every module by
     * hand is not a thing anyone would keep in step. A root maps the whole subtree at once.
     */
    typesRoots?: { [packageName: string]: string };
    /** Merged over the defaults, which mirror altea's `presets/base.json`. */
    compilerOptions?: ts.CompilerOptions;
}

export interface CompileError {
    /** The generated file, relative to the code-gen directory. */
    fileName: string;
    /** 1-based, as an author reads it. */
    line: number;
    message: string;
    /** The offending source line, quoted — Signum prints the same thing under each diagnostic. */
    sourceLine: string;
}

export interface DynamicCompilationResult {
    /** Empty when every module compiled AND loaded. */
    errors: CompileError[];
    /** The files written, relative to the code-gen directory — what the panel lists. */
    written: string[];
    /**
     * Each loaded module's namespace object, by the file name it was generated as.
     *
     * This is where the port gets SIMPLER than Signum: it finds the generated starter by loading the
     * assembly and searching its types for one called `CodeGenStarter`, then invoking a `Start` method
     * through reflection. A module's exports are the same thing, already in hand and typed.
     */
    modules: Map<string, Record<string, unknown>>;
}

export namespace DynamicCodeCompiler {

    let options: DynamicCodeCompilerOptions | undefined;

    /** Cached across compiles: the FIRST one pays for the whole `.d.ts` graph (Signum's MetadataReferences). */
    const sourceFileCache = new Map<string, ts.SourceFile>();

    export function configure(opts: DynamicCodeCompilerOptions): void {
        options = opts;
    }

    export function isConfigured(): boolean {
        return options != null;
    }

    /**
     * The import specifier a generated module should use for a type declared in `packageName`'s
     * `fileName` — the ONE place that decision lives, since every generator here needs it.
     *
     * A `@altea/*` package resolves as an ordinary bare specifier, through the app's node_modules. A
     * package configured via {@link DynamicCodeCompilerOptions.typesRoots} — i.e. the APP itself — does
     * NOT: TypeScript can be told where its types are, but the EMITTED JavaScript keeps whatever
     * specifier was written, and Node cannot resolve a bare `eastwind/...` because nothing installed it.
     * So such a specifier is emitted RELATIVE to the code-gen directory, which Node resolves fine
     * (extensionless, as altea's own compiled output already is — the register hook handles it).
     */
    export function specifierFor(packageName: string, fileName: string): string {
        assertConfigured();
        const withoutExtension = fileName.replace(/.tsx?$/, "");

        const root = options!.typesRoots?.[packageName];
        if (root == null)
            return packageName + "/" + withoutExtension;

        const relative = path.relative(options!.codeGenDirectory, path.join(root, withoutExtension));
        const forward = toTsPath(relative);
        return forward.startsWith(".") ? forward : "./" + forward;
    }

    export function codeGenDirectory(): string {
        assertConfigured();
        return options!.codeGenDirectory;
    }

    function assertConfigured(): void {
        if (options == null)
            throw new Error("DynamicCodeCompiler is not configured. Call DynamicCodeCompiler.configure({ codeGenDirectory }) "
                + "from the app's Starter, before DynamicLogic.start.");
    }

    /**
     * FORWARD slashes: TypeScript normalises every path it handles, so a Windows `path.join` result would
     * never match the file name a Program hands back to `getSourceFile`.
     */
    function toTsPath(p: string): string {
        return p.split(path.sep).join("/");
    }

    /**
     * Signum's `CompileDynamicCode`: write the generated modules, compile them (transformer applied), and
     * load them so their registrations run.
     *
     * Nothing is loaded unless EVERY module compiled — a half-registered schema is worse than none, and it
     * is what Signum's all-or-nothing assembly load gives.
     */
    export async function compileAndLoad(modules: GeneratedModule[]): Promise<DynamicCompilationResult> {
        assertConfigured();

        const dir = options!.codeGenDirectory;
        fs.mkdirSync(dir, { recursive: true });

        // 1. WRITE. Signum's CodeGen folder, and for the same reason: the source is the thing an author
        //    reads when a generated type misbehaves.
        const written: string[] = [];
        const contents = new Map<string, string>();
        for (const m of modules) {
            const abs = path.join(dir, m.fileName);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, m.content, "utf8");
            written.push(m.fileName);
            contents.set(toTsPath(abs), m.content);
        }

        const loaded = new Map<string, Record<string, unknown>>();

        if (modules.length === 0)
            return { errors: [], written, modules: loaded };

        // 2. COMPILE, with the quote-transformer in the emit pipeline.
        const settings: ts.CompilerOptions = {
            ...defaultCompilerOptions(),
            ...options!.compilerOptions,
            // ESM, as the real build emits — see the header on why this is not interchangeable.
            module: ts.ModuleKind.ESNext,
            noEmit: false,
        };

        const rootNames = [...contents.keys()];
        const program = ts.createProgram({
            rootNames,
            options: settings,
            host: createHost(settings, contents),
        });

        const errors: CompileError[] = [];
        for (const rootName of rootNames) {
            const source = program.getSourceFile(rootName);
            if (source == null) {
                errors.push({ fileName: relative(rootName), line: 0, message: "Could not read the generated file", sourceLine: "" });
                continue;
            }
            errors.push(...diagnosticsOf(program, source));
        }

        if (errors.length > 0)
            return { errors, written, modules: loaded };

        // 3. EMIT + LOAD, in the order the caller gave — a generated type may reference an earlier one.
        const emitted = new Map<string, string>();
        for (const rootName of rootNames) {
            const source = program.getSourceFile(rootName)!;
            const result = program.emit(source, (fileName, text) => { emitted.set(toTsPath(fileName), text); },
                undefined, false, transformers(program));

            errors.push(...result.diagnostics
                .filter(d => d.category === ts.DiagnosticCategory.Error)
                .map(d => toCompileError(d, contents)));
        }

        if (errors.length > 0)
            return { errors, written, modules: loaded };

        try {
            for (const [jsPath, text] of emitted) {
                fs.writeFileSync(jsPath, text, "utf8");
                loaded.set(relative(jsPath).replace(/.js$/, ".ts"), await loadModule(jsPath));
            }
        } catch (e) {
            // A throw here is a generated module failing at LOAD (a bad decorator argument, a duplicate
            // type name) — a compile result, not a server fault.
            errors.push({
                fileName: "", line: 0, sourceLine: "",
                message: e instanceof Error ? e.message : String(e),
            });
        }

        return { errors, written, modules: loaded };
    }

    /**
     * The quote-transformer, as `tspc` applies it.
     *
     * Its factory is `(program, pluginConfig, { ts, addDiagnostic })` — ts-patch's shape — so the two extras
     * are supplied here: the compiler instance (there must be exactly ONE, or the transformer's `ts.is*`
     * checks meet nodes from a different copy) and a diagnostic sink. Diagnostics the transformer raises are
     * surfaced through the emit result, so they reach the author like any other error.
     */
    function transformers(program: ts.Program): ts.CustomTransformers {
        // Required at call time, not at module load: the transformer is a devDependency of the workspace
        // and an app that never generates code should not need it resolvable.
        const factory = requireTransformerFactory();
        return { before: [factory(program, undefined, { ts, addDiagnostic: () => { /* surfaced by emit */ } })] };
    }

    /** Overridable so a host with a different build of the transformer can supply it. */
    export let requireTransformerFactory: () => (
        program: ts.Program,
        pluginConfig: unknown,
        extras: { ts: typeof ts; addDiagnostic: (d: ts.Diagnostic) => void },
    ) => ts.TransformerFactory<ts.SourceFile> = () => {
        // `createRequire`, not `require`: the workspace is ESM ("type": "module"), so a bare require is
        // undefined at runtime. Resolved from the CODE-GEN directory, i.e. through the app's own
        // node_modules — the same place the generated code's imports resolve from.
        const from = createRequire(path.join(options!.codeGenDirectory, "__resolve__.cjs"));
        const mod = from("quote-transformer") as { default?: unknown } | unknown;
        const fn = (mod as { default?: unknown }).default ?? mod;
        return fn as never;
    };

    function defaultCompilerOptions(): ts.CompilerOptions {
        // altea's `presets/base.json`, minus the project-reference machinery — the same list
        // @altea/altea-eval uses, for the same reason: generated code must be checked under the rules the
        // hand-written code is checked under.
        return {
            target: ts.ScriptTarget.ES2022,
            lib: ["lib.es2022.d.ts", "lib.esnext.disposable.d.ts"],
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            strict: true,
            strictPropertyInitialization: false,
            experimentalDecorators: true,
            esModuleInterop: true,
            skipLibCheck: true,
            types: [],
        };
    }

    function createHost(settings: ts.CompilerOptions, contents: Map<string, string>): ts.CompilerHost {
        const base = ts.createCompilerHost(settings, true);

        return {
            ...base,
            getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
                const own = contents.get(toTsPath(fileName));
                if (own != null)
                    return ts.createSourceFile(fileName, own, languageVersion, true);

                const hit = sourceFileCache.get(fileName);
                if (hit != null)
                    return hit;

                const file = base.getSourceFile(fileName, languageVersion, onError, shouldCreate);
                if (file != null)
                    sourceFileCache.set(fileName, file);
                return file;
            },
            fileExists: fileName => contents.has(toTsPath(fileName)) || base.fileExists(fileName),
            readFile: fileName => contents.get(toTsPath(fileName)) ?? base.readFile(fileName),
            getCurrentDirectory: () => toTsPath(options!.codeGenDirectory),
            // Emit is captured by the writeFile passed to program.emit, never by the host.
            writeFile: () => { /* see compileAndLoad */ },
            resolveModuleNameLiterals: (literals, containingFile, redirected, compilerOptions) =>
                literals.map(l => resolveOne(l.text, containingFile, compilerOptions, base, redirected)),
        };
    }

    function resolveOne(specifier: string, containingFile: string, compilerOptions: ts.CompilerOptions,
        host: ts.CompilerHost, redirected: ts.ResolvedProjectReference | undefined,
    ): ts.ResolvedModuleWithFailedLookupLocations {

        // An app's own module: TypeScript cannot find it (an app is not a package), so the app says where.
        // A per-package ROOT is tried first, since that is what an app configures; an exact path wins if
        // one was given for this specifier.
        const declared = options!.typesPaths?.[specifier] ?? resolveInRoots(specifier);
        if (declared != null) {
            return {
                resolvedModule: {
                    resolvedFileName: toTsPath(declared),
                    extension: declared.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
                    isExternalLibraryImport: false,
                },
            };
        }

        return ts.resolveModuleName(specifier, containingFile, compilerOptions, host, undefined, redirected);
    }

    /** `eastwind/shippers/Shipper.data` → `<root of "eastwind">/shippers/Shipper.data.ts`, if it exists. */
    function resolveInRoots(specifier: string): string | undefined {
        const roots = options!.typesRoots;
        if (roots == null)
            return undefined;

        for (const [packageName, root] of Object.entries(roots)) {
            if (specifier !== packageName && !specifier.startsWith(packageName + "/"))
                continue;

            const tail = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
            for (const candidate of [tail + ".ts", tail + ".tsx", tail + ".d.ts", tail + "/index.ts"]) {
                const full = path.join(root, candidate);
                if (fs.existsSync(full))
                    return full;
            }
        }

        return undefined;
    }

    function diagnosticsOf(program: ts.Program, source: ts.SourceFile): CompileError[] {
        return [
            ...program.getSyntacticDiagnostics(source),
            ...program.getSemanticDiagnostics(source),
        ]
            .filter(d => d.category === ts.DiagnosticCategory.Error)
            .map(d => toCompileError(d, undefined));
    }

    function toCompileError(d: ts.Diagnostic, contents: Map<string, string> | undefined): CompileError {
        const fileName = d.file == null ? "" : relative(d.file.fileName);
        const line = d.file == null || d.start == null ? 0
            : d.file.getLineAndCharacterOfPosition(d.start).line;
        const text = d.file?.text ?? (contents == null ? undefined : contents.get(toTsPath(d.file?.fileName ?? "")));
        return {
            fileName,
            line: line + 1,
            message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
            sourceLine: text?.split("\n")[line] ?? "",
        };
    }

    function relative(absolute: string): string {
        return toTsPath(path.relative(options!.codeGenDirectory, absolute));
    }

    /**
     * Load an emitted module so its top-level registrations run.
     *
     * `import()` rather than a hand-rolled loader, because sharing module IDENTITY with the rest of the
     * process is the whole requirement: a generated type must register itself into the reflection
     * registries the server reads, and Node's ESM cache is keyed by resolved URL — so the generated
     * module's `@altea/altea/data/reflection` is literally the same instance. It also means generated code
     * resolves specifiers exactly as the app does (through the app's node_modules and its register hook),
     * with no allow-list to keep in step.
     *
     * A cache-busting query is appended so a RECOMPILE within one process loads the new text; Node would
     * otherwise serve the first version for the life of the process. (Signum restarts instead, which is
     * also what altea does for a schema change — this only matters for a compile that is retried.)
     */
    async function loadModule(jsPath: string): Promise<Record<string, unknown>> {
        const url = pathToFileURL(jsPath).href + "?v=" + Date.now();
        return await import(url) as Record<string, unknown>;
    }
}
