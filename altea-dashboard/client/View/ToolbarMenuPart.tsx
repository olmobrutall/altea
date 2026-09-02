import * as React from "react";
import { useAPI } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { ToolbarClient } from "@altea/altea-toolbar/client/ToolbarClient";
import { ToolbarMenuItems, simplifyForEntity } from "@altea/altea-toolbar/client/Renderers/ToolbarRenderer";
import { ToolbarMenuPartEntity } from "../../data/Parts";
import type { PanelPartContentProps } from "../DashboardClient";

// Port of Signum's Signum.Dashboard/View/ToolbarMenuPart.tsx — renders one toolbar MENU inside a dashboard
// cell, so a dashboard can carry the same navigation block the sidebar does.

export default function ToolbarMenuPart(p: PanelPartContentProps<ToolbarMenuPartEntity>): React.ReactNode {

    const response = useAPI(() => ToolbarClient.API.getToolbarMenu(p.content.toolbarMenu),
        [p.content.toolbarMenu], { avoidReset: true });

    // A menu fetched BY ID carries no entityType (the response never sets one), so ToolbarMenuItems cannot
    // filter it by itself. Here the entity IS known — it is the dashboard's — so apply the per-entity
    // filtering an entity-bound menu would get.
    const entity = p.entity;
    const entityFilter = entity && ToolbarClient.entityElementFilters[entity.entityType.name];
    const hiddenGuids = useAPI(() => entity && entityFilter ? entityFilter(entity) : Promise.resolve(null),
        [entity?.entityType.name, entity?.key()]);

    // Wait for the filter rather than rendering unfiltered elements first: an element that flashes and then
    // disappears is exactly what the filter is there to prevent.
    const loading = !response || (entityFilter != null && hiddenGuids === undefined);

    const filtered = React.useMemo(
        () => !response || !entity ? response
            : { ...response, elements: simplifyForEntity(response.elements ?? [], entity, hiddenGuids ?? undefined) },
        [response, entity?.key(), hiddenGuids]);

    return (
        <div className="sidebar sidebar-nav wide" style={{ zIndex: 0 }}>
            {loading || !filtered ? JavascriptMessage.loading.niceToString() :
                <ToolbarMenuItems
                    response={filtered}
                    ctx={{ active: null, onRefresh: () => { }, onAutoClose: () => { } }}
                    selectedEntity={p.entity ?? null} />}
        </div>
    );
}
