import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { SeparatorPartEntity } from "../../data/Parts";
import type { PartEditorProps } from "./PartEditor";

// Port of Signum's Signum.Dashboard/Admin/SeparatorPart.tsx.

export default function SeparatorPart(p: PartEditorProps<SeparatorPartEntity>): React.JSX.Element {
    const ctx = p.ctx.subCtx({ formGroupStyle: "SrOnly", placeholderLabels: true });

    return (
        <div className="form-inline">
            <AutoLine ctx={ctx.subCtx(c => c.title)} />
        </div>
    );
}
