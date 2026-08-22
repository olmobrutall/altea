import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, primaryKey, uniqueIndex, stringLengthValidator } from "@altea/altea/data/decorators";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { type IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { EvalEmbedded, type CompilationResult } from "@altea/altea-eval/data/Eval";
import type { IWorkflowConditionEvaluator } from "./WorkflowEval";

// Port of Signum.Workflow's WorkflowCondition.cs — a NAMED predicate a connection can be guarded by.
//
// altea divergences:
//  - `Eval` keeps Signum's shape — a stored SCRIPT compiled on first use — but the script is TypeScript and
//    the compiler is @altea/altea-eval's rather than Roslyn's. See WorkflowEval.ts for the shared story.
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

    eval: WorkflowConditionEval;

    toString(): string {
        return this.name;
    }
}

/** Signum's WorkflowConditionEval — the script behind "may this connection be taken?". */
@reflect
export class WorkflowConditionEval extends EvalEmbedded<IWorkflowConditionEvaluator> {
    protected override compile(): CompilationResult<IWorkflowConditionEvaluator> {
        const mainEntityType = this.owner<WorkflowConditionEntity>().mainEntityType.className;

        return this.wrap({
            importTypes: [mainEntityType, "WorkflowTransitionContext"],
            parameters: `e: ${mainEntityType}, ctx: WorkflowTransitionContext`,
            returnType: "boolean",
            isAsync: true,
        });
    }
}

export namespace WorkflowConditionOperation {
    export const Clone: ConstructSymbol<WorkflowConditionEntity, From<WorkflowConditionEntity>> = init();
    export const Save: ExecuteSymbol<WorkflowConditionEntity> = init();
    export const Delete: DeleteSymbol<WorkflowConditionEntity> = init();
}
