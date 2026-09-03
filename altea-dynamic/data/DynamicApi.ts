import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, stringLengthValidator, quoted } from "@altea/altea/data/decorators";
import type { ConstructSymbol, From, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { EvalEmbedded, type CompilationResult } from "@altea/altea-eval/data/Eval";

// Port of Signum.Dynamic's Controllers/DynamicApi.cs — an HTTP endpoint written from the running
// application.
//
// An EVAL, as in Signum. The one real reshaping is what the script IS:
//
//  - Signum's script is the BODY OF A CONTROLLER CLASS: it declares `[HttpGet]` action methods, and the
//    generated wrapper makes the class derive from `ControllerBase`, so ASP.NET's routing discovers them.
//    Its `IDynamicApiEvaluator.DummyEvaluate()` exists only because an EvalEmbedded needs SOME member to
//    call, and a controller has no natural entry point.
//  - altea has no controllers: a route is registered on a `WebBuilder` (`ws.get(path, meta, handler)`). So
//    the script is a FUNCTION THAT REGISTERS ROUTES, and it has a real entry point — which retires
//    `DummyEvaluate` entirely.
//
// The routes are (re)registered when the module starts, which is why a changed script needs a restart to
// take effect — the same as Signum, whose controller assembly is loaded once.
//
// `DisabledMixin` is not ported (see data/DynamicValidation), so `disabled` is a plain field with Signum's
// column name.

/**
 * The function a DynamicApi's script becomes: given the app's route builder, register endpoints.
 *
 * Deliberately loose. The parameter really is a `WebBuilder`, and the generated WRAPPER says so
 * (`parameters: "ws: WebBuilder"` below) — which is what makes the author's script type-check against the
 * real thing. But this alias lives in the DATA layer, which the CLIENT compiles too, and a WebBuilder is
 * server-only; naming it here would break the client build. So the precise type is stated where it is
 * checked, and the carrier here is just "a void function".
 *
 * The compiled function is not what serves the endpoint, either: like Signum, the ROUTES come from
 * generated code (CodeGenController). The eval is what VALIDATES the script when the row is saved — which
 * is worth having, since a script that does not compile would otherwise break the whole dynamic compile
 * on the next restart.
 */
export type IDynamicApiEvaluator = (...args: never[]) => void;

@reflect
@entity("Main", "Master")
export class DynamicApiEntity extends Entity {

    // Signum's [UniqueIndex]; declared on the include.
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    /** Signum's DisabledMixin.IsDisabled. */
    disabled: boolean = false;

    eval: DynamicApiEval;

    @quoted
    override toString(): string {
        return this.name;
    }
}

/** Signum's DynamicApiEval. */
@reflect
export class DynamicApiEval extends EvalEmbedded<IDynamicApiEvaluator> {
    protected override compile(): CompilationResult<IDynamicApiEvaluator> {
        return this.wrap({
            importTypes: ["WebBuilder"],
            parameters: "ws: WebBuilder",
            returnType: "void",
        });
    }
}

export namespace DynamicApiOperation {
    export const Clone: ConstructSymbol<DynamicApiEntity, From<DynamicApiEntity>> = init();
    export const Save: ExecuteSymbol<DynamicApiEntity> = init();
    export const Delete: DeleteSymbol<DynamicApiEntity> = init();
}
