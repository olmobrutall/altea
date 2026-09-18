import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator, ValidationMessage, validate } from "@altea/altea/data/validators";
import { registerEnum } from "@altea/altea/data/registration";
import type { ConstructSymbol, From, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { PascalAscii } from "./DynamicType";

// Port of Signum.Dynamic's Expression/DynamicExpression.cs — a registered QUERY EXPRESSION defined from the
// running application: "on this type, `Name` is this body", which then appears as a query token and can be
// used in a filter, a column or an order.
//
// This is a GENERATED member, not an eval: an expression has to reach the LINQ provider as an expression
// TREE, and the only thing that produces one is the quote-transformer over real source. So
// DynamicExpressionLogic writes a `@quoted` prototype member into the CodeGen module — which is exactly how
// altea spells Signum's `[AutoExpressionField]` — and registers it with `QueryLogic.expressions`. Signum
// does the same thing for the same reason (its `IDynamicExpressionEvaluator` exists only for the panel's
// "test this" button, not for querying).
//
// altea divergences:
//  - `IDynamicExpressionEvaluator` is NOT ported. It compiles the body a second time, as a delegate, so the
//    panel can evaluate it against one entity in memory. altea's generated member is already callable in
//    memory — a `@quoted` member is an ordinary method with a tree beside it — so the panel calls it
//    directly and there is nothing to compile twice.
//  - `IdentifierValidator(PascalAscii)` → `@validate`, as in data/DynamicType.

export enum DynamicExpressionTranslation {
    TranslateExpressionName,
    ReuseTranslationOfReturnType,
    NoTranslation,
}
export type DynamicExpressionTranslationKeys = keyof typeof DynamicExpressionTranslation;
registerEnum(DynamicExpressionTranslation);

@reflect
@entity("Main", "Transactional")
export class DynamicExpressionEntity extends Entity {

    @stringLengthValidator({ min: 3, max: 100 })
    @validate<DynamicExpressionEntity>((e, fi) => PascalAscii.test(e.name) ? null
        : ValidationMessage._0DoesNotHaveAValid1Format.niceToString(fi.niceToString(), "PascalAscii"))
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    /** The type the expression hangs off — a clean type name, e.g. `"OrderEntity"`. */
    @stringLengthValidator({ min: 3, max: 100 })
    fromType: string;

    /** What it returns — a type expression the generator writes verbatim, e.g. `"decimal"`, `"IQuery<OrderEntity>"`. */
    @stringLengthValidator({ min: 3, max: 100 })
    returnType: string;

    /** The body, as an expression over `e` — what goes inside the generated `@quoted` member. */
    @stringLengthValidator({ min: 1, multiLine: true })
    body: string;

    @stringLengthValidator({ min: 1, max: 100 })
    format: string | null;

    @stringLengthValidator({ min: 1, max: 100 })
    unit: string | null;

    translation: DynamicExpressionTranslation = DynamicExpressionTranslation.TranslateExpressionName;

    @quoted
    override toString(): string {
        return this.returnType + " " + this.name + "(" + this.fromType + " e)";
    }
}

export namespace DynamicExpressionOperation {
    export const Clone: ConstructSymbol<DynamicExpressionEntity, From<DynamicExpressionEntity>> = init();
    export const Save: ExecuteSymbol<DynamicExpressionEntity> = init();
    export const Delete: DeleteSymbol<DynamicExpressionEntity> = init();
}
