import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, primaryKey, uniqueIndex, stringLengthValidator } from "@altea/altea/data/decorators";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { type IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { WorkflowTimerConditionSymbol } from "./WorkflowEval";

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

    evaluator: WorkflowTimerConditionSymbol;

    toString(): string {
        return this.name;
    }
}

export namespace WorkflowTimerConditionOperation {
    export const Clone: ConstructSymbol<WorkflowTimerConditionEntity, From<WorkflowTimerConditionEntity>> = init();
    export const Save: ExecuteSymbol<WorkflowTimerConditionEntity> = init();
    export const Delete: DeleteSymbol<WorkflowTimerConditionEntity> = init();
}
