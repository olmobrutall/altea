import * as React from "react";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EvalLine } from "@altea/altea-eval/client/EvalLine";
import { WorkflowEventTaskActionEval, WorkflowEventTaskConditionEval } from "../../data/WorkflowEventTask";

// Port of Signum.Workflow's Workflow/WorkflowEventTaskConditionComponent.tsx and
// WorkflowEventTaskActionComponent.tsx — the two script editors a scheduled start carries. They live in one
// file here because they are four lines each, and both the ENTITY editor (WorkflowEventTask.tsx) and the
// event dialog's inline MODEL editor (WorkflowEventModel.tsx) render them, exactly as in Signum.
//
// altea divergences:
//  - the editor is TypeScript rather than C# (see @altea/altea-eval's EvalLine), and Signum's TypeHelp tree
//    and its "CreateCase" helper button go with it.
//  - the ACTION returns the entities to create cases for, where Signum's script calls a generated
//    `CreateCase(entity)` — a C# method body cannot be an expression, a TypeScript one can. See
//    WorkflowEventTaskActionEval.

/** Signum's WorkflowEventTaskConditionComponent — `public bool CustomCondition()`. */
export function EventTaskConditionLine(p: { ctx: TypeContext<WorkflowEventTaskConditionEval | null> }): React.JSX.Element {
    return (
        <EntityDetail ctx={p.ctx} remove={false}
            onCreate={() => Promise.resolve(WorkflowEventTaskConditionEval.create({ script: "" }))}
            getComponent={ectx => <EvalLine ctx={ectx} signature="function evaluate(): Promise<boolean>" />} />
    );
}

/** Signum's WorkflowEventTaskActionComponent — `public void CustomAction()`, which created the cases. */
export function EventTaskActionLine(p: { ctx: TypeContext<WorkflowEventTaskActionEval | null> }): React.JSX.Element {
    return (
        <EntityDetail ctx={p.ctx} remove={false}
            onCreate={() => Promise.resolve(WorkflowEventTaskActionEval.create({ script: "" }))}
            getComponent={ectx => <EvalLine ctx={ectx}
                signature="function evaluate(): Promise<ICaseMainEntity[]>" />} />
    );
}
