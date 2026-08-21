import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import SqlCodeMirror from "@altea/altea-codemirror/client/SqlCodeMirror";
import type { DynamicSqlMigrationEntity } from "../../data/DynamicSqlMigration";

// Port of Signum.Dynamic's Type/DynamicSqlMigration.tsx — verbatim: the who/when fields read-only, the
// comment and the script editable until the migration has been executed.
//
// altea divergence: `ctxValue.modified = true` is dropped (altea tracks modification against a snapshot).
export default function DynamicSqlMigrationComponent(p: { ctx: TypeContext<DynamicSqlMigrationEntity> }): React.JSX.Element {

    function handleScriptChange(newScript: string): void {
        p.ctx.value.script = newScript;
    }

    const ctx = p.ctx;
    const ctx4 = ctx.subCtx({ labelColumns: { sm: 4 } });
    const executed = ctx.value.executedBy != null;

    return (
        <div>
            <div className="row">
                <div className="col-sm-6">
                    <AutoLine ctx={ctx4.subCtx(sm => sm.creationDate)} readOnly={true} />
                    <AutoLine ctx={ctx4.subCtx(sm => sm.executionDate)} readOnly={true} />
                </div>

                <div className="col-sm-6">
                    <EntityLine ctx={ctx4.subCtx(sm => sm.createdBy)} readOnly={true} />
                    <EntityLine ctx={ctx4.subCtx(sm => sm.executedBy)} readOnly={true} />
                </div>
            </div>

            <AutoLine ctx={ctx.subCtx(sm => sm.comment)} readOnly={executed} />
            <div className="code-container">
                <SqlCodeMirror script={ctx.value.script ?? ""} onChange={handleScriptChange} isReadOnly={executed} />
            </div>
        </div>
    );
}
