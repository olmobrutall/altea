import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, primaryKey, uniqueIndex, stringLengthValidator } from "@altea/altea/data/decorators";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { type IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { EvalEmbedded, type CompilationResult } from "@altea/altea-eval/data/Eval";
import type { IWorkflowTimerConditionEvaluator } from "./WorkflowEval";

// Port of Signum.Workflow's WorkflowTimerCondition.cs — a NAMED "has this timer fired?" predicate, an
// alternative to a fixed duration on a timer event. Same two divergences as WorkflowCondition.ts.

@reflect
@primaryKey("uuid")
@entity("Shared", "Master")
export class WorkflowTimerConditionEntity extends Entity implements IUserAssetEntity {

    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    mainEntityType: TypeEntity;

    eval: WorkflowTimerConditionEval;

    toString(): string {
        return this.name;
    }
}

/**
 * Signum's WorkflowTimerConditionEval. Its generated signature is the one place Signum passes THREE
 * parameters: the pending case activity, its main entity (cast from `ca.Case.MainEntity`) and the clock.
 * altea keeps all three, so a script reads the same.
 */
@reflect
export class WorkflowTimerConditionEval extends EvalEmbedded<IWorkflowTimerConditionEvaluator> {
    protected override compile(): CompilationResult<IWorkflowTimerConditionEvaluator> {
        const mainEntityType = this.owner<WorkflowTimerConditionEntity>().mainEntityType.className;

        return this.wrap({
            importTypes: [mainEntityType, "CaseActivityEntity", "Temporal"],
            parameters: `ca: CaseActivityEntity, e: ${mainEntityType}, now: Temporal.PlainDateTime`,
            returnType: "boolean",
            isAsync: true,
        });
    }
}

export namespace WorkflowTimerConditionOperation {
    export const Clone: ConstructSymbol<WorkflowTimerConditionEntity, From<WorkflowTimerConditionEntity>> = init();
    export const Save: ExecuteSymbol<WorkflowTimerConditionEntity> = init();
    export const Delete: DeleteSymbol<WorkflowTimerConditionEntity> = init();
}
