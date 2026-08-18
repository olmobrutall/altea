import type { Location } from "react-router";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import type { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Navigator } from "@altea/altea/client/Navigator";
import { ToolbarConfig } from "@altea/altea-toolbar/client/ToolbarConfig";
import type { ToolbarResponse } from "@altea/altea-toolbar/data/ToolbarResponse";
import { UserChartEntity } from "../../data/UserChart";
import { UserChartClient } from "./UserChartClient";
import { ChartClient } from "../ChartClient";

// Faithful port of Signum's UserChartToolbarConfig.tsx (Signum.Chart/UserChart/UserChartToolbarConfig.tsx):
// the toolbar config for an element pointing at a saved USER CHART — it navigates to the chart page with the
// chart request encoded in the URL.
//
// It lives HERE (with the chart module) exactly as in Signum. altea divergences: import paths and
// `liteKey(x)` → `x.key()`.

export default class UserChartToolbarConfig extends ToolbarConfig<UserChartEntity> {
    constructor() {
        const type = UserChartEntity;
        super(type);
    }

    getDefaultIcon(): IconProp {
        return "chart-bar";
    }

    navigateTo(element: ToolbarResponse<UserChartEntity>): Promise<string> {
        return Navigator.API.fetch(element.content!)
            .then(a => UserChartClient.Converter.toChartRequest(a, undefined))
            .then(cr => ChartClient.Encoder.chartPathPromise(cr, element.content!));
    }

    isCompatibleWithUrlPrio(res: ToolbarResponse<UserChartEntity>, location: Location, query: any, entityType?: string): { prio: number, inferredEntity?: Lite<Entity> } | null {
        if (query["userChart"] == res.content!.key()) {
            return { prio: 2, inferredEntity: query["entity"] && Lite.parse(query["entity"]) };
        }

        return null;
    }
}
