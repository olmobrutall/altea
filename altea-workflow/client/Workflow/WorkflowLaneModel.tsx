import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityStrip } from "@altea/altea/client/Lines/EntityStrip";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { BaseEntity } from "@altea/altea/data/entity";
import { WorkflowMessage } from "../../data/Workflow";
import type { WorkflowLaneModel } from "../../data/WorkflowNodes";

// Port of Signum.Workflow's Workflow/WorkflowLaneModel.tsx — WHO acts in this lane: a fixed list of users /
// roles, and/or a per-case evaluator.
//
// altea divergence: Signum's `ActorsEval` is a C# editor (`IEnumerable<Lite<Entity>> GetActors(OrderEntity e,
// WorkflowTransitionContext ctx)`) plus a TypeHelp browser; altea's is a picker over the registered
// WorkflowLaneActorsSymbols (see data/WorkflowEval.ts). The two dependent checkboxes and the "fix the
// booleans when the evaluator or the actor list empties" behaviour are unchanged.

export default function WorkflowLaneModelComponent(p: { ctx: TypeContext<WorkflowLaneModel> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    function handleFixBooleans(): void {
        if (ctx.value.actorsEvaluator == null)
            ctx.value.useActorEvalForStart = false;

        if (ctx.value.actorsEvaluator == null || ctx.value.actors.length === 0)
            ctx.value.combineActorAndActorEvalWhenContinuing = false;

        forceUpdate();
    }

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(wc => wc.name)} />
            {/* `actors` is a MODEL member of type `Lite<Entity>[]`. altea's EntityStrip generic is `R extends
                BaseEntity` where Signum's is `Lite<Entity> | ModifiableEntity`, though the control itself
                already handles a bare-lite array (its "direct-value-array mode", which the filter builder
                uses). Widening the constraint cascades into ViewPromise<R>, so this is a cast. */}
            <EntityStrip ctx={ctx.subCtx(wc => wc.actors) as unknown as TypeContext<BaseEntity[]>}
                onChange={handleFixBooleans} />
            {ctx.value.mainEntityType
                ? <EntityLine ctx={ctx.subCtx(wc => wc.actorsEvaluator)} onChange={handleFixBooleans} />
                : <div className="alert alert-warning">
                    {WorkflowMessage.ToUse0YouSouldSetTheWorkflow1.niceToString(
                        ctx.niceName(e => e.actorsEvaluator), ctx.niceName(e => e.mainEntityType))}
                </div>}
            {ctx.value.actorsEvaluator != null &&
                <CheckboxLine ctx={ctx.subCtx(wc => wc.useActorEvalForStart)} inlineCheckbox />}
            {ctx.value.actorsEvaluator != null && ctx.value.actors.length > 0 &&
                <CheckboxLine ctx={ctx.subCtx(wc => wc.combineActorAndActorEvalWhenContinuing)} inlineCheckbox />}
        </div>
    );
}
