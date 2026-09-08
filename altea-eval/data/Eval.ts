import { reflect, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { EmbeddedEntity, Entity, type Type } from "@altea/altea/data/entity";
import { tryGetOwnerEntity } from "@altea/altea/data/parentEntity";
import { stringLengthValidator, validate } from "@altea/altea/data/validators";
import { msg } from "@altea/altea/data/utils/localization";
import type { IntegrityCheckEnvironment } from "@altea/altea/data/reflection";

// Port of Signum.Eval's EvalEmbedded.cs — a SCRIPT stored in the database, compiled to a callable on
// first use, cached by its generated source, and re-validated whenever it is saved.
//
// Signum stores C# and compiles it with Roslyn; altea stores TYPESCRIPT and compiles it with the
// TypeScript compiler (`typescript` is already a build dependency, so the "compiler service" Signum needs
// Roslyn for is simply there). What that changes:
//
//  - **`T` is a FUNCTION TYPE, not an interface.** Signum generates a class implementing `IXEvaluator` and
//    instantiates it; a TS module's natural unit is a function, so a subclass declares
//    `EvalEmbedded<(e: OrderEntity, ctx: X) => boolean>` and the generated source's DEFAULT EXPORT is that
//    function. The `EvaluateUntyped` shim Signum's generated class needs (to widen the typed parameter back
//    to the interface's) disappears with it — the wrapper's parameter is simply typed, and the CALLER is the
//    one holding the untyped value.
//  - **What a script may reach is a MODULE REGISTRY, not a namespace list.** Signum's `EvalLogic.Namespaces`
//    + `AssemblyTypes` become `EvalLogic.registerModule(specifier, value)`: the same specifier is what the
//    generated code imports (so the TYPE side resolves) and what the runtime `require` answers (so the VALUE
//    side is exactly what the app allowed). An unregistered import fails to run even if it type-checks.
//  - **The compiler is an INJECTED SEAM.** This module is isomorphic — the client renders the editor and
//    must not carry a compiler — so `EvalEmbedded.compiler` is a slot that `server/EvalCompiler` fills.
//    Unset (i.e. in the browser) every compile answers "not compiled", and the script validator stands down,
//    which is why the validator only runs in the SERVER phases.
//  - **The owner comes from `@bindParent`**, as in Signum: the field that holds an eval is marked, and
//    `owner()` reads the back-pointer — which is how a WorkflowConditionEval learns its
//    WorkflowCondition's `mainEntityType`. This module used to keep a private WeakMap of owners, bound by
//    a `sb.include(X)` schema-event pair, because altea had no parent infrastructure; it has
//    one now (data/parentEntity), and that generalised copy is what this uses.
//  - **There is no `Reset()` and no `withEvals()`.** Signum needs `Reset()` because it drops the cached
//    compilation from the `Script` setter, and altea has no setters — which is what `withEvals()` used to
//    stand in for, resetting on the `retrieved` schema event. Both are gone: the memo records the script
//    it compiled, so a hit only counts while that is still the script on the instance. That also covers
//    the case the retrieve hook never did — a script REPLACED on an instance that had already compiled,
//    which is what the codec does when it overlays a POST onto a retrieved original.
//  - **`owner()` climbs to the nearest ENTITY**, not to the immediate parent, because an eval may sit one
//    embedded down (`SubWorkflowEmbedded.subEntitiesEval`) and what it wants is still the entity carrying
//    it — Signum reaches the same place with a two-level `GetParentEntity` climb. It also keeps an eval
//    carried by a MODEL unbound, since a ModelEntity is not an Entity, which is the documented behaviour.
//  - the compilation result lives in a module-level WeakMap rather than an `[Ignore]` field: a declared
//    field would be reflected (and so serialized, and schema-mapped) whatever we annotate it.

/** Signum's `EvalEmbedded<T>.CompilationResult`. Exactly one of the two is set. */
export interface CompilationResult<F> {
    algorithm?: F;
    compilationErrors?: string;
}

/** What `server/EvalCompiler` plugs into {@link EvalEmbedded.compiler}. */
export interface IEvalCompiler {
    /**
     * Compiles a whole TypeScript module whose default export is the algorithm. Cached by `code`, so the
     * same script text compiles once per process (Signum's static `resultCache`).
     *
     * `scriptStartLine` is how many lines of generated preamble sit above the author's script, so a
     * diagnostic can be reported at the line the author sees.
     */
    compile<F>(code: string, scriptStartLine: number): CompilationResult<F>;
}

/**
 * The per-instance compilation, Signum's `[Ignore, NonSerialized] CompilationResult? compilationResult`.
 * A WeakMap because a declared field would be reflected — and so serialized, and schema-mapped —
 * whatever we annotate it with; keyed by the instance, it behaves exactly like that ignored field.
 *
 * It records the SCRIPT it was compiled from, and that is what replaces Signum`s `Reset()`. Signum drops
 * the compilation from the `Script` SETTER (`if (Set(ref script, value)) Reset();`); altea has no setters,
 * so a stale entry is instead impossible by construction — the memo hits only while the script it was
 * built for is still the one on the instance. Same idea one level down, where the compiler keys its own
 * cache by code (Signum's static `resultCache`).
 */
const results = new WeakMap<EvalEmbedded<unknown>, { script: string; result: CompilationResult<unknown> }>();

@reflect
export abstract class EvalEmbedded<F> extends EmbeddedEntity {

    /**
     * The stored source. Unbounded (no `max`) — the same shape as altea-dynamic's
     * `DynamicCSSOverrideEntity.script`, which is Signum's `[DbType(Size = int.MaxValue)]`.
     *
     * The validator is Signum's `PropertyValidation(pi == nameof(Script))`: it COMPILES and reports the
     * errors on this very field, so a script that does not build cannot be saved. Skipped in the "Client"
     * phase — there is no compiler in the browser (see the header).
     */
    @stringLengthValidator({ min: 1, multiLine: true })
    @validate<EvalEmbedded<unknown>>((e, _fi, env) => e.validateScript(env))
    script: string;

    // ---- The compiled algorithm ------------------------------------------------------------------------

    /** Signum's `Algorithm` — compiles if necessary and THROWS when the script does not build. */
    get algorithm(): F {
        const result = this.compileIfNecessary();
        if (result?.compilationErrors != null)
            throw new Error(result.compilationErrors);
        if (result?.algorithm == null)
            throw new Error(EvalMessage.TheScriptHasNotBeenCompiled.niceToString());
        return result.algorithm;
    }

    /** Signum's `Compiled` — has the script this instance CURRENTLY holds been compiled yet? */
    get compiled(): boolean {
        return results.get(this as EvalEmbedded<unknown>)?.script === this.script;
    }

    /**
     * Builds the module source and compiles it. A subclass writes the wrapper — the imports, the parameter
     * types and the return type — and hands it to {@link wrap}, exactly as Signum's `Compile()` overrides
     * build their generated class.
     */
    protected abstract compile(): CompilationResult<F>;

    private compileIfNecessary(): CompilationResult<F> | undefined {
        const memo = results.get(this as EvalEmbedded<unknown>);
        // A hit only counts while the script is the one it was built from — see `results`.
        if (memo != null && memo.script === this.script)
            return memo.result as CompilationResult<F>;

        if ((this.script ?? "").trim() === "")
            return undefined;

        const result = this.compile();
        results.set(this as EvalEmbedded<unknown>, { script: this.script, result: result as CompilationResult<unknown> });
        return result;
    }

    private validateScript(env: IntegrityCheckEnvironment): string | null {
        // No compiler in the browser, and nothing to say before the script is written.
        if (env === "Client" || EvalEmbedded.compiler == null || (this.script ?? "").trim() === "")
            return null;

        // An UNBOUND eval cannot be compiled, and that is not an error: it is how an eval carried by a MODEL
        // arrives (a ModelEntity is not an Entity, so the parent chain never reaches one). The real check runs
        // when the model is applied to its entity and that entity is saved.
        if (!this.isBound())
            return null;

        return this.compileIfNecessary()?.compilationErrors ?? null;
    }

    // ---- The wrapper -----------------------------------------------------------------------------------

    /**
     * Wraps the author's script in a module whose default export is the algorithm, and compiles it.
     *
     * Signum's two conveniences are kept: a script with no `;` is treated as an EXPRESSION (`return … ;`),
     * and the app's global preamble (`EvalLogic.preamble`, Signum's `GetUsingNamespaces()`) is prepended so
     * the common API is in scope without the author importing anything.
     */
    protected wrap(options: {
        /**
         * TYPE names the generated wrapper needs in scope, resolved to `import type { X } from "…"` through
         * {@link importFor} — i.e. through the module registry, so an eval can only name a type the app
         * allowed. This is where Signum writes a fully-qualified C# type name and relies on its `using` list.
         */
        importTypes?: string[];
        /** Verbatim import lines, for the rare case a name is not enough. */
        imports?: string[];
        /** The generated function's parameter list, e.g. `"e: OrderEntity, ctx: WorkflowTransitionContext"`. */
        parameters: string;
        /**
         * The generated function's LOGICAL return type, e.g. `"boolean"`. When {@link isAsync} it is emitted
         * as `Promise<Awaited<…>>`, since TypeScript refuses any other return annotation on an async function.
         */
        returnType: string;
        /** `async`, when the author's script may `await`. */
        isAsync?: boolean;
    }): CompilationResult<F> {
        const compiler = EvalEmbedded.compiler;
        if (compiler == null)
            return { compilationErrors: EvalMessage.NoCompilerIsConfigured.niceToString() };

        const script = this.script.trim();
        const body = script.includes(";") || script.includes("\n") ? script : `return ${script};`;

        const typeImports = (options.importTypes ?? [])
            .map(name => EvalEmbedded.importFor(name)
                ?? `// WARNING: no registered module exports '${name}'`);

        const preamble = [...EvalEmbedded.preamble, ...typeImports, ...(options.imports ?? [])];
        const header = [
            ...preamble,
            "",
            `export default ${options.isAsync ? "async " : ""}function evaluate(${options.parameters}): `
                + (options.isAsync ? `Promise<Awaited<${options.returnType}>>` : options.returnType) + " {",
        ];

        const code = [...header, body, "}", ""].join("\n");
        return compiler.compile<F>(code, header.length);
    }

    // ---- Injected seams --------------------------------------------------------------------------------

    /** Filled by `server/EvalCompiler.install()`. Null on the client (and before start). */
    static compiler: IEvalCompiler | null = null;

    /** The import lines every generated eval gets (Signum's `EvalLogic.GetUsingNamespaces()`). */
    static preamble: string[] = [];

    /**
     * Type name → the `import type` line that brings it into scope, or undefined when no registered module
     * exports it. Filled by `server/EvalCompiler.install()`; the browser has no registry, and no need for
     * one (it never compiles).
     */
    static importFor: (typeName: string) => string | undefined = () => undefined;

    /** Whether {@link owner} would answer — i.e. whether the graph holding this eval has been bound. */
    isBound(): boolean {
        return tryGetOwnerEntity(this, Entity) != null;
    }

    /**
     * The entity this eval hangs off — Signum's `[BindParent]` + `GetParentEntity<T>()`, over altea's
     * parent back-pointer (data/parentEntity). The nearest ancestor of the type ASKED FOR, so an eval one
     * embedded down still answers with the entity that carries it (see the header) and a mismatch is
     * caught here rather than by an unchecked cast — `type` is a runtime argument for that reason.
     *
     * An INTERFACE has no runtime handle, so a caller wanting one passes `Entity` and casts, which is what
     * Signum's own `TryGetParentEntity<Entity>()! as IHasEntityType` does.
     */
    owner<T extends Entity>(type: Type<T>): T {
        const owner = tryGetOwnerEntity(this, type);
        if (owner == null)
            throw new Error(EvalMessage.TheOwnerOf0HasNotBeenBound.niceToString(this.constructor.name));
        return owner;
    }
}

export const EvalMessage = {
    TheScriptHasNotBeenCompiled: msg("The script has not been compiled"),
    NoCompilerIsConfigured: msg("No compiler is configured (EvalLogic.start was not called)"),
    TheOwnerOf0HasNotBeenBound:
        msg("The owner of {0} has not been bound. Mark the field that holds it @bindParent."),
    _0Errors: msg("{0} Errors:"),
    Line0_1: msg("Line {0}: {1}"),
};

// Signum's EvalPanelMessage. `DynamicPanel` / the panel page itself is altea-dynamic's (it owns the admin
// pages); these are the messages the CHECK-EVALS surface uses.
export const EvalPanelMessage = {
    OpenErrors: msg(),
    CheckEvals: msg(),
    NoErrorsFound: msg("No errors found"),
    _0Found: msg("{0} found"),
    ExceptionChecking0: msg("Exception checking {0}"),
};

// The database schema this package's tables live in — altea's counterpart of Signum's
// `[assembly: AssemblySchemaName("eval")]`. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("eval");
