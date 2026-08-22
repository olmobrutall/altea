import { reflect } from "@altea/altea/data/reflection";
import { EmbeddedEntity, Entity } from "@altea/altea/data/entity";
import { stringLengthValidator, fieldValidation } from "@altea/altea/data/decorators";
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
//  - **The owner is bound explicitly.** Signum marks the field `[BindParent]` and reaches
//    `GetParentEntity<T>()` inside `Compile()` — that is how a WorkflowConditionEval learns its
//    WorkflowCondition's `mainEntityType`. altea has no `[BindParent]`: an entity field is a plain property
//    with no setter to hook. So the OWNER binds it, through the two schema events it already has —
//    `sb.include(X).withEvals()` registers `preSaving` + `retrieved` handlers that call
//    `EvalEmbedded.bindOwner`. `owner()` throws if that was forgotten, so the mistake is loud.
//  - the compilation result and the bound owner live in module-level WeakMaps rather than `[Ignore]` fields:
//    a declared field would be reflected (and so serialized, and schema-mapped) whatever we annotate it.

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

const results = new WeakMap<EvalEmbedded<unknown>, CompilationResult<unknown>>();
const owners = new WeakMap<EvalEmbedded<unknown>, Entity>();

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
    @fieldValidation<EvalEmbedded<unknown>>((e, _fi, env) => e.validateScript(env))
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

    /** Signum's `Compiled` — has this instance's script been compiled (successfully or not) yet? */
    get compiled(): boolean {
        return results.has(this as EvalEmbedded<unknown>);
    }

    /** Signum's `Reset()` — forget the compilation, so the next read rebuilds it. */
    reset(): void {
        results.delete(this as EvalEmbedded<unknown>);
    }

    /**
     * Builds the module source and compiles it. A subclass writes the wrapper — the imports, the parameter
     * types and the return type — and hands it to {@link wrap}, exactly as Signum's `Compile()` overrides
     * build their generated class.
     */
    protected abstract compile(): CompilationResult<F>;

    private compileIfNecessary(): CompilationResult<F> | undefined {
        let result = results.get(this as EvalEmbedded<unknown>) as CompilationResult<F> | undefined;
        if (result == null && (this.script ?? "").trim() !== "") {
            result = this.compile();
            results.set(this as EvalEmbedded<unknown>, result as CompilationResult<unknown>);
        }
        return result;
    }

    private validateScript(env: IntegrityCheckEnvironment): string | null {
        // No compiler in the browser, and nothing to say before the script is written.
        if (env === "Client" || EvalEmbedded.compiler == null || (this.script ?? "").trim() === "")
            return null;

        // An UNBOUND eval cannot be compiled, and that is not an error: it is how an eval carried by a MODEL
        // arrives (a ModelEntity is never included, so nothing calls withEvals for it). The real check runs
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

    /**
     * The entity this eval hangs off — Signum's `[BindParent]` + `GetParentEntity<T>()`. Bound by
     * `sb.include(Owner).withEvals()`; see the header for why it is not automatic.
     */
    /** Whether {@link owner} would answer — i.e. whether `withEvals()` has bound this instance. */
    isBound(): boolean {
        return owners.has(this as EvalEmbedded<unknown>);
    }

    owner<T extends Entity>(): T {
        const owner = owners.get(this as EvalEmbedded<unknown>);
        if (owner == null)
            throw new Error(EvalMessage.TheOwnerOf0HasNotBeenBoundCallWithEvalsOnItsInclude
                .niceToString(this.constructor.name));
        return owner as T;
    }

    /** Sets the owner. Called by the `withEvals()` schema events, and by any code that builds an eval graph
     *  by hand and wants to compile it before saving. */
    static bindOwner(evalEmbedded: EvalEmbedded<unknown>, owner: Entity): void {
        owners.set(evalEmbedded, owner);
    }
}

export const EvalMessage = {
    TheScriptHasNotBeenCompiled: msg("The script has not been compiled"),
    NoCompilerIsConfigured: msg("No compiler is configured (EvalLogic.start was not called)"),
    TheOwnerOf0HasNotBeenBoundCallWithEvalsOnItsInclude:
        msg("The owner of {0} has not been bound. Call `.withEvals()` on its include."),
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
