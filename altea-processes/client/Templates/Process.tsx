import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { ProcessEntity } from "../../data/Processes";

// Port of Signum.Processes' Templates/Process.tsx — read-only in practice: every field is written by the
// runner, and the state machine is driven by the operations in the button bar.
export default function Process(p: { ctx: TypeContext<ProcessEntity> }): React.JSX.Element {
    const ctx = p.ctx.subCtx({ labelColumns: { sm: 3 }, readOnly: true });
    return (
        <div>
            <EntityLine ctx={ctx.subCtx(e => e.algorithm)} />
            <EntityLine ctx={ctx.subCtx(e => e.data)} />
            <EntityLine ctx={ctx.subCtx(e => e.user)} />
            <AutoLine ctx={ctx.subCtx(e => e.state)} />
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.machineName)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.applicationName)} /></div>
            </div>
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.creationDate)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.plannedDate)} /></div>
            </div>
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.queuedDate)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.cancelationDate)} /></div>
            </div>
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.executionStart)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.executionEnd)} /></div>
            </div>
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.suspendDate)} /></div>
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.progress)} /></div>
            </div>
            <AutoLine ctx={ctx.subCtx(e => e.status)} />
            <div className="row">
                <div className="col-sm-6"><AutoLine ctx={ctx.subCtx(e => e.exceptionDate)} /></div>
                <div className="col-sm-6"><EntityLine ctx={ctx.subCtx(e => e.exception)} /></div>
            </div>
        </div>
    );
}
