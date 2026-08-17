// The `reflect` import must be PRESENT even where no class is decorated with it: the quote-transformer
// augments THIS import with the `field()` / `registerType()` helpers it injects for every entity field.
import { reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, unit, backReference, rowOrder, noRepeatValidator, fieldValidation } from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import type { IPartEntity } from "@altea/altea-dashboard/data/Dashboard";
import { UserChartEntity } from "./UserChart";

// Port of the DASHBOARD PART entities Signum declares in Signum.Chart/UserChart/UserChart.cs. They live in
// this module (not in altea-dashboard) exactly as in Signum: the Dashboard package knows nothing about charts;
// the app widens `PanelPartEmbedded.content`'s implementedBy list to include them (see eastwind's
// entityOverrides.data.ts).
//
// altea divergences, documented inline:
//  - `IsQueryCached` is NOT ported (CachedQuery needs Signum.Files — see the dashboard's data header).
//  - `RequiresTitle` stays an entity member; `Clone`/`ToXml`/`FromXml` live in the server part registry
//    (server/ChartDashboardXml.server.ts).
//  - Signum's `MList<CombinedUserChartElementEmbedded>` → per-owner `@part` rows (no MList in altea).

// Signum's UserChartPartEntity: a saved chart rendered inside a dashboard cell.
@entity("Part", "Master")
export class UserChartPartEntity extends Entity implements IPartEntity {
    userChart: UserChartEntity;

    /** Render the chart's data as a TABLE instead of the chart (Signum's ShowData → ChartTable). */
    showData: boolean = false;

    /** Let the viewer toggle `showData` from the part itself. */
    allowChangeShowData: boolean = false;

    createNew: boolean = false;

    autoRefresh: boolean = false;

    @unit("px")
    minHeight: int | null = null;

    requiresTitle(): boolean {
        return false;
    }

    toString(): string {
        return this.userChart?.toString() ?? "";
    }
}

// Signum's CombinedUserChartElementEmbedded: ONE of the saved charts a combined part paints together.
@entity("Part")
export class CombinedUserChartElementEmbedded extends Entity {
    @backReference combinedUserChartPart: Lite<CombinedUserChartPartEntity>;
    @rowOrder order: int = toInt(0);

    userChart: UserChartEntity;

    toString(): string {
        return this.userChart?.toString() ?? "";
    }
}

// Signum's CombinedUserChartPartEntity: SEVERAL Line / Columns charts painted over one shared horizontal
// axis, optionally sharing the vertical scale (see client/D3Scripts/CombinedLinesAndColumns.tsx).
@entity("Part", "Master")
export class CombinedUserChartPartEntity extends Entity implements IPartEntity {
    // Signum's [PreserveOrder, NoRepeatValidator].
    @noRepeatValidator()
    @fieldValidation<CombinedUserChartPartEntity>(p => (p.userCharts?.length ?? 0) === 0
        ? ChartPartMessage.ACombinedChartNeedsAtLeastOneUserChart.niceToString() : null)
    userCharts: CombinedUserChartElementEmbedded[];

    showData: boolean = false;

    allowChangeShowData: boolean = false;

    combinePinnedFiltersWithSameLabel: boolean = true;

    useSameScale: boolean = false;

    @unit("px")
    minHeight: int | null = null;

    requiresTitle(): boolean {
        return true;
    }

    toString(): string {
        return (this.userCharts ?? []).map(uc => uc.toString()).join(", ");
    }
}

// altea-only message container (Signum expressed these with validator attributes / NicePluralName).
export const ChartPartMessage = {
    ACombinedChartNeedsAtLeastOneUserChart: msg("A combined chart needs at least one user chart"),
};
