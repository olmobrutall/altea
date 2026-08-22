import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { EntityStrip } from "@altea/altea/client/Lines/EntityStrip";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { BaseEntity } from "@altea/altea/data/entity";
import { WorkflowMessage } from "../../data/Workflow";
import { WorkflowLaneActorsEval, type WorkflowLaneModel } from "../../data/WorkflowNodes";
import { EvalLine } from "@altea/altea-eval/client/EvalLine";

// Port of Signum.Workflow's Workflow/WorkflowLaneModel.tsx — WHO acts in this lane: a fixed list of users /
// roles, and/or a per-case evaluator.
//
// altea divergence: the `actorsEval` editor is TypeScript rather than C# (Signum's signature read
// `IEnumerable<Lite<Entity>> GetActors(OrderEntity e, WorkflowTransitionContext ctx)`), and the TypeHelp
// browser beside it is not ported — see @altea/altea-eval's EvalLine. Everything else, including the two
// dependent checkboxes and the "fix the booleans when the eval or the actor list empties" behaviour, is
// Signum's.

export default function WorkflowLaneModelComponent(p: { ctx: TypeContext<WorkflowLaneModel> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    function handleFixBooleans(): void {
        if (ctx.value.actorsEval == null)
            ctx.value.useActorEvalForStart = false;

        if (ctx.value.actorsEval == null || ctx.value.actors.length === 0)
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
                ? <EntityDetail ctx={ctx.subCtx(wc => wc.actorsEval)} onChange={handleFixBooleans}
                    onCreate={() => Promise.resolve(WorkflowLaneActorsEval.create({ script: "return [e.yourProperty];" }))}
                    getComponent={ectx => <EvalLine ctx={ectx}
                        signature={`function evaluate(e: ${ctx.value.mainEntityType!.className}, `
                            + `ctx: WorkflowTransitionContext): Promise<Lite<Entity>[]>`} />} />
                : <div className="alert alert-warning">
                    {WorkflowMessage.ToUse0YouSouldSetTheWorkflow1.niceToString(
                        ctx.niceName(e => e.actorsEval), ctx.niceName(e => e.mainEntityType))}
                </div>}
            {ctx.value.actorsEval != null &&
                <CheckboxLine ctx={ctx.subCtx(wc => wc.useActorEvalForStart)} inlineCheckbox />}
            {ctx.value.actorsEval != null && ctx.value.actors.length > 0 &&
                <CheckboxLine ctx={ctx.subCtx(wc => wc.combineActorAndActorEvalWhenContinuing)} inlineCheckbox />}
        </div>
    );
}
