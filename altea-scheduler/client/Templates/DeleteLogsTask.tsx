import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { DeleteLogsTaskEntity } from "../../data/DeleteLogsTask";

// The retention policy: one row per log type that is trimmed at all, plus the chunking the run is
// allowed. A type with NO row here is never swept.
export default function DeleteLogsTask(p: { ctx: TypeContext<DeleteLogsTaskEntity> }): React.JSX.Element {
    const ctx = p.ctx.subCtx(t => t.parameters).subCtx({ labelColumns: { sm: 3 } });
    return (
        <div>
            <div className="row">
                <div className="col-sm-4"><AutoLine ctx={ctx.subCtx(c => c.chunkSize)} /></div>
                <div className="col-sm-4"><AutoLine ctx={ctx.subCtx(c => c.maxChunks)} /></div>
                <div className="col-sm-4"><AutoLine ctx={ctx.subCtx(c => c.pauseTime)} /></div>
            </div>
            <EntityTable ctx={ctx.subCtx(c => c.deleteLogs)} columns={[
                { property: o => o.type },
                { property: o => o.deleteLogsOlderThan },
                { property: o => o.deleteLogsWithExceptionsOlderThan },
            ]} />
        </div>
    );
}
