import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import CSSCodeMirror from "@altea/altea-codemirror/client/CSSCodeMirror";
import type { DynamicCSSOverrideEntity } from "../../data/DynamicCSSOverride";

// Port of Signum.Dynamic's CSS/DynamicCSSOverride.tsx — verbatim, plus the `isDisabled` checkbox: Signum
// gets that field from its DisabledMixin (and its Disable / Enable operations), which altea has no
// counterpart for, so the flag is a plain field on the entity and is edited here.
export default function DynamicCSSOverrideComponent(p: { ctx: TypeContext<DynamicCSSOverrideEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();

    function handleCodeChange(newScript: string): void {
        p.ctx.value.script = newScript;
        forceUpdate();
    }

    const ctx = p.ctx;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(dt => dt.name)} />
            <CheckboxLine ctx={ctx.subCtx(dt => dt.isDisabled)} onChange={forceUpdate} />
            <br />
            <div className="code-container">
                <CSSCodeMirror script={ctx.value.script ?? ""} onChange={handleCodeChange} />
            </div>
        </div>
    );
}
