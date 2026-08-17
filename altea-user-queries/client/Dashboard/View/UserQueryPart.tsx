import * as React from "react";
import type { FindOptions } from "@altea/altea/client/FindOptions";
import { Finder } from "@altea/altea/client/Finder";
import { getQueryKey } from "@altea/altea/client/Reflection";
import SearchControl, { type SearchControlHandler } from "@altea/altea/client/SearchControl/SearchControl";
import { useAPI, useVersion } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Enum } from "@altea/altea/data/enum";
import { RefreshModeEnum } from "@altea/altea/data/dynamicQueries";
import type { PanelPartContentProps } from "@altea/altea-dashboard/client/DashboardClient";
import { DashboardPinnedFilters } from "@altea/altea-dashboard/client/View/DashboardFilterController";
import { UserQueriesClient } from "../../UserQueriesClient";
import { AutoUpdateEnum, UserQueryPartEntity } from "../../../data/DashboardParts";

// Port of Signum's Signum.UserQueries/Dashboard/View/UserQueryPart.tsx — runs the saved query in a
// SearchControl inside a dashboard cell, publishing its dashboard-pinned filters and (per `autoUpdate`)
// invalidating the other parts when its data changes.
//
// altea divergences: no cached-query custom request (CachedQuery is deferred) and no FullscreenComponent
// wrapper (not ported); `Finder.getQueryDescription` → `Finder.getQueryRoot` (altea resolves tokens from the
// query ROOT token, there is no QueryDescription DTO).

export interface UserQueryPartHandler {
    findOptions: FindOptions;
    refresh: () => void;
}

export default function UserQueryPart(p: PanelPartContentProps<UserQueryPartEntity>): React.JSX.Element {

    const fo = useAPI(() => UserQueriesClient.Converter.toFindOptions(p.content.userQuery, p.entity),
        [p.content.userQuery, p.entity?.key()]);

    const [version, updateVersion] = useVersion();

    React.useEffect(() => {
        if (fo) {
            const dashboardPinnedFilters = fo.filterOptions?.filter(a => a?.dashboardBehaviour == "PromoteToDasboardPinnedFilter") ?? [];

            if (dashboardPinnedFilters.length) {
                Finder.getQueryRoot(fo.queryName)
                    .then(qt => Finder.parseFilterOptions(dashboardPinnedFilters, fo.groupResults ?? false, qt)
                        .then(fops => {
                            p.dashboardController.setPinnedFilter(new DashboardPinnedFilters(p.partEmbedded, getQueryKey(fo.queryName), qt, fops));
                            p.dashboardController.registerInvalidations(p.partEmbedded, () => updateVersion());
                        }));
            } else {
                p.dashboardController.clearPinnedFilter(p.partEmbedded);
                p.dashboardController.registerInvalidations(p.partEmbedded, () => updateVersion());
            }
        }
    }, [fo, p.partEmbedded]);

    if (!fo)
        return <span>{JavascriptMessage.loading.niceToString()}</span>;

    if (p.dashboardController.isLoading)
        return <span>{JavascriptMessage.loading.niceToString()}...</span>;

    const foExpanded = p.dashboardController.applyToFindOptions(p.partEmbedded, fo);

    p.customDataRef.current = {
        findOptions: foExpanded,
        refresh: updateVersion,
    } as UserQueryPartHandler;

    function handleOnDataChanged(): void {
        const autoUpdate = Enum.toName(AutoUpdateEnum, p.content.autoUpdate);
        if (autoUpdate == "Dashboard")
            p.dashboardController.invalidate(p.partEmbedded, null);
        else if (autoUpdate == "InteractionGroup" && p.partEmbedded.interactionGroup != null)
            p.dashboardController.invalidate(p.partEmbedded, p.partEmbedded.interactionGroup);
    }

    return <SearchControlInPart part={p.content} findOptions={foExpanded}
        deps={[...p.deps ?? [], version]} onDataChanged={handleOnDataChanged} />;
}

function SearchControlInPart({ findOptions, part, deps, onDataChanged }: {
    findOptions: FindOptions,
    onDataChanged: () => void,
    part: UserQueryPartEntity,
    deps?: React.DependencyList;
}): React.JSX.Element {

    const scRef = React.useRef<SearchControlHandler>(null);
    const refreshMode = Enum.toName(RefreshModeEnum, part.userQuery.refreshMode);

    return (
        <div style={{ minWidth: 0, flexGrow: 1 }}>
            <SearchControl
                ref={scRef}
                deps={deps}
                findOptions={findOptions}
                showHeader={"PinnedFilters"}
                avoidTableFooterContainer={true}
                pinnedFilterVisible={fop => fop.dashboardBehaviour == null}
                showFooter={part.showFooter}
                allowSelection={part.allowSelection}
                create={part.createNew}
                defaultRefreshMode={refreshMode}
                searchOnLoad={refreshMode == "Auto"}
                onSearch={(fo, dataChange) => dataChange && onDataChanged()}
                maxResultsHeight={part.allowMaxHeight ? "none" : undefined}
                extraOptions={{ userQuery: part.userQuery.toLite() }}
            />
        </div>
    );
}
