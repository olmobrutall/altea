import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, primaryKey, uniqueIndex, stringLengthValidator, fieldValidation } from "@altea/altea/data/decorators";
import { Temporal, type int } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { ValidationMessage } from "@altea/altea/data/validators";
import type { ExecuteSymbol, DeleteSymbol, ConstructSymbol, From } from "@altea/altea/data/operations";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { type IUserAssetEntity } from "@altea/altea-user-assets/data/UserAssets";
import { WorkflowScriptSymbol } from "./WorkflowEval";

// Port of Signum.Workflow's WorkflowScript.cs + WorkflowScriptRetryStrategy.cs — the body of a SCRIPT
// activity (an unattended step the script runner executes) and the back-off rule used when it throws.
//
// altea divergences:
//  - `Eval` (a compiled C# script) → `executor`, a pointer at a code-registered WorkflowScriptSymbol.
//    `WorkflowScriptEval.CustomTypes` — extra C# helper classes compiled alongside the script — goes with
//    it: a registered function is ordinary TypeScript and can import whatever it likes.
//  - `Guid` → a uuid PRIMARY KEY (the IUserAssetEntity convention).

@reflect
@primaryKey("uuid")
@entity("Shared", "Master")
export class WorkflowScriptEntity extends Entity implements IUserAssetEntity {

    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    mainEntityType: TypeEntity;

    executor: WorkflowScriptSymbol;

    toString(): string {
        return this.name;
    }
}

export namespace WorkflowScriptOperation {
    export const Clone: ConstructSymbol<WorkflowScriptEntity, From<WorkflowScriptEntity>> = init();
    export const Save: ExecuteSymbol<WorkflowScriptEntity> = init();
    export const Delete: DeleteSymbol<WorkflowScriptEntity> = init();
}

// ---- Retry strategy -------------------------------------------------------------------------------------

/** The `Rule` grammar: a comma-separated back-off list, one entry per retry (`"30s, 5m, 1h, 1d"`). */
const retryRuleRegex = /^\s*\d+[smhd](\s*,\s*\d+[smhd])*\s*$/i;
const retryPartRegex = /\d+[smhd]/gi;

@reflect
@primaryKey("uuid")
@entity("Shared", "Master")
export class WorkflowScriptRetryStrategyEntity extends Entity implements IUserAssetEntity {

    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    // Signum validates the rule with the same regex in PropertyValidation.
    @fieldValidation<WorkflowScriptRetryStrategyEntity>(e => retryRuleRegex.test(e.rule ?? "") ? null
        : ValidationMessage._0DoesNotHaveAValid1Format.niceToString(
            WorkflowScriptRetryStrategyEntity.nicePropertyName(a => a.rule), "RetryStrategyRule"))
    rule: string;

    /**
     * When to try again after `retryCount` failures, or null when the rule is exhausted (the case activity
     * then takes its ScriptException connection).
     *
     * altea divergence: C# reads the repeated `(?<part>…)` group's `Captures`, which JavaScript's RegExp does
     * not have — a global match over the parts gives the same list. (The same gap the omnibox parser hit.)
     */
    nextDate(retryCount: int): Temporal.PlainDateTime | null {
        const parts = this.rule?.match(retryPartRegex);
        const part = parts?.[retryCount];
        if (part == null)
            return null;

        const unit = part[part.length - 1].toLowerCase();
        const value = parseInt(part.substring(0, part.length - 1), 10);
        const now = Clock.now;

        switch (unit) {
            case "s": return now.add({ seconds: value });
            case "m": return now.add({ minutes: value });
            case "h": return now.add({ hours: value });
            case "d": return now.add({ days: value });
            default: throw new Error("Unexpected unit " + unit);
        }
    }

    toString(): string {
        return this.rule;
    }
}

export namespace WorkflowScriptRetryStrategyOperation {
    export const Save: ExecuteSymbol<WorkflowScriptRetryStrategyEntity> = init();
    export const Delete: DeleteSymbol<WorkflowScriptRetryStrategyEntity> = init();
}
