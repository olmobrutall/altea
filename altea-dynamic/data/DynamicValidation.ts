import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { FieldInfo } from "@altea/altea/data/reflection";
import { entity, quoted, bindParent } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { PropertyRouteEntity } from "@altea/altea/data/propertyRouteEntity";
import type { ConstructSymbol, From, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { EvalEmbedded, type CompilationResult } from "@altea/altea-eval/data/Eval";

// Port of Signum.Dynamic's Validations/DynamicValidation.cs — a VALIDATOR written from the running
// application: a script that, given an entity and the property being validated, returns an error message or
// nothing.
//
// This is an EVAL, not generated code, exactly as in Signum: the script is compiled per row on first use
// (`EvalEmbedded`), because a validator is called with an entity in hand and needs no expression tree. So
// the whole thing rides on @altea/altea-eval, which is Signum.Eval's counterpart.
//
// altea divergences:
//  - `SubEntity` is a `PropertyRouteEntity` reference, as in Signum. (It used to be the route STRING,
//    because altea had no such table; it does now — see altea/data/propertyRouteEntity.ts.) The
//    APPLICABILITY test is still a route PREFIX rather than Signum's `PropertyRoute.MatchesEntity(mod)` —
//    see DynamicValidationLogic.
//  - **`DisabledMixin` is not ported** (the gap @altea/altea-tree documents), so "keep this validation but
//    stop running it" is a plain `isDisabled` field. It keeps the mixin MEMBER's name, so the column is
//    Signum's `IsDisabled` and a migrated database reads unchanged.
//  - `[BindParent]` has no counterpart: an eval's owner is bound by `sb.include(X)` (see
//    @altea/altea-eval), which DynamicValidationLogic calls.
//  - Signum's `GetMainType` static hook is unnecessary — the sub-entity route is a string here, so the
//    type the script receives is read off `entityType` directly.

/**
 * The function a DynamicValidation's script becomes.
 *
 * Signum's `IDynamicValidationEvaluator.EvaluateUntyped(ModifiableEntity, PropertyInfo)`. altea's
 * validation environment already passes the FieldInfo, which is the same information typed.
 */
export type IDynamicValidationEvaluator = (e: Entity, fi: FieldInfo) => string | null;

@reflect
@entity("Shared", "Master")
export class DynamicValidationEntity extends Entity {

    // Signum's [UniqueIndex]; declared on the include, as altea declares indexes.
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    entityType: TypeEntity;

    /** The route the validation applies to, or null for the entity itself (Signum's `SubEntity`). */
    subEntity: PropertyRouteEntity | null;

    /** Signum's DisabledMixin.IsDisabled — see the header. */
    isDisabled: boolean = false;

    @bindParent
    eval: DynamicValidationEval;

    @quoted
    override toString(): string {
        return this.entityType.cleanName + (this.subEntity == null ? "" : " " + this.subEntity.path) + ": " + this.name;
    }
}

/** Signum's DynamicValidationEval. */
@reflect
export class DynamicValidationEval extends EvalEmbedded<IDynamicValidationEvaluator> {
    protected override compile(): CompilationResult<IDynamicValidationEvaluator> {
        const entityTypeName = this.owner(DynamicValidationEntity).entityType.className;

        return this.wrap({
            importTypes: [entityTypeName, "FieldInfo"],
            parameters: `e: ${entityTypeName}, fi: FieldInfo`,
            returnType: "string | null",
        });
    }
}

export namespace DynamicValidationOperation {
    export const Clone: ConstructSymbol<DynamicValidationEntity, From<DynamicValidationEntity>> = init();
    export const Save: ExecuteSymbol<DynamicValidationEntity> = init();
    export const Delete: DeleteSymbol<DynamicValidationEntity> = init();
}
