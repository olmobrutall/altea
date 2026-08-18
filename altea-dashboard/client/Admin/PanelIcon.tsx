import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ColorLine, TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { DashboardEntity, DashboardEntity_Part } from "../../data/Dashboard";
import { parseIcon, fallbackIcon } from "@altea/altea/client/Components/IconHelpers";

// Port of Signum's Signum.Dashboard/Admin/PanelIcon.tsx — the small icon/colour modal opened from the
// dashboard title (and reused for a part). altea divergence: the icon name is a plain text box (no
// IconTypeaheadLine port) — the stored format is the same, see IconHelpers.parseIcon.

export default function PanelIcon(p: { ctx: TypeContext<DashboardEntity | DashboardEntity_Part> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx.subCtx({ formGroupStyle: "Basic", formSize: "xs" });
    const value = ctx.value;
    const title = value instanceof DashboardEntity ? value.displayName : (value.title ?? value.content?.toString());
    const titleColor = value.titleColor;

    const icon = parseIcon(value.iconName);

    return (
        <div>
            {icon &&
                <div className="mb-2">
                    <FontAwesomeIcon aria-hidden={true} icon={fallbackIcon(icon)}
                        style={{ color: value.iconColor ?? undefined, fontSize: "25px" }} />
                    &nbsp;<span style={{ color: titleColor ?? undefined }}>{title}</span>
                </div>}
            <TextBoxLine ctx={ctx.subCtx(t => t.iconName)} onChange={() => forceUpdate()} />
            <ColorLine ctx={ctx.subCtx(t => t.iconColor)} onChange={() => forceUpdate()} />
            <ColorLine ctx={ctx.subCtx(t => t.titleColor)} onChange={() => forceUpdate()} />
        </div>
    );
}
