import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, primaryKey, uniqueIndex, stringLengthValidator } from "@altea/altea/data/decorators";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { type IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { EvalEmbedded, type CompilationResult } from "@altea/altea-eval/data/Eval";
import type { IWorkflowActionExecutor } from "./WorkflowEval";

// Port of Signum.Workflow's WorkflowAction.cs — a NAMED side effect run while taking a connection.
// Same two divergences as WorkflowCondition.ts: `Eval` is a TypeScript script compiled by
// @altea/altea-eval, and the portable `Guid` becomes a uuid primary key.

@reflect
@primaryKey("uuid")
@entity("Shared", "Master")
export class WorkflowActionEntity extends Entity implements IUserAssetEntity {

    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    mainEntityType: TypeEntity;

    eval: WorkflowActionEval;

    toString(): string {
        return this.name;
    }
}

/** Signum's WorkflowActionEval — the script run while taking a connection. */
@reflect
export class WorkflowActionEval extends EvalEmbedded<IWorkflowActionExecutor> {
    protected override compile(): CompilationResult<IWorkflowActionExecutor> {
        const mainEntityType = this.owner<WorkflowActionEntity>().mainEntityType.className;

        return this.wrap({
            importTypes: [mainEntityType, "WorkflowTransitionContext"],
            parameters: `e: ${mainEntityType}, ctx: WorkflowTransitionContext`,
            returnType: "void",
            isAsync: true,
        });
    }
}

export namespace WorkflowActionOperation {
    export const Clone: ConstructSymbol<WorkflowActionEntity, From<WorkflowActionEntity>> = init();
    export const Save: ExecuteSymbol<WorkflowActionEntity> = init();
    export const Delete: DeleteSymbol<WorkflowActionEntity> = init();
}
