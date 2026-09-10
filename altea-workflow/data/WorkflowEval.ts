import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Temporal, type int } from "@altea/altea/data/basics";
import type { ICaseMainEntity, CaseEntity } from "./Case";
import type { CaseActivityEntity } from "./CaseActivity";
import type { WorkflowConnectionEntity } from "./WorkflowNodes";

// The shapes the EIGHT evals compile to, plus the two context objects they are handed — see
// docs/port/Workflow.md.
//
// An eval compiles to a FUNCTION (a TypeScript module's natural unit — see @altea/altea-eval's
// data/Eval.ts), so each of Signum's `IXEvaluator` interfaces becomes a function TYPE, and its
// `EvaluateUntyped` shim disappears: the generated wrapper's parameter is simply typed, and the CALLER
// holds the untyped value.
//
// The eight `EvalEmbedded` subclasses live BESIDE THEIR OWNERS (WorkflowConditionEval in
// WorkflowCondition.ts, WorkflowLaneActorsEval in WorkflowNodes.ts, …), which is what keeps this file free
// of a cycle back to them.
//
// Every function may be ASYNC, because the engine is: a condition that queries, or an action that saves,
// has to be awaited. That is why every generated wrapper is declared `async`, and the engine awaits at
// each call site.

/** Passed to every condition and action: which case, which activity we
 *  came from, and which connection is being evaluated. */
export class WorkflowTransitionContext {
    constructor(
        public case_: CaseEntity | null,
        public previousCaseActivity: CaseActivityEntity | null,
        public connection: WorkflowConnectionEntity | null,
    ) { }

    /** A hook an action can install to be
     *  told which case activity this transition ended up creating. */
    onNextCaseActivityCreated: ((ca: CaseActivityEntity) => void | Promise<void>) | null = null;
}

/** Passed to a script activity's executor. */
export class WorkflowScriptContext {
    constructor(
        public caseActivity: CaseActivityEntity,
        public retryCount: int,
    ) { }
}

// ---- The eight evaluator shapes -------------------------------------------------------------------------

/** "may this connection be taken?" */
export type IWorkflowConditionEvaluator =
    (mainEntity: ICaseMainEntity, ctx: WorkflowTransitionContext) => boolean | Promise<boolean>;

/** A side effect run while taking a connection. */
export type IWorkflowActionExecutor =
    (mainEntity: ICaseMainEntity, ctx: WorkflowTransitionContext) => void | Promise<void>;

/**
 * "has this timer fired?".
 *
 * THREE parameters, as the generated wrapper has: the pending case activity, its main entity (cast out of
 * `ca.case_.mainEntity` for the script) and the clock.
 */
export type IWorkflowTimerConditionEvaluator =
    (ca: CaseActivityEntity, e: ICaseMainEntity, now: Temporal.PlainDateTime) => boolean | Promise<boolean>;

/** The body of a SCRIPT activity. */
export type IWorkflowScriptExecutor =
    (mainEntity: ICaseMainEntity, ctx: WorkflowScriptContext) => void | Promise<void>;

/**
 * Who is notified for an activity in this lane, computed
 * per case instead of being a fixed list. `mainEntity` is null when the lane is asked who may START the
 * workflow (Signum passes `null!` there too).
 */
export type IWorkflowLaneActorsEvaluator =
    (mainEntity: ICaseMainEntity | null, ctx: WorkflowTransitionContext) => Lite<Entity>[] | Promise<Lite<Entity>[]>;

/** The entities a decomposition activity spawns a subcase
 *  for (one for CallWorkflow, many for DecompositionWorkflow). */
export type ISubEntitiesEvaluator =
    (mainEntity: ICaseMainEntity, ctx: WorkflowTransitionContext) => ICaseMainEntity[] | Promise<ICaseMainEntity[]>;

/** "should the scheduled start fire?". Takes
 *  nothing: there is no case yet. */
export type IWorkflowEventTaskConditionEvaluator = () => boolean | Promise<boolean>;

/**
 * What a scheduled start creates cases FOR.
 *
 * Signum's generated wrapper gives the script a `CreateCase(entity)` method that pushes onto a list; a
 * TypeScript function just RETURNS the list, so the indirection is gone.
 */
export type IWorkflowEventTaskActionEvaluator = () => ICaseMainEntity[] | Promise<ICaseMainEntity[]>;
