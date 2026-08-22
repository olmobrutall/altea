import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { CaseTagTypeEntity } from "../../data/Case";
import Tag from "./Tag";

// Port of Signum.Workflow's Case/CaseTagType.tsx — the tag editor, with a live preview. Verbatim.

export default function CaseTagTypeComponent(p: { ctx: TypeContext<CaseTagTypeEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    return (
        <div className="row">
            <div className="col-sm-10">
                <AutoLine ctx={ctx.subCtx(e => e.name)} onChange={() => forceUpdate()} />
                <AutoLine ctx={ctx.subCtx(e => e.color)} onChange={() => forceUpdate()} />
            </div>
            <div className="col-sm-2">
                <Tag tag={ctx.value} />
            </div>
        </div>
    );
}
