import * as React from "react";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import { mlistItemContext, type TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { WorkflowOperation, WorkflowReplacementModel, type NewTasksEmbedded, type WorkflowReplacementItemEmbedded } from "../../data/Workflow";
import { CaseActivityEntity } from "../../data/CaseActivity";

// Port of Signum.Workflow's Workflow/WorkflowReplacementComponent.tsx — the dialog a workflow SAVE opens when
// it is about to delete an activity that still has pending case activities: for each one, where do they go?
// (An empty pick means "delete them".)
//
// altea divergences: `ctx.mlistItemCtxs(...)` → `mlistItemContext(ctx.subCtx(...))` (altea has no MList, so
// the helper is a free function over the array's context), and `is(a, b)` → `Lite.is`.

export default function WorkflowReplacementComponent(
    p: { ctx: TypeContext<WorkflowReplacementModel> }): React.JSX.Element {

    const ctx = p.ctx;
    const newTasks = ctx.value.newTasks;

    return (
        <div>
            {ctx.value.replacements.length > 0 &&
                <table className="table">
                    <thead>
                        <tr>
                            <th>{WorkflowReplacementModel.nicePropertyName(a => a.replacements[0].oldNode)}</th>
                            <th>{WorkflowReplacementModel.nicePropertyName(a => a.replacements[0].newNode)}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {mlistItemContext(ctx.subCtx(a => a.replacements)).map((ectx, i) =>
                            <tr key={i}>
                                <td>
                                    <SearchValueLine ctx={ectx}
                                        label={ectx.value.oldNode.toString() ?? ""}
                                        findOptions={CaseActivityEntity.findOptions(token => ({
                                            filterOptions: [
                                                token(e => e.workflowActivity).filter("EqualTo", ectx.value.oldNode),
                                                token(e => e.doneDate).filter("EqualTo", null),
                                            ],
                                        }))} />
                                </td>
                                <td>
                                    <WorkflowReplacementItemCombo ctx={ectx} previewTasks={newTasks} />
                                </td>
                            </tr>)}
                    </tbody>
                </table>}
        </div>
    );
}

export function WorkflowReplacementItemCombo(
    p: { ctx: TypeContext<WorkflowReplacementItemEmbedded>; previewTasks: NewTasksEmbedded[] }): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    function handleChange(e: React.FormEvent<HTMLSelectElement>): void {
        ctx.value.newNode = (e.currentTarget as HTMLSelectElement).value;
        forceUpdate();
    }

    return (
        <select value={ctx.value.newNode ?? ""} className="form-select form-select-sm" onChange={handleChange}>
            <option value=""> - {WorkflowOperation.Delete.niceToString().toUpperCase()} - </option>
            {p.previewTasks
                .filter(pt => pt.subWorkflow == null
                    ? ctx.value.subWorkflow == null
                    : pt.subWorkflow.is(ctx.value.subWorkflow))
                .map((pt, i) => <option key={i} value={pt.bpmnId}>{pt.name}</option>)}
        </select>
    );
}
