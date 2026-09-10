import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { parseIcon, fallbackIcon } from "@altea/altea/client/Components/IconHelpers";
import type { ToolbarSwitcherEntity } from "../../data/Toolbar";

// Port of Signum.Toolbar's Templates/ToolbarSwitcher.tsx — see docs/port/Toolbar.md.
//
// The ToolbarSwitcher editor: a name, an owner, and the table of switchable menu options. `owner` uses
// EntityLine rather than AutoLine — AutoLine dispatches from `ctx.memberType`, and an `@implementedBy` Lite
// belongs to EntityLine — as the Toolbar / ToolbarMenu editors already do.

export default function ToolbarSwitcher(p: { ctx: TypeContext<ToolbarSwitcherEntity> }): React.JSX.Element {
    const ctx = p.ctx;

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(f => f.name)} />
            <EntityLine ctx={ctx.subCtx(f => f.owner)} />
            <EntityTable ctx={ctx.subCtx(a => a.options)} view
                columns={[
                    {
                        header: "Icon",
                        headerHtmlAttributes: { style: { width: "10%" } },
                        template: ctx => {
                            const icon = parseIcon(ctx.value.iconName);
                            const bgColor = (ctx.value.iconColor && ctx.value.iconColor.toLowerCase() == "var(--bs-body-bg)" ? "var(--bs-body-color)" : undefined);
                            return icon && <div>
                                <FontAwesomeIcon icon={fallbackIcon(icon)} style={{ backgroundColor: bgColor, color: ctx.value.iconColor ?? undefined, fontSize: "25px" }} />
                            </div>;
                        },
                    },
                    {
                        headerHtmlAttributes: { style: { width: "90%" } },
                        property: a => a.toolbarMenu,
                    },
                ]} />
        </div>
    );
}
