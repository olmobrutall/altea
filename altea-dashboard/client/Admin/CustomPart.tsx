import * as React from "react";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import { CustomPartEntity } from "../../data/Parts";
import { DashboardClient } from "../DashboardClient";
import type { PartEditorProps } from "./PartEditor";

// Port of Signum's Signum.Dashboard/Admin/CustomPart.tsx — pick one of the app-registered custom renderers
// (DashboardClient.Options.registerCustomPartRenderer) for the dashboard's entity type, or explain that none
// is registered. altea divergence: the dashboard arrives as a PROP (no findParentCtx) — see PartEditor.tsx.

export default function CustomPart(p: PartEditorProps<CustomPartEntity>): React.JSX.Element {
    const ctx = p.ctx.subCtx(p.smallMode ? { formGroupStyle: "Basic" } : { formGroupStyle: "SrOnly", placeholderLabels: true });

    const entityTypeName = p.dashboard?.entityType?.toString();
    const registeredNames = Object.keys(DashboardClient.Options.getCustomPartRenderer(entityTypeName) ?? {});

    return (
        <div>
            {registeredNames.length == 0 ?
                <div className="alert alert-danger" role="alert">
                    No renderer for <code>{entityTypeName ?? "global"}</code> registered in <code>DashboardClient.Options.customPartRenderers</code>
                </div> :
                <EnumLine ctx={ctx.subCtx(cp => cp.customPartName)} optionItems={registeredNames} />
            }
        </div>
    );
}
