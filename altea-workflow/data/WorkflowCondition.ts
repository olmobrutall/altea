import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, primaryKey, uniqueIndex, stringLengthValidator } from "@altea/altea/data/decorators";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { type IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { WorkflowConditionSymbol } from "./WorkflowEval";

// Port of Signum.Workflow's WorkflowCondition.cs — a NAMED predicate a connection can be guarded by.
//
// altea divergences:
//  - `Eval` (a compiled C# script) → `evaluator`, a pointer at a code-registered WorkflowConditionSymbol.
//    See WorkflowEval.ts for the whole story; the row keeps its name and `mainEntityType`, which is what the
//    designer's picker filters by and what WorkflowLogic validates a connection against.
//  - `Guid` → a uuid PRIMARY KEY (the IUserAssetEntity convention).
//  - `ToXml` / `FromXml` are server-only (WorkflowXml.server.ts), not members of the isomorphic entity.

@reflect
@primaryKey("uuid")
@entity("Shared", "Master")
export class WorkflowConditionEntity extends Entity implements IUserAssetEntity {

    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    mainEntityType: TypeEntity;

    evaluator: WorkflowConditionSymbol;

    toString(): string {
        return this.name;
    }
}

export namespace WorkflowConditionOperation {
    export const Clone: ConstructSymbol<WorkflowConditionEntity, From<WorkflowConditionEntity>> = init();
    export const Save: ExecuteSymbol<WorkflowConditionEntity> = init();
    export const Delete: DeleteSymbol<WorkflowConditionEntity> = init();
}
