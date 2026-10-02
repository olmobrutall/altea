import { reflect, setDefaultDatabaseSchema, MAX_SIZE } from "@altea/altea/data/reflection";
import { EmbeddedEntity, Entity, type Type } from "@altea/altea/data/entity";
import { tryGetOwnerEntity } from "@altea/altea/data/parentEntity";
import { stringLengthValidator, validate } from "@altea/altea/data/validators";
import { column } from "@altea/altea/data/decorators";
import { msg } from "@altea/altea/data/utils/localization";
import type { IntegrityCheckEnvironment } from "@altea/altea/data/reflection";
import { EvalImports } from "./EvalImports";

// A SCRIPT stored in the database, compiled to a callable on first use, cached by its generated source,
// and re-validated whenever it is saved.
//
// `F` is a FUNCTION TYPE: a subclass declares `EvalEmbedded<(e: OrderEntity, ctx: X) => boolean>` and the
// generated module's DEFAULT EXPORT is that function.
//
// Four things to know before editing:
//  - **The compiler is an INJECTED SEAM.** This module is isomorphic — the client renders the editor and
//    must not carry a compiler — so `EvalEmbedded.compiler` is a slot `server/EvalCompiler` fills. Unset
//    (i.e. in the browser) every compile answers "not compiled" and the script validator stands down,
//    which is why the validator only runs in the SERVER phases.
//  - **Compiling is ASYNC**, because a module a script names is loaded only when a script names it (see
//    data/EvalImports). So the callable is reached through `algorithm()` or `invoke(...)`, never a getter.
//  - **`owner()` climbs to the nearest ENTITY**, not to the immediate parent, because an eval may sit one
//    embedded down (`SubWorkflowEmbedded.subEntitiesEval`) and what it wants is still the entity carrying
//    it. An eval carried by a MODEL is left unbound, since a ModelEntity is not an Entity.
//  - **The compilation memo records the script it compiled**, so a hit only counts while that is still the
//    script on the instance — which is what covers a script REPLACED on an instance that had already
//    compiled, as the codec does when it overlays a POST onto a retrieved original. It lives in a
//    module-level WeakMap rather than a field, because a declared field would be reflected (and so
//    serialized, and schema-mapped) whatever we annotate it.
//
// Port of Signum.Eval's EvalEmbedded.cs — see port/Eval.md.

/** Exactly one of the two is set. */
export interface CompilationResult<F> {
    algorithm?: F;
    compilationErrors?: string;
}

/** The shape every eval's `F` has: the algorithm is a function, and the module's default export. */
export type EvalFunction = (...args: never[]) => unknown;

/** What `server/EvalCompiler` plugs into {@link EvalEmbedded.compiler}. */
export interface IEvalCompiler {
    /**
     * Compiles a whole TypeScript module whose default export is the algorithm. Cached by `code` per
     * configuration, so the same script text compiles once per process.
     *
     * `scriptStartLine` is how many lines of generated wrapper sit above the author's script, so a
     * diagnostic can be reported at the line the author sees. The compiler adds the import lines IT
     * generates to that count, since only it knows how many there were.
     *
     * `imports` is what the script may reach — and the cache key, since the same text means different
     * things under different configurations.
     *
     * `hoistedAt` is the script line each import the author wrote at the top came from, which {@link
     * EvalEmbedded.wrap} lifted above the signature, so a diagnostic in one can still be reported at the
     * line the author sees.
     */
    compile<F>(code: string, scriptStartLine: number, imports: EvalImports,
        hoistedAt?: readonly number[]):
        Promise<CompilationResult<F>>;
}

/**
 * The per-instance compilation. A WeakMap because a declared field would be reflected — and so serialized,
 * and schema-mapped — whatever we annotate it with; keyed by the instance, it behaves like an ignored one.
 *
 * It records the SCRIPT it was compiled from, which is what makes a stale entry impossible by
 * construction: the memo hits only while the script it was built for is still the one on the instance.
 * Same idea one level down, where the compiler keys its own cache by code.
 *
 * The PROMISE is held, not its value, so two callers racing to use the same eval compile it once.
 */
const results = new WeakMap<AnyEval, { script: string; result: Promise<CompilationResult<unknown>> }>();

type AnyEval = EvalEmbedded<EvalFunction>;

@reflect
export abstract class EvalEmbedded<F extends EvalFunction> extends EmbeddedEntity {

    /**
     * The stored source. Unbounded — the same shape as altea-dynamic's `DynamicCSSOverrideEntity.script`,
     * and Signum's `[DbType(Size = int.MaxValue)]`. The validator states no `max`, so the size has to be
     * said outright: a string column with no size at all takes the per-provider default of 200.
     *
     * The validator COMPILES and reports the errors on this very field, so a script that does not build
     * cannot be saved. Skipped in the "Client" phase — there is no compiler in the browser (see the
     * header).
     */
    @column({ size: MAX_SIZE })
    @stringLengthValidator({ min: 1, multiLine: true })
    @validate<EvalEmbedded<EvalFunction>>((e, _fi, env) => e.validateScript(env))
    script: string;

    // ---- The compiled algorithm ------------------------------------------------------------------------

    /** Compiles if necessary and THROWS when the script does not build. */
    async algorithm(): Promise<F> {
        const result = await this.compileIfNecessary();
        if (result?.compilationErrors != null)
            throw new Error(result.compilationErrors);
        if (result?.algorithm == null)
            throw new Error(EvalMessage.TheScriptHasNotBeenCompiled.niceToString());
        return result.algorithm;
    }

    /**
     * Compiles if necessary and CALLS the algorithm. What almost every caller wants, and the reason
     * `algorithm()` being async does not litter the call sites with a double await.
     */
    async invoke(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> {
        const algorithm = await this.algorithm() as (...a: Parameters<F>) => ReturnType<F>;
        return await algorithm(...args) as Awaited<ReturnType<F>>;
    }

    /** Has the script this instance CURRENTLY holds been compiled yet? */
    get compiled(): boolean {
        return results.get(this as AnyEval)?.script === this.script;
    }

    /**
     * Builds the module source and compiles it. A subclass writes the wrapper — the parameter types and
     * the return type — and hands it to {@link wrap}.
     */
    protected abstract compile(): Promise<CompilationResult<F>>;

    private compileIfNecessary(): Promise<CompilationResult<F>> | undefined {
        const memo = results.get(this as AnyEval);
        // A hit only counts while the script is the one it was built from — see `results`.
        if (memo != null && memo.script === this.script)
            return memo.result as Promise<CompilationResult<F>>;

        if ((this.script ?? "").trim() === "")
            return undefined;

        const result = this.compile();
        results.set(this as AnyEval, { script: this.script, result: result as Promise<CompilationResult<unknown>> });
        return result;
    }

    private async validateScript(env: IntegrityCheckEnvironment): Promise<string | null> {
        // No compiler in the browser, and nothing to say before the script is written.
        if (env === "Client" || EvalEmbedded.compiler == null || (this.script ?? "").trim() === "")
            return null;

        // An UNBOUND eval cannot be compiled, and that is not an error: it is how an eval carried by a MODEL
        // arrives (a ModelEntity is not an Entity, so the parent chain never reaches one). The real check runs
        // when the model is applied to its entity and that entity is saved.
        if (!this.isBound())
            return null;

        return (await this.compileIfNecessary())?.compilationErrors ?? null;
    }

    // ---- The wrapper -----------------------------------------------------------------------------------

    /**
     * Wraps the author's script in a module whose default export is the algorithm, and compiles it.
     *
     * A script with no `;` is treated as an EXPRESSION (`return … ;`).
     *
     * NOTHING is imported here. A name the wrapper or the script uses — the entity in the signature, a
     * query, an operation — is resolved by the compiler against the configuration: the eager half is
     * already in scope, and anything else is imported because the script named it (see EvalCompiler's
     * implicit-import pass). That is why a subclass states the parameter TYPES and nothing else.
     *
     * An author who needs to say it themselves — to pick between two modules exporting the same name —
     * writes an ordinary `import` at the top of the script, and {@link hoistImports} lifts it above the
     * signature, since TypeScript has no import inside a function.
     */
    protected wrap(options: {
        /** The generated function's parameter list, e.g. `"e: OrderEntity, ctx: WorkflowTransitionContext"`. */
        parameters: string;
        /**
         * The generated function's LOGICAL return type, e.g. `"boolean"`. When {@link isAsync} it is emitted
         * as `Promise<Awaited<…>>`, since TypeScript refuses any other return annotation on an async function.
         */
        returnType: string;
        /** `async`, when the author's script may `await`. */
        isAsync?: boolean;
        /** Verbatim import lines, for the rare case the configuration cannot say it. */
        imports?: string[];
        /**
         * What this eval kind may reach. Defaults to {@link EvalEmbedded.defaultImports} — an eval kind
         * overrides it when its scripts need more (or less) than everything else's.
         */
        evalImports?: EvalImports;
    }): Promise<CompilationResult<F>> {
        const compiler = EvalEmbedded.compiler;
        if (compiler == null)
            return Promise.resolve({ compilationErrors: EvalMessage.NoCompilerIsConfigured.niceToString() });

        const script = this.script.trim();
        const statements = script.includes(";") || script.includes("\n") ? script : `return ${script};`;
        const { imports: hoisted, at: hoistedAt, body } = hoistImports(statements);

        const header = [
            ...(options.imports ?? []),
            ...hoisted,
            "",
            `export default ${options.isAsync ? "async " : ""}function evaluate(${options.parameters}): `
                + (options.isAsync ? `Promise<Awaited<${options.returnType}>>` : options.returnType) + " {",
        ];

        const code = [...header, body, "}", ""].join("\n");
        return compiler.compile<F>(code, header.length,
            options.evalImports ?? EvalEmbedded.defaultImports, hoistedAt);
    }

    // ---- Injected seams --------------------------------------------------------------------------------

    /** Filled by `server/EvalCompiler.install()`. Null on the client (and before start). */
    static compiler: IEvalCompiler | null = null;

    /**
     * What an eval reaches when it does not name its own configuration. Filled by
     * `server/EvalCompiler.install()` and by every `configureImports` after it; the browser has no
     * registry, and no need for one (it never compiles).
     */
    static defaultImports: EvalImports = EvalImports.empty;

    /** Whether {@link owner} would answer — i.e. whether the graph holding this eval has been bound. */
    isBound(): boolean {
        return tryGetOwnerEntity(this, Entity) != null;
    }

    /**
     * The entity this eval hangs off, over the parent back-pointer (`@bindParent`, data/parentEntity). The
     * nearest ancestor of the type ASKED FOR, so an eval one embedded down still answers with the entity
     * that carries it (see the header) — and a mismatch is caught here rather than by an unchecked cast,
     * which is why `type` is a runtime argument.
     *
     * An INTERFACE has no runtime handle, so a caller wanting one passes `Entity` and casts.
     */
    owner<T extends Entity>(type: Type<T>): T {
        const owner = tryGetOwnerEntity(this, type);
        if (owner == null)
            throw new Error(EvalMessage.TheOwnerOf0HasNotBeenBound.niceToString(this.constructor.name));
        return owner;
    }
}

/**
 * The `import` lines the author wrote at the TOP of the script, lifted out so they can sit above the
 * generated signature — TypeScript has no import inside a function, and the script IS a function body.
 *
 * Each one is replaced by a BLANK line rather than removed, so every remaining line keeps the number it
 * has in the editor and a diagnostic in the body needs no adjustment. The line each one CAME from is
 * returned alongside, since blank lines between imports would otherwise put the count out of step with the
 * editor.
 *
 * Exported because the EDITOR has to make the same split to show the author what the compiler saw.
 *
 * Only a leading run counts, and only a complete single-line import: an `import` further down is a syntax
 * error either way, and saying so where the author wrote it beats silently moving it.
 */
export function hoistImports(script: string): { imports: string[]; at: number[]; body: string } {
    const lines = script.split("\n");
    const imports: string[] = [];
    const at: number[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "")
            continue;
        if (!/^import\b/.test(line) || !line.endsWith(";"))
            break;

        imports.push(line);
        at.push(i + 1);
        lines[i] = "";
    }

    return { imports, at, body: lines.join("\n") };
}

export const EvalMessage = {
    TheScriptHasNotBeenCompiled: msg("The script has not been compiled"),
    NoCompilerIsConfigured: msg("No compiler is configured (EvalLogic.start was not called)"),
    TheOwnerOf0HasNotBeenBound:
        msg("The owner of {0} has not been bound. Mark the field that holds it @bindParent."),
    _0Errors: msg("{0} Errors:"),
    Line0_1: msg("Line {0}: {1}"),
    TheWrapperIsGeneratedEditTheScriptBetweenTheBraces:
        msg("This wrapper is generated from the configuration and the signature. Edit the script between the braces."),
    InTheGeneratedWrapper0: msg("In the generated wrapper: {0}"),
    TheModule0IsNotAllowed1:
        msg("The module '{0}' is not allowed in a script. Allowed modules: {1}"),
};

// The messages the CHECK-EVALS surface uses. The panel PAGE itself is altea-dynamic's, which owns the
// admin pages.
export const EvalPanelMessage = {
    OpenErrors: msg(),
    CheckEvals: msg(),
    NoErrorsFound: msg("No errors found"),
    _0Found: msg("{0} found"),
    ExceptionChecking0: msg("Exception checking {0}"),
};

setDefaultDatabaseSchema("eval");
