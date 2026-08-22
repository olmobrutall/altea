import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { LiteAutocompleteConfig } from "@altea/altea/client/Lines/AutoCompleteConfig";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { WorkflowScriptEntity } from "../../data/WorkflowScript";
import { WorkflowClient } from "../WorkflowClient";

// Port of Signum.Workflow's Workflow/WorkflowScript.tsx.
//
// altea divergence: Signum's editor is a C# CODE EDITOR (a CSharpCodeMirror wrapped in the generated
// `void Execute(OrderEntity e, WorkflowScriptContext ctx) { … }` signature, beside a TypeHelp browser).
// altea's script points at a code-registered symbol (see data/WorkflowEval.ts), so the editor is a
// PICKER — which is also why the file is a fifth of the size.

export default function WorkflowScript(p: { ctx: TypeContext<WorkflowScriptEntity> }): React.JSX.Element {
    const ctx = p.ctx;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(d => d.name)} />
            <EntityLine ctx={ctx.subCtx(d => d.mainEntityType)}
                autocomplete={new LiteAutocompleteConfig((signal, str) =>
                    WorkflowClient.API.findMainEntityType({ subString: str, count: 5 }, signal))}
                find={false} />
            <EntityLine ctx={ctx.subCtx(d => d.executor)} />
        </div>
    );
}
