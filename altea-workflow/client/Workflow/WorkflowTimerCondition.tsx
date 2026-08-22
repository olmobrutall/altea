import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { LiteAutocompleteConfig } from "@altea/altea/client/Lines/AutoCompleteConfig";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EvalLine } from "@altea/altea-eval/client/EvalLine";
import { WorkflowTimerConditionEval, type WorkflowTimerConditionEntity } from "../../data/WorkflowTimerCondition";
import { WorkflowClient } from "../WorkflowClient";

// Port of Signum.Workflow's Workflow/WorkflowTimerCondition.tsx — the name, the main entity type, and the SCRIPT.
//
// altea divergences:
//  - the editor is TypeScript rather than C# (@altea/altea-eval's EvalLine, which draws Signum's
//    signature / editor / closing-brace sandwich; the C# one read `bool Evaluate(CaseActivityEntity ca, OrderEntity e, DateTime now)`).
//  - Signum's TypeHelp tree beside the editor is not ported (see EvalLine's header), and neither is its
//    "ctx" button — Signum's showWorkflowTransitionContextCodeHelp printed a C# snippet.
//  - changing the main entity type CLEARS the script, exactly as Signum does: a script written against the
//    old type could not compile against the new one.

export default function WorkflowTimerCondition(p: { ctx: TypeContext<WorkflowTimerConditionEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const cleanName = ctx.value.mainEntityType?.className;

    function handleMainEntityTypeChange(): void {
        // A brand-new entity arrives with no eval at all (altea builds it client-side, and an embedded is
        // not seeded), so this both CREATES it and — Signum's own behaviour — clears a script written
        // against the previous type, which could not compile against the new one.
        ctx.value.eval ??= WorkflowTimerConditionEval.create({ script: "" });
        ctx.value.eval.script = "";
        forceUpdate();
    }

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(d => d.name)} />
            <EntityLine ctx={ctx.subCtx(d => d.mainEntityType)}
                onChange={handleMainEntityTypeChange}
                autocomplete={new LiteAutocompleteConfig((signal, str) =>
                    WorkflowClient.API.findMainEntityType({ subString: str, count: 5 }, signal))}
                find={false} />
            {cleanName != null && ctx.value.eval != null &&
                <EvalLine ctx={ctx.subCtx(d => d.eval)}
                    signature={`function evaluate(ca: CaseActivityEntity, e: ${cleanName}, now: Temporal.PlainDateTime): Promise<boolean>`} />}
        </div>
    );
}
