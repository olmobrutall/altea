import type { Location } from "react-router";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import type { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { ToolbarConfig } from "@altea/altea-toolbar/client/ToolbarConfig";
import type { ToolbarResponse } from "@altea/altea-toolbar/data/ToolbarResponse";
import { DashboardEntity } from "../data/Dashboard";
import { DashboardClient } from "./DashboardClient";

// Faithful port of Signum's DashboardToolbarConfig.tsx (Signum.Dashboard/DashboardToolbarConfig.tsx): the
// toolbar config for an element pointing at a DASHBOARD — it navigates to the dashboard page (carrying the
// selected entity when the menu is entity-scoped).
//
// It lives HERE (with the dashboard module) exactly as in Signum. altea divergences: import paths only.

export default class DashboardToolbarConfig extends ToolbarConfig<DashboardEntity> {

    constructor() {
        const type = DashboardEntity;
        super(type);
    }

    getDefaultIcon(): IconProp {
        return "table-cells-large";
    }

    override navigateTo(element: ToolbarResponse<DashboardEntity>, selectedEntity: Lite<Entity> | null): Promise<string> {
        return Promise.resolve(DashboardClient.dashboardUrl(element.content!, selectedEntity ?? undefined));
    }

    isCompatibleWithUrlPrio(res: ToolbarResponse<DashboardEntity>, location: Location, query: any, entityType?: string): { prio: number, inferredEntity?: Lite<Entity> } | null {

        if (location.pathname == DashboardClient.dashboardUrl(res.content!)) {
            return { prio: 2, inferredEntity: query["entity"] && Lite.parse(query["entity"]) };
        }

        return null;
    }
}
