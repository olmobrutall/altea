import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Temporal, type int } from "@altea/altea/data/basics";
import type { ICaseMainEntity, CaseEntity } from "./Case";
import type { CaseActivityEntity } from "./CaseActivity";
import type { WorkflowConnectionEntity } from "./WorkflowNodes";

// The shapes Signum.Workflow's EIGHT evals compile to, plus the two context objects they are handed.
//
// Signum declares one `IXEvaluator` INTERFACE per hook and its generated class implements it; altea's evals
// compile to a FUNCTION (a TypeScript module's natural unit — see @altea/altea-eval's data/Eval.ts), so each
// interface becomes a function TYPE. The `EvaluateUntyped` shim Signum's generated class carries — widening
// the typed parameter back to the interface's `ICaseMainEntity` — disappears with it: the generated wrapper's
// parameter is simply typed, and the CALLER is the one holding the untyped value.
//
// The eight `EvalEmbedded` subclasses live beside their owners, as Signum's do (WorkflowConditionEval in
// WorkflowCondition.ts, WorkflowLaneActorsEval in WorkflowNodes.ts, …) — which is also what keeps this file
// free of a cycle back to them.
//
// Every function may be ASYNC: altea's engine is (`entity.save()` returns a Promise), so a condition that
// queries or an action that saves has to be awaited. That is the one systematic shape change from Signum's
// synchronous delegates, and it is why every generated wrapper is declared `async`; the engine awaits at
// each call site.

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

/**
 * Signum's IWorkflowTimerConditionEvaluator.EvaluateUntyped — "has this timer fired?".
 *
 * THREE parameters, as Signum's generated wrapper has: the pending case activity, its main entity (which
 * Signum casts out of `ca.Case.MainEntity` for the script) and the clock.
 */
export type IWorkflowTimerConditionEvaluator =
    (ca: CaseActivityEntity, e: ICaseMainEntity, now: Temporal.PlainDateTime) => boolean | Promise<boolean>;

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
