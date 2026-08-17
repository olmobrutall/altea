import * as React from "react";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { getTypeName } from "@altea/altea/client/Reflection";
import type { Entity } from "@altea/altea/data/entity";
import { CustomPartEntity } from "../../data/Parts";
import { DashboardClient, type CustomPartProps, type PanelPartContentProps } from "../DashboardClient";

// Port of Signum's Signum.Dashboard/View/CustomPart.tsx — renders the app-registered component named by the
// part (DashboardClient.Options.registerCustomPartRenderer), or an explanatory alert when none is registered.

export default function CustomPart(p: PanelPartContentProps<CustomPartEntity>): React.JSX.Element {

    const typeName = p.entity == null ? undefined : getTypeName(p.entity);
    const cpr = DashboardClient.Options.getCustomPartRenderer(typeName)?.[p.content.customPartName];

    if (!cpr)
        return (
            <div className="alert alert-danger" role="alert">
                No renderer for <code>{typeName ?? "global"}</code> with name <code>{p.content.customPartName}</code> registered in <code>DashboardClient.Options.customPartRenderers</code>
            </div>
        );

    return <ImportComponent onImport={cpr.renderer} componentProps={{
        partEmbedded: p.partEmbedded,
        content: p.content,
        dashboardController: p.dashboardController,
        entity: p.entity,
    } as CustomPartProps<Entity>} />;
}
