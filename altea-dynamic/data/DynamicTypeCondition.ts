import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, quoted, bindParent } from "@altea/altea/data/decorators";
import { stringLengthValidator, ValidationMessage, validate } from "@altea/altea/data/validators";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ConstructSymbol, From, ExecuteSymbol } from "@altea/altea/data/operations";
import { EvalEmbedded, type CompilationResult } from "@altea/altea-eval/data/Eval";
import { PascalAscii } from "./DynamicType";

// Port of Signum.Dynamic's Types/DynamicTypeCondition.cs + DynamicTypeConditionSymbol.cs — a row-level TYPE
// CONDITION written from the running application: a named condition on a type, plus the script that decides
// whether one entity satisfies it.
//
// Like DynamicValidation this is an EVAL and not generated code (Signum's is too): the script is asked about
// an entity in hand.
//
// altea divergences:
//  - **the IN-MEMORY half only.** altea enforces a TypeCondition two ways: as an in-memory predicate (which
//    this script is) and, where one is registered, as a QUERY FILTER spliced into every query of the type.
//    A script cannot become a query filter — that needs an expression tree, and a compiled function has
//    none — so a dynamic condition is registered with `TypeConditionLogic.register` (in-memory) and NOT
//    `registerCompile`. Consequence, and it is the important one: a dynamic type condition guards SAVES and
//    single-entity reads, but does not narrow a search. Signum has exactly the same limitation for exactly
//    the same reason.
//  - `DynamicTypeConditionSymbolEntity` is a plain ENTITY here as it is in Signum — note it is not an
//    altea `Symbol` / `SemiSymbol`, because the name is invented by a user at runtime and no code declares
//    it. That is what Signum's separate table is for too.

@reflect
@entity("Shared", "Transactional")
export class DynamicTypeConditionSymbolEntity extends Entity {

    @stringLengthValidator({ min: 1, max: 100 })
    @validate<DynamicTypeConditionSymbolEntity>((e, fi) => PascalAscii.test(e.name) ? null
        : ValidationMessage._0DoesNotHaveAValid1Format.niceToString(fi.niceToString(), "PascalAscii"))
    name: string;

    @quoted
    override toString(): string {
        return this.name;
    }
}

export namespace DynamicTypeConditionSymbolOperation {
    export const Save: ExecuteSymbol<DynamicTypeConditionSymbolEntity> = init();
}

/** The function a condition's script becomes — Signum's `IDynamicTypeConditionEvaluator`. */
export type IDynamicTypeConditionEvaluator = (e: Entity) => boolean;

@reflect
@entity("Main", "Transactional")
export class DynamicTypeConditionEntity extends Entity {

    symbolName: DynamicTypeConditionSymbolEntity;

    entityType: TypeEntity;

    @bindParent
    eval: DynamicTypeConditionEval;

    @quoted
    override toString(): string {
        return this.entityType.cleanName + " : " + this.symbolName.name;
    }
}

/** Signum's DynamicTypeConditionEval. */
@reflect
export class DynamicTypeConditionEval extends EvalEmbedded<IDynamicTypeConditionEvaluator> {
    protected override compile(): CompilationResult<IDynamicTypeConditionEvaluator> {
        const entityTypeName = this.owner(DynamicTypeConditionEntity).entityType.className;

        return this.wrap({
            importTypes: [entityTypeName],
            parameters: `e: ${entityTypeName}`,
            returnType: "boolean",
        });
    }
}

export namespace DynamicTypeConditionOperation {
    export const Clone: ConstructSymbol<DynamicTypeConditionEntity, From<DynamicTypeConditionEntity>> = init();
    export const Save: ExecuteSymbol<DynamicTypeConditionEntity> = init();
}
