import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ColorLine, TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { TextAreaLine } from "@altea/altea/client/Lines/TextAreaLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { DashboardEntity_Part } from "../../data/Dashboard";
import { parseIcon, fallbackIcon } from "@altea/altea/client/Components/IconHelpers";

// Port of Signum's Signum.Dashboard/Admin/PanelPart.tsx — the part CHROME modal (icon / colors / interaction
// group / tooltip) opened from the grid cell's icon button.
//
// altea divergences: the icon name is a plain text box (Signum's IconTypeaheadLine has no altea port — the
// stored format is identical, see IconHelpers.parseIcon), and the tooltip is a multi-line TEXT box instead of
// Signum's HtmlEditorLine (Signum.HtmlEditor is not ported) — the stored HTML still renders as HTML.

const interactionColors = ["#DFFF00", "#FFBF00", "#FF7F50", "#DE3163", "#9FE2BF", "#40E0D0", "#6495ED", "#CCCCFF"];

export default function PanelPart(p: { ctx: TypeContext<DashboardEntity_Part> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const settingsCtx = ctx.subCtx({ formGroupStyle: "Basic" });

    const icon = parseIcon(ctx.value.iconName);
    const title = (ctx.value.title || null) ?? ctx.value.content?.toString();
    const titleColor = ctx.value.titleColor;

    return (
        <div>
            {icon && (
                <div className="mb-3 p-3 border rounded bg-tertiary">
                    <div className="d-flex align-items-center">
                        <FontAwesomeIcon aria-hidden={true} icon={fallbackIcon(icon)}
                            style={{ color: ctx.value.iconColor ?? undefined, fontSize: "40px" }} />
                        <span className="ms-3" style={{ color: titleColor ?? undefined, fontSize: "18px", fontWeight: 500 }}>
                            {title}
                        </span>
                    </div>
                </div>
            )}

            <TextBoxLine ctx={settingsCtx.subCtx(pp => pp.iconName)} onChange={() => forceUpdate()} />

            <div className="row">
                <div className="col-sm-4">
                    <ColorLine ctx={settingsCtx.subCtx(pp => pp.iconColor)} onChange={() => forceUpdate()} />
                </div>
                <div className="col-sm-4">
                    <ColorLine ctx={settingsCtx.subCtx(pp => pp.titleColor)} onChange={() => forceUpdate()} />
                </div>
                <div className="col-sm-4">
                    <ColorLine ctx={settingsCtx.subCtx(pp => pp.customColor)} onChange={() => forceUpdate()} />
                </div>
            </div>

            <EnumLine ctx={settingsCtx.subCtx(pp => pp.interactionGroup)}
                onRenderDropDownListItem={io => (
                    <span className="sf-dot-container">
                        {/* altea enums are int-FK ORDINALS, so the option value IS the colour index. */}
                        <span className="sf-dot" style={{ backgroundColor: interactionColors[io.value as number] }} />
                        {io.label}
                    </span>
                )}
            />

            <TextAreaLine ctx={settingsCtx.subCtx(pp => pp.tooltip)} />
        </div>
    );
}
