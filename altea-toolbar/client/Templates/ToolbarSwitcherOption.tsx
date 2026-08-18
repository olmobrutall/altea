import * as React from "react";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import type { ToolbarSwitcherEntity_Option } from "../../data/Toolbar";

// Faithful port of Signum's Templates/ToolbarSwitcherOption.tsx: one switcher option's detail editor.
//
// altea divergences: `IconTypeaheadLine` → `TextBoxLine` (no IconTypeahead port; identical stored format),
// and the menu reference is an `EntityLine` (a Lite field) rather than Signum's AutoLine.

export default function ToolbarSwitcherOption(p: { ctx: TypeContext<ToolbarSwitcherEntity_Option> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;

    const ctx4 = ctx.subCtx({ labelColumns: 4 });

    return (
        <div>
            <EntityLine ctx={ctx.subCtx(f => f.toolbarMenu)} />
            <div className="row">
                <div className="col-sm-6">
                    <TextBoxLine ctx={ctx4.subCtx(t => t.iconName)} onChange={() => forceUpdate()} />
                    <AutoLine ctx={ctx4.subCtx(t => t.iconColor)} onChange={() => forceUpdate()} />
                </div>
            </div>
        </div>
    );
}
