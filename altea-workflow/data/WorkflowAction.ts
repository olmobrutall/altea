import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, primaryKey, uniqueIndex, stringLengthValidator } from "@altea/altea/data/decorators";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { type IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { WorkflowActionSymbol } from "./WorkflowEval";

// Port of Signum.Workflow's WorkflowAction.cs — a NAMED side effect run while taking a connection.
// Same two divergences as WorkflowCondition.ts: the compiled `Eval` becomes a registered symbol, and the
// portable `Guid` becomes a uuid primary key.

@reflect
@primaryKey("uuid")
@entity("Shared", "Master")
export class WorkflowActionEntity extends Entity implements IUserAssetEntity {

    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    mainEntityType: TypeEntity;

    executor: WorkflowActionSymbol;

    toString(): string {
        return this.name;
    }
}

export namespace WorkflowActionOperation {
    export const Clone: ConstructSymbol<WorkflowActionEntity, From<WorkflowActionEntity>> = init();
    export const Save: ExecuteSymbol<WorkflowActionEntity> = init();
    export const Delete: DeleteSymbol<WorkflowActionEntity> = init();
}
