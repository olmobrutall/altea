import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { WorkflowEventEntity, WorkflowEventType } from "../../data/WorkflowNodes";
import { TriggeredOn, type WorkflowEventTaskEntity } from "../../data/WorkflowEventTask";

// Port of Signum.Workflow's Workflow/WorkflowEventTask.tsx — the standalone editor for the scheduled-start
// task (the same thing the event dialog edits inline, reachable from the ScheduledTask search).
//
// altea divergences: the two evals are symbol PICKERS (see data/WorkflowEval.ts), so Signum's
// `fetchAndRemember` + "create an empty eval" dance is gone; the event-type filter is an ORDINAL.

export default function WorkflowEventTaskComponent(
    p: { ctx: TypeContext<WorkflowEventTaskEntity> }): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(wet => wet.workflow)} onChange={() => forceUpdate()} />
            {ctx.value.workflow != null &&
                <div>
                    <EntityCombo ctx={ctx.subCtx(wet => wet.event)}
                        findOptions={WorkflowEventEntity.findOptions(token => ({
                            filterOptions: [
                                token(a => a.lane.pool.workflow).filter("EqualTo", ctx.value.workflow),
                                token(e => e.type).filter("EqualTo", WorkflowEventType.ScheduledStart),
                            ],
                        }))} />

                    <AutoLine ctx={ctx.subCtx(wet => wet.triggeredOn)} onChange={() => forceUpdate()} />

                    {ctx.value.triggeredOn !== TriggeredOn.Always &&
                        <EntityLine ctx={ctx.subCtx(wet => wet.condition)} />}
                    <EntityLine ctx={ctx.subCtx(wet => wet.action)} />
                </div>}
        </div>
    );
}
