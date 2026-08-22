import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { WorkflowScriptRetryStrategyEntity } from "../../data/WorkflowScript";

// Port of Signum.Workflow's Workflow/WorkflowScriptRetryStrategy.tsx. Verbatim.

export default function WorkflowScriptRetryStrategy(
    p: { ctx: TypeContext<WorkflowScriptRetryStrategyEntity> }): React.JSX.Element {

    return (
        <div>
            <AutoLine ctx={p.ctx.subCtx(e => e.rule)} />
        </div>
    );
}
