import * as React from "react";
import type { FindOptions } from "@altea/altea/client/FindOptions";
import { Finder } from "@altea/altea/client/Finder";
import { getQueryKey } from "@altea/altea/client/Reflection";
import SearchControl, { type SearchControlHandler } from "@altea/altea/client/SearchControl/SearchControl";
import { FullscreenComponent } from "@altea/altea/client/Components";
import { useAPI, useVersion } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { Enum } from "@altea/altea/data/enum";
import { RefreshMode } from "@altea/altea/data/dynamicQueries";
import type { PanelPartContentProps } from "@altea/altea-dashboard/client/DashboardClient";
import { executeQueryCached } from "@altea/altea-dashboard/client/CachedQueryExecutor";
import type { CachedQueryJS } from "@altea/altea-dashboard/data/CachedQuery";
import { DashboardPinnedFilters } from "@altea/altea-dashboard/client/View/DashboardFilterController";
import { UserQueriesClient } from "../../UserQueriesClient";
import { AutoUpdate, UserQueryPartEntity } from "../../../data/DashboardParts";

// Port of Signum's Signum.UserQueries/Dashboard/View/UserQueryPart.tsx — runs the saved query in a
// SearchControl inside a dashboard cell, publishing its dashboard-pinned filters and (per `autoUpdate`)
// invalidating the other parts when its data changes.
//
// altea divergence: `Finder.getQueryDescription` → `Finder.getQueryRoot` (altea resolves tokens from the
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

    // The snapshot that can answer this part's user query, if the dashboard has one for it.
    const cachedQuery = p.cachedQueries[p.content.userQuery.toLite().key()];

    p.customDataRef.current = {
        findOptions: foExpanded,
        refresh: updateVersion,
    } as UserQueryPartHandler;

    function handleOnDataChanged(): void {
        const autoUpdate = Enum.toName(AutoUpdate, p.content.autoUpdate);
        if (autoUpdate == "Dashboard")
            p.dashboardController.invalidate(p.partEmbedded, null);
        else if (autoUpdate == "InteractionGroup" && p.partEmbedded.interactionGroup != null)
            p.dashboardController.invalidate(p.partEmbedded, p.partEmbedded.interactionGroup);
    }

    return <SearchControlInPart part={p.content} findOptions={foExpanded} cachedQuery={cachedQuery}
        deps={[...p.deps ?? [], version]} onDataChanged={handleOnDataChanged} />;
}

function SearchControlInPart({ findOptions, part, deps, cachedQuery, onDataChanged }: {
    findOptions: FindOptions,
    onDataChanged: () => void,
    part: UserQueryPartEntity,
    cachedQuery?: Promise<CachedQueryJS>,
    deps?: React.DependencyList;
}): React.JSX.Element {

    const scRef = React.useRef<SearchControlHandler>(null);
    const refreshMode = Enum.toName(RefreshMode, part.userQuery.refreshMode);

    return (
        // The maximize / reload mini-buttons. Signum declares an `onReload` prop here and then leaves the
        // call site's `onReload` COMMENTED OUT, so its reload always falls through to `doSearch`; altea has
        // the one live branch and no dead prop. Maximized, the wrapper div becomes a full-height flex column
        // and the result pane is allowed the whole viewport — the part's own `allowMaxHeight` cap only makes
        // sense inside a dashboard cell.
        <FullscreenComponent onReload={e => { e.preventDefault(); scRef.current?.doSearch({ dataChanged: false }); }}>
            {fullScreen => <div style={fullScreen ? { display: "flex", flexDirection: "column", height: "100%" } : { minWidth: 0, flexGrow: 1 }}>
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
                    maxResultsHeight={fullScreen ? "calc(100vh - 10px)" : (part.allowMaxHeight ? "none" : undefined)}
                    // The one line that moves the work off the server: SearchControl asks this instead of
                    // /api/query/executeQuery, so filtering, sorting and paging happen in the browser over
                    // the snapshot. Absent it, the control queries live exactly as before.
                    customRequest={cachedQuery && ((req, fop) => cachedQuery.then(cq => executeQueryCached(req, fop, cq)))}
                    extraOptions={{ userQuery: part.userQuery.toLite() }}
                />
            </div>}
        </FullscreenComponent>
    );
}
