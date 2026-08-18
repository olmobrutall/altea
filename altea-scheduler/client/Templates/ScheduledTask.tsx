import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityDetail } from "@altea/altea/client/Lines/EntityDetail";
import { ScheduledTaskEntity } from "../../data/Scheduler";

// Port of Signum.Scheduler Templates/ScheduledTask.tsx. The RULE is an owned part, so it is edited inline
// (EntityDetail); the TASK and the USER it runs as are references.
export default function ScheduledTask(p: { ctx: TypeContext<ScheduledTaskEntity> }): React.JSX.Element {
    const ctx = p.ctx.subCtx({ labelColumns: { sm: 3 } });
    return (
        <div>
            <EntityLine ctx={ctx.subCtx(t => t.task)} />
            <EntityLine ctx={ctx.subCtx(t => t.user)} />
            <AutoLine ctx={ctx.subCtx(t => t.suspended)} />
            <AutoLine ctx={ctx.subCtx(t => t.machineName)} />
            <AutoLine ctx={ctx.subCtx(t => t.applicationName)} />
            <EntityDetail ctx={ctx.subCtx(t => t.rule)} />
        </div>
    );
}
