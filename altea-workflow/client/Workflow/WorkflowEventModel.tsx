import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { Enum } from "@altea/altea/data/enum";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { TypeEntity } from "@altea/altea/data/typeEntity";
import {
    WorkflowEventType, isTimer, type WorkflowEventModel, type WorkflowTimerEmbedded,
} from "../../data/WorkflowNodes";
import { TriggeredOn, WorkflowEventTaskModel } from "../../data/WorkflowEventTask";
import { WorkflowTimerConditionEntity } from "../../data/WorkflowTimerCondition";

// Port of Signum.Workflow's Workflow/WorkflowEventModel.tsx — the START / FINISH / TIMER event editor. A
// SCHEDULED start grows the scheduler side (suspended + rule + when to trigger + the two functions); a timer
// event grows a duration or a timer condition.
//
// altea divergences: the event type is an ORDINAL, and the event task's condition / action are symbol PICKERS
// rather than C# editors (see data/WorkflowEval.ts) — which is what collapses Signum's two extra components
// (WorkflowEventTaskConditionComponent / WorkflowEventTaskActionComponent) into two EntityLines.

export default function WorkflowEventModelComponent(p: { ctx: TypeContext<WorkflowEventModel> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    function isScheduledStart(): boolean {
        return ctx.value.type === WorkflowEventType.ScheduledStart;
    }

    function loadTask(): void {
        if (!isScheduledStart())
            ctx.value.task = null;
        else if (ctx.value.task == null)
            ctx.value.task = WorkflowEventTaskModel.create({ triggeredOn: TriggeredOn.Always });

        forceUpdate();
    }

    React.useEffect(loadTask, []);

    // A timer event's KIND is decided by the diagram (which boundary / intermediate shape it is), so the
    // combo is read-only there and offers only the non-timer kinds otherwise.
    function typeComboItems(): WorkflowEventType[] {
        return isTimer(ctx.value.type)
            ? [ctx.value.type]
            : Enum.values(WorkflowEventType)
                .map(name => Enum.toValue(WorkflowEventType, name) as WorkflowEventType)
                .filter(v => !isTimer(v));
    }

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(we => we.name)} />
            <EnumLine ctx={ctx.subCtx(we => we.type)} readOnly={isTimer(ctx.value.type)}
                optionItems={typeComboItems()} onChange={loadTask} />
            {ctx.value.type === WorkflowEventType.BoundaryForkTimer &&
                <AutoLine ctx={ctx.subCtx(a => a.runRepeatedly)} />}
            {ctx.value.type === WorkflowEventType.BoundaryInterruptingTimer &&
                <AutoLine ctx={ctx.subCtx(a => a.decisionOptionName)} />}
            {ctx.value.task != null &&
                <WorkflowEventTaskPart ctx={ctx.subCtx(a => a.task!)} />}
            {ctx.value.timer != null &&
                <WorkflowTimerPart ctx={ctx.subCtx(a => a.timer!)} mainEntityType={ctx.value.mainEntityType} />}
        </div>
    );
}

function WorkflowEventTaskPart(p: { ctx: TypeContext<WorkflowEventTaskModel> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const isConditional = ctx.value.triggeredOn !== TriggeredOn.Always;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(te => te.suspended)} />
            <EntityDetail ctx={ctx.subCtx(te => te.rule)} />
            <AutoLine ctx={ctx.subCtx(te => te.triggeredOn)} onChange={() => forceUpdate()} />
            {isConditional && <EntityLine ctx={ctx.subCtx(t => t.condition)} />}
            <EntityLine ctx={ctx.subCtx(t => t.action)} />
        </div>
    );
}

function WorkflowTimerPart(p: { ctx: TypeContext<WorkflowTimerEmbedded>; mainEntityType: TypeEntity }): React.JSX.Element {
    const ctx = p.ctx;

    return (
        <div>
            <EntityDetail ctx={ctx.subCtx(te => te.duration)} />
            <EntityLine ctx={ctx.subCtx(te => te.condition)}
                findOptions={WorkflowTimerConditionEntity.findOptions(token => ({
                    filterOptions: [token(a => a.mainEntityType).filter("EqualTo", p.mainEntityType)],
                }))} />
            <AutoLine ctx={ctx.subCtx(te => te.avoidExecuteConditionByTimer)} />
        </div>
    );
}
