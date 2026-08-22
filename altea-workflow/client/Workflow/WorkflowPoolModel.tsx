import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { WorkflowPoolModel } from "../../data/WorkflowNodes";

// altea addition: Signum has no editor for WorkflowPoolModel — a pool's only property is its name, which the
// diagram edits inline, so double-clicking one in Signum opens the framework's auto-generated view. altea's
// auto-generated view would do the same, but registering this one keeps the pool dialog as small as its
// content (and gives the port a place to grow if a pool ever gains a property).

export default function WorkflowPoolModelComponent(p: { ctx: TypeContext<WorkflowPoolModel> }): React.JSX.Element {
    return (
        <div>
            <AutoLine ctx={p.ctx.subCtx(a => a.name)} />
        </div>
    );
}
