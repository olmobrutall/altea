import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { FindOptions } from "@altea/altea/client/FindOptions";
import { Finder } from "@altea/altea/client/Finder";
import SearchValue, { type SearchValueController } from "@altea/altea/client/SearchControl/SearchValue";
import * as AppContext from "@altea/altea/client/AppContext";
import { getQueryKey } from "@altea/altea/client/Reflection";
import { useAPI, useForceUpdate, useVersion } from "@altea/altea/client/Hooks";
import { classes } from "@altea/altea/data/globals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { PanelPartContentProps } from "@altea/altea-dashboard/client/DashboardClient";
import { DashboardTooltipIcon } from "@altea/altea-dashboard/client/View/DashboardTooltipIcon";
import { DashboardPinnedFilters } from "@altea/altea-dashboard/client/View/DashboardFilterController";
import { parseIcon, getContrastingTextColor } from "@altea/altea-dashboard/client/IconHelpers";
import { UserQueriesClient } from "../../UserQueriesClient";
import { BigValueClient } from "../../BigValueClient";
import { BigValuePartEntity } from "../../../data/DashboardParts";

// Port of Signum's Signum.UserQueries/Dashboard/View/BigValuePart.tsx — ONE big number (the saved query's
// count, or its `valueToken` aggregate) with the part's title underneath, optionally clickable.
//
// altea divergences:
//  - Signum's `customUrl` went through Signum.Toolbar's ToolbarUrl (`:id2` sub-entity placeholders, variable
//    substitution). Toolbar is not ported, so a customUrl is opened as-is (external → new tab, otherwise
//    in-app navigation).
//  - No cached-query custom request (CachedQuery is deferred); `translated(…)` is not ported (raw text);
//    `Finder.getQueryDescription` → `Finder.getQueryRoot`.

export interface BigValuePartHandler {
    findOptions: FindOptions;
    refresh: () => void;
}

export default function BigValuePart(p: PanelPartContentProps<BigValuePartEntity>): React.JSX.Element | null {

    const foResult = useAPI<"not-findable" | null | FindOptions>(() => p.content.userQuery == null ? Promise.resolve(null) :
        !Finder.isFindable(p.content.userQuery.query.key, false) ? Promise.resolve("not-findable") :
            UserQueriesClient.Converter.toFindOptions(p.content.userQuery, p.entity),
        [p.content.userQuery, p.entity?.key()]);

    const [version, updateVersion] = useVersion();

    React.useEffect(() => {
        if (foResult && typeof foResult == "object") {
            const fo = foResult;
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
    }, [foResult, p.partEmbedded]);

    const vsc = React.useRef<SearchValueController>(null);
    const forceUpdate = useForceUpdate();

    // No UserQuery: the value is a token over the DASHBOARD's entity type, filtered by the current entity
    // (Signum's fallback FindOptions).
    let fo = foResult;
    if (p.content.userQuery == null) {
        const entityTypeName = p.dashboardController.dashboard.entityType?.toString();
        fo = entityTypeName == null ? null : {
            queryName: entityTypeName,
            filterOptions: [{ token: "Entity", value: p.entity }],
        } as FindOptions;
    }

    if (!fo)
        return <span>{JavascriptMessage.loading.niceToString()}</span>;

    if (fo == "not-findable")
        return null;

    if (p.dashboardController.isLoading)
        return <span>{JavascriptMessage.loading.niceToString()}...</span>;

    const foExpanded = p.dashboardController.applyToFindOptions(p.partEmbedded, fo);

    p.customDataRef.current = {
        findOptions: foExpanded,
        refresh: updateVersion,
    } as BigValuePartHandler;

    const clickable = p.content.userQuery != null && (p.content.isClickable ?? true);
    const customColor = p.partEmbedded.customColor;

    async function handleNavigate(e: React.MouseEvent): Promise<void> {
        if (p.content.customUrl) {
            const url = p.content.customUrl;
            if (/^https?:\/\//i.test(url))
                window.open(url);
            else
                AppContext.pushOrOpenInTab(url, e);
        } else {
            const url = await UserQueriesClient.getUserQueryUrl(p.content.userQuery!, p.entity);
            AppContext.navigate(url);
        }
    }

    const custom = p.content.customBigValue
        ? BigValueClient.renderCustomBigValue(p.content.customBigValue, { content: p.content, entity: p.entity, value: vsc.current?.value })
        : null;

    const tooltipHtml = p.partEmbedded.tooltip;
    const icon = parseIcon(p.partEmbedded.iconName);

    function renderCardContent(): React.JSX.Element {
        return (
            <>
                <div className="dashboard-flex">
                    <div className="left">
                        <h3>
                            <SearchValue ref={vsc} findOptions={foExpanded} isLink={false} isBadge={false} deps={[...p.deps ?? [], version]}
                                onValueChange={forceUpdate}
                                onInitialValueLoaded={forceUpdate}
                                valueToken={p.content.valueToken?.tokenString}
                                onRender={custom?.value == null ? undefined : () => custom?.value}
                            />
                        </h3>
                    </div>
                    <div className="right">
                        {icon && <FontAwesomeIcon role="img" icon={icon} color={p.partEmbedded.iconColor ?? undefined} size="2x" />}
                    </div>
                </div>
                <h2 className="medium h3">
                    {custom?.message ?? (p.partEmbedded.title || p.content.userQuery?.displayName || p.content.valueToken?.tokenString)}
                    {tooltipHtml && <DashboardTooltipIcon tooltipHtml={tooltipHtml} className="ms-2" iconClassName="sf-tooltip-icon" />}
                </h2>
            </>
        );
    }

    const bodyStyle: React.CSSProperties = {
        backgroundColor: customColor ?? undefined,
        color: p.partEmbedded.titleColor ?? (customColor ? getContrastingTextColor(customColor) : "var(--bs-body-color)"),
    };

    return (
        <div className={classes("card", "border-tertiary shadow-sm mb-3 w-100", "o-hidden")}
            style={{
                backgroundColor: customColor ?? undefined,
                color: customColor ? getContrastingTextColor(customColor) : "var(--bs-body-color)",
            }}>
            {clickable ? (
                <button type="button"
                    onClick={e => { if (p.content.navigate) handleNavigate(e); else vsc.current!.handleClick(e); }}
                    className="card-body border-0 bg-transparent text-start w-100"
                    style={bodyStyle}>
                    {renderCardContent()}
                </button>
            ) : (
                <div className="card-body" style={bodyStyle}>
                    {renderCardContent()}
                </div>
            )}
        </div>
    );
}
