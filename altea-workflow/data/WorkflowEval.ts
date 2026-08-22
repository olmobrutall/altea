import { reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Symbol } from "@altea/altea/data/symbol";
import { entity } from "@altea/altea/data/decorators";
import { Temporal, type int } from "@altea/altea/data/basics";
import type { ICaseMainEntity, CaseEntity } from "./Case";
import type { CaseActivityEntity } from "./CaseActivity";
import type { WorkflowConnectionEntity } from "./WorkflowNodes";

// altea-only file — the ONE place the module's biggest divergence lives.
//
// Signum.Workflow has EIGHT hooks an administrator fills in with C# typed into the designer and compiled at
// runtime by Signum.Eval / Roslyn (`EvalEmbedded<IWorkflowConditionEvaluator>` and friends). altea has no
// Signum.Eval counterpart, and compiling source that came out of a database is not something this port wants
// to introduce, so each hook becomes a code-declared SYMBOL plus a registered function — exactly the shape
// @altea/altea-templating's `TemplateApplicableSymbol` established, and the same shape altea-scheduler's
// `SimpleTaskSymbol` uses.
//
// What that costs and what it buys:
//   - COST: a new hook needs a deploy, not a save. In exchange there is no runtime compiler, no `CodeGen`
//     directory, no restart-on-save, and the functions are type-checked against the real entity model.
//   - The four NAMED hooks keep their entity (WorkflowConditionEntity, …): the row still carries the display
//     name, the `mainEntityType` the designer's picker filters by, and the portable identity the workflow XML
//     references. Only its script becomes this pointer.
//   - The four INLINE hooks (lane actors, sub-entities, event-task condition/action) were embedded scripts,
//     so they become a plain symbol field on their owner.
//
// Every function may be ASYNC: altea's engine is (`entity.save()` returns a Promise), so an action that
// saves, or a condition that queries, has to be awaited. That is the one systematic shape change from
// Signum's synchronous delegates; the engine awaits at every call site.

/** Signum's WorkflowTransitionContext — passed to every condition and action: which case, which activity we
 *  came from, and which connection is being evaluated. */
export class WorkflowTransitionContext {
    constructor(
        public case_: CaseEntity | null,
        public previousCaseActivity: CaseActivityEntity | null,
        public connection: WorkflowConnectionEntity | null,
    ) { }

    /** Signum's `Action<CaseActivityEntity>? OnNextCaseActivityCreated` — a hook an action can install to be
     *  told which case activity this transition ended up creating. */
    onNextCaseActivityCreated: ((ca: CaseActivityEntity) => void | Promise<void>) | null = null;
}

/** Signum's WorkflowScriptContext — passed to a script activity's executor. */
export class WorkflowScriptContext {
    constructor(
        public caseActivity: CaseActivityEntity,
        public retryCount: int,
    ) { }
}

// ---- The eight evaluator shapes -------------------------------------------------------------------------

/** Signum's IWorkflowConditionEvaluator.EvaluateUntyped — "may this connection be taken?" */
export type IWorkflowConditionEvaluator =
    (mainEntity: ICaseMainEntity, ctx: WorkflowTransitionContext) => boolean | Promise<boolean>;

/** Signum's IWorkflowActionExecutor.ExecuteUntyped — a side effect run while taking a connection. */
export type IWorkflowActionExecutor =
    (mainEntity: ICaseMainEntity, ctx: WorkflowTransitionContext) => void | Promise<void>;

/** Signum's IWorkflowTimerConditionEvaluator.EvaluateUntyped — "has this timer fired?", asked with the
 *  pending case activity and the current time. */
export type IWorkflowTimerConditionEvaluator =
    (ca: CaseActivityEntity, now: Temporal.PlainDateTime) => boolean | Promise<boolean>;

/** Signum's IWorkflowScriptExecutor.ExecuteUntyped — the body of a SCRIPT activity. */
export type IWorkflowScriptExecutor =
    (mainEntity: ICaseMainEntity, ctx: WorkflowScriptContext) => void | Promise<void>;

/**
 * Signum's IWorkflowLaneActorsEvaluator.GetActors — who is notified for an activity in this lane, computed
 * per case instead of being a fixed list. `mainEntity` is null when the lane is asked who may START the
 * workflow (Signum passes `null!` there too).
 */
export type IWorkflowLaneActorsEvaluator =
    (mainEntity: ICaseMainEntity | null, ctx: WorkflowTransitionContext) => Lite<Entity>[] | Promise<Lite<Entity>[]>;

/** Signum's ISubEntitiesEvaluator.GetSubEntities — the entities a decomposition activity spawns a subcase
 *  for (one for CallWorkflow, many for DecompositionWorkflow). */
export type ISubEntitiesEvaluator =
    (mainEntity: ICaseMainEntity, ctx: WorkflowTransitionContext) => ICaseMainEntity[] | Promise<ICaseMainEntity[]>;

/** Signum's IWorkflowEventTaskConditionEvaluator.Evaluate — "should the scheduled start fire?". Takes
 *  nothing: there is no case yet. */
export type IWorkflowEventTaskConditionEvaluator = () => boolean | Promise<boolean>;

/**
 * Signum's IWorkflowEventTaskActionEval.EvaluateUntyped — what a scheduled start creates cases FOR.
 *
 * Signum's generated wrapper gives the script a `CreateCase(entity)` method that pushes onto a list; a
 * TypeScript function just RETURNS the list, so the indirection is gone.
 */
export type IWorkflowEventTaskActionEvaluator = () => ICaseMainEntity[] | Promise<ICaseMainEntity[]>;

// ---- The eight symbols ----------------------------------------------------------------------------------
//
// Eight separate symbol TYPES rather than one shared `WorkflowEvalSymbol` with a kind: each is a distinct
// table, but that is the price of the designer offering the right pickers and of
// `WorkflowLogic.registerCondition(symbol, fn)` being type-checked. A symbol pointed at the wrong slot is a
// class of bug worth making impossible.

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class WorkflowConditionSymbol extends Symbol {
}

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class WorkflowActionSymbol extends Symbol {
}

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class WorkflowTimerConditionSymbol extends Symbol {
}

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class WorkflowScriptSymbol extends Symbol {
}

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class WorkflowLaneActorsSymbol extends Symbol {
}

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class WorkflowSubEntitiesSymbol extends Symbol {
}

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class WorkflowEventTaskConditionSymbol extends Symbol {
}

@reflect
@entity("SystemString", "Master", { lowPopulation: true })
export class WorkflowEventTaskActionSymbol extends Symbol {
}
