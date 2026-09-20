import * as React from "react";
import { Link } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import type { Entity } from "@altea/altea/data/entity";
import { TypeContext, mlistItemContext } from "@altea/altea/client/TypeContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { getTypeName } from "@altea/altea/client/Reflection";
import { ErrorBoundary } from "@altea/altea/client/Components/ErrorBoundary";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useAPI, useForceUpdate } from "@altea/altea/client/Hooks";
import PinnedFilterBuilder from "@altea/altea/client/SearchControl/PinnedFilterBuilder";
import { DashboardEntity, DashboardEntity_Part, DashboardMessage, type IPartEntity } from "../../data/Dashboard";
import { DashboardClient, type PanelPartContentProps } from "../DashboardClient";
import type { CachedQueryJS } from "../../data/CachedQuery";
import { DashboardController } from "./DashboardFilterController";
import { DashboardTooltipIcon } from "./DashboardTooltipIcon";
import { parseIcon, fallbackIcon, getContrastingTextColor } from "@altea/altea/client/Components/IconHelpers";
import "../Dashboard.css";

// Port of Signum's Signum.Dashboard/View/DashboardView.tsx — lays the parts out on the 12-column grid
// (optionally COMBINING consecutive rows whose columns line up, so parts stack in a shared column), renders
// each part's card chrome, and hosts the dashboard-level pinned filters.
//
// altea divergences: `translated(part, …)` is not ported
// (raw stored text); a part row is a plain @part entity, so `mlistItemContext` yields row contexts directly
// (Signum's `c.value.element`).

export default function DashboardView(p: {
    dashboard: DashboardEntity,
    /** The snapshot serving each user asset (DashboardClient.toCachedQueries), or none. */
    cachedQueries?: { [userAssetKey: string]: Promise<CachedQueryJS> },
    entity?: Entity,
    embedded?: boolean,
    deps?: React.DependencyList;
    reload: () => void;
    hideEditButton?: boolean;
}): React.JSX.Element {

    const forceUpdate = useForceUpdate();
    const dashboardController = React.useMemo(() => new DashboardController(forceUpdate, p.dashboard), [p.dashboard]);
    dashboardController.setIsLoading();

    function renderBasic(): React.JSX.Element {
        const ctx = TypeContext.root(p.dashboard);

        return (
            <div>
                <div className="sf-dashboard-view">
                    {
                        mlistItemContext(ctx.subCtx(a => a.parts))
                            .groupBy(c => (c.value.row as number).toString())
                            .orderBy(gr => Number(gr.key))
                            .map(gr =>
                                <div className="row row-control-panel" key={"row" + gr.key}>
                                    {gr.elements.orderBy(c => c.value.startColumn as number).map((c, j, list) => {

                                        const prev = j == 0 ? undefined : list[j - 1].value;
                                        const offset = (c.value.startColumn as number) - (prev ? ((prev.startColumn as number) + (prev.columns as number)) : 0);

                                        return (
                                            <div key={j} className={`col-sm-${c.value.columns} offset-sm-${offset}`}>
                                                <PanelPart ctx={c} entity={p.entity}
                                                    dashboardController={dashboardController} reload={p.reload} cachedQueries={p.cachedQueries} deps={p.deps} />
                                            </div>
                                        );
                                    })}
                                </div>)
                    }
                </div>
            </div>
        );
    }

    function renderCombinedRows(): React.JSX.Element {
        const ctx = TypeContext.root(p.dashboard);

        const rows = mlistItemContext(ctx.subCtx(a => a.parts))
            .groupBy(c => (c.value.row as number).toString())
            .orderBy(g => Number(g.key))
            .map(g => ({
                columns: g.elements.orderBy(a => a.value.startColumn as number).map(part => ({
                    startColumn: part.value.startColumn as number,
                    columnWidth: part.value.columns as number,
                    parts: [part],
                }) as CombinedColumn),
            }) as CombinedRow);

        const combinedRows = combineRows(rows);

        return (
            <div className="sf-dashboard-view">
                {combinedRows.map((r, i) =>
                    <div className="row row-control-panel" key={"row" + i}>
                        {r.columns.orderBy(c => c.startColumn).map((c, j, list) => {
                            const last = j == 0 ? undefined : list[j - 1];
                            const offset = c.startColumn - (last ? (last.startColumn + last.columnWidth) : 0);
                            return (
                                <div key={j} className={`col-sm-${c.columnWidth} offset-sm-${offset}`} style={{ display: "flex", flexDirection: "column" }}>
                                    {c.parts.map((pctx, k) =>
                                        <PanelPart key={k} ctx={pctx} entity={p.entity} dashboardController={dashboardController} cachedQueries={p.cachedQueries}
                                            reload={p.reload} deps={p.deps} flex />)}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className={p.embedded ? "sf-dashboard-view-embedded" : undefined}>
            {p.hideEditButton != true &&
                <div className="d-flex flex-row-reverse align-items-center m-1">
                    {DashboardClient.onDashboardPageActions().map((fn, i) => <React.Fragment key={i}>{fn(p.dashboard)}</React.Fragment>)}
                    {!Navigator.isReadOnly(DashboardEntity) &&
                        <Link className="sf-hide" style={{ textDecoration: "none" }} to={Navigator.navigateRoute(p.dashboard)} title={DashboardMessage.Edit.niceToString()}>
                            <FontAwesomeIcon aria-hidden={true} icon="pen-to-square" />
                        </Link>}
                </div>}
            <div>
                {Array.from(dashboardController.pinnedFilters.values())
                    .filter(pf => pf.pinnedFilters.length > 0)
                    .map((pf, i) => <PinnedFilterBuilder key={i}
                        queryToken={pf.queryToken}
                        filterOptions={pf.pinnedFilters}
                        onFiltersChanged={forceUpdate} />)}
                {
                    p.dashboard.combineSimilarRows ?
                        renderCombinedRows() :
                        renderBasic()
                }
            </div>
        </div>
    );
}

function combineRows(rows: CombinedRow[]): CombinedRow[] {

    const newRows: CombinedRow[] = [];

    for (let i = 0; i < rows.length; i++) {

        const row = {
            columns: rows[i].columns.map(c => ({
                startColumn: c.startColumn,
                columnWidth: c.columnWidth,
                parts: [...c.parts],
            }) as CombinedColumn),
        } as CombinedRow;

        newRows.push(row);
        let j = 1;
        for (; i + j < rows.length; j++) {
            if (!tryCombine(row, rows[i + j]))
                break;
        }

        i = i + j - 1;
    }

    return newRows;
}

function tryCombine(row: CombinedRow, newRow: CombinedRow): boolean {
    if (!newRow.columns.every(nc =>
        row.columns.some(c => identical(nc, c)) ||
        !row.columns.some(c => overlaps(nc, c))))
        return false;

    newRow.columns.forEach(nc => {
        const c = row.columns.singleOrNull(c2 => identical(c2, nc));

        if (c)
            c.parts.push(...nc.parts);
        else
            row.columns.push(nc);
    });

    return true;
}

export function identical(col1: CombinedColumn, col2: CombinedColumn): boolean {
    return col1.startColumn == col2.startColumn && col1.columnWidth == col2.columnWidth;
}

export function overlaps(col1: CombinedColumn, col2: CombinedColumn): boolean {
    const columnEnd1 = col1.startColumn + col1.columnWidth;
    const columnEnd2 = col2.startColumn + col2.columnWidth;

    return !(columnEnd1 <= col2.startColumn || columnEnd2 <= col1.startColumn);
}

interface CombinedRow {
    columns: CombinedColumn[];
}

interface CombinedColumn {
    startColumn: number;
    columnWidth: number;
    parts: TypeContext<DashboardEntity_Part>[];
}

export interface PanelPartProps {
    ctx: TypeContext<DashboardEntity_Part>;
    entity?: Entity;
    cachedQueries?: { [userAssetKey: string]: Promise<CachedQueryJS> };
    deps?: React.DependencyList;
    dashboardController: DashboardController;
    flex?: boolean;
    reload: () => void;
}

export function PanelPart(p: PanelPartProps): React.JSX.Element | null {
    const content = p.ctx.value.content;
    // The part-renderer registry is keyed by the part's CLEAN type name ("TextPart"), like every other altea
    // type registry — never the ctor name ("TextPartEntity").
    const typeName = content == null ? "" : getTypeName(content);

    const customDataRef = React.useRef<any>(undefined);

    // Names the panel's region from its own title, so moving into a panel says which one it is. Declared
    // up here with the other hooks: there is an early return below, and a hook after it would change the
    // hook count between renders.
    const titleId = React.useId();

    const state = useAPI(() => DashboardClient.partRenderers[typeName]?.component()
        .then((c: React.ComponentType<PanelPartContentProps<IPartEntity>>) => ({ component: c, lastType: typeName }))
        ?? Promise.resolve(undefined),
        [typeName], { avoidReset: true });

    if (state == null || state.lastType == null)
        return null;

    const part = p.ctx.value;
    const renderer = DashboardClient.partRenderers[typeName];
    const lite = p.entity ? p.entity.toLite() : undefined;
    // Signum's `partRowId`: the row id identifies the part, and a tour targets it through
    // `data-part-content`. UNDEFINED while the part is unsaved (Signum's `rowId?.toString()`), so the
    // attribute is omitted rather than rendered as the string "undefined" — there is nothing to target yet.
    const partContentKey = part.id == null ? undefined : String(part.id);

    const contentProps = {
        partEmbedded: part,
        content: content,
        entity: lite,
        deps: p.deps,
        dashboardController: p.dashboardController,
        customDataRef: customDataRef,
        // Always an object, never undefined: a part reads it by asset key and "no snapshot" is an absent
        // entry, so every part needs one branch rather than two.
        cachedQueries: p.cachedQueries ?? {},
    } as PanelPartContentProps<IPartEntity>;

    if (renderer.withPanel && !renderer.withPanel(content, lite)) {
        return (
            <div data-part-content={partContentKey}>
                <ErrorBoundary>
                    {React.createElement(state.component, contentProps)}
                </ErrorBoundary>
            </div>
        );
    }

    const titleText = part.title ?? (renderer.defaultTitle ? renderer.defaultTitle(content) : content.toString());
    const tooltipHtml = part.tooltip;
    const icon = parseIcon(part.iconName);
    const iconColor = part.iconColor;

    const iconElement = icon ? (
        <FontAwesomeIcon aria-hidden={true} icon={fallbackIcon(icon)} color={iconColor ?? undefined} className="me-1" style={{ fontSize: "16px" }} />
    ) : null;

    const titleInner = (
        <>
            {iconElement}{titleText}
            {tooltipHtml && <DashboardTooltipIcon tooltipHtml={tooltipHtml} className="ms-2" iconClassName="sf-tooltip-icon" />}
        </>
    );

    // A panel's title IS the heading of that panel, but it was plain bold text in the card-header, so a
    // dashboard was a flat wall of content with nothing to navigate between. h2 sits under the page's own
    // h1; `font: inherit` keeps the card-header's existing size and weight, and margin 0 its spacing, so
    // nothing moves. Parts registered with withPanel: false render no header and supply their own heading.
    //
    // Only an ACTUAL title becomes a heading: a part can have an empty title and still show a header for
    // its icon or its tooltip, and an <h2> with no text would put a blank entry in the heading list.
    const headingStyle: React.CSSProperties = { font: "inherit", margin: 0 };
    const title = part.hideTitle ? null :
        titleText ? <h2 id={titleId} style={headingStyle}>{titleInner}</h2> :
            (icon || tooltipHtml) ? <span>{titleInner}</span> : null;

    const dashboardFilter = p.dashboardController?.filters.get(part);

    function handleClearFilter(): void {
        p.dashboardController.clearFilters(part);
    }

    return (
        // A titled panel is a REGION named by its own title. A heading alone is only found by someone going
        // looking for it; a landmark is announced on the way in, which is what tells a screen reader user
        // that they have moved from one panel of the dashboard to another.
        <div className={classes("card", !part.customColor && "border-tertiary", "shadow-sm", "mb-4")}
            role={titleText ? "region" : undefined} aria-labelledby={titleText ? titleId : undefined}
            style={{ flex: p.flex ? 1 : undefined }}>
            {title &&
                <div className={classes("card-header fw-bold", "sf-show-hover", "d-flex")}
                    style={{
                        backgroundColor: part.customColor ?? undefined,
                        color: part.customColor ? getContrastingTextColor(part.customColor) : undefined,
                    }}
                >
                    {renderer.handleTitleClick == undefined ? title :
                        <LinkButton title={undefined} className="sf-pointer"
                            style={{ color: part.titleColor ?? (part.customColor ? getContrastingTextColor(part.customColor) : undefined), textDecoration: "none" }}
                            onClick={e => { renderer.handleTitleClick!(content, lite, customDataRef, e); }}>
                            {title}
                        </LinkButton>
                    }
                    {/* DIVERGENCE (a Signum BUG, fixed rather than mirrored): Signum writes the pill
                        `bg-tertiary text-dark`, and `text-dark` is the FIXED `--bs-dark-rgb` (33,37,41) —
                        the dark theme's own card-header background, so the pill was invisible there.
                        `text-bg-tertiary` is Bootstrap's combined helper: it pairs the tertiary surface
                        with `--bs-body-color`, which follows the theme. */}
                    {
                        dashboardFilter && <span className="badge text-bg-tertiary border ms-2 sf-filter-pill">
                            {dashboardFilter.rows.length} {DashboardMessage.RowsSelected.niceToString().forGenderAndNumber(dashboardFilter.rows.length)}
                            <button type="button" aria-label={DashboardMessage.Close.niceToString()} className="btn-close" onClick={handleClearFilter} />
                        </span>
                    }

                    <div className="ms-auto">
                        {renderer.customTitleButtons?.(content, lite, customDataRef)}
                        {
                            renderer.handleEditClick &&
                            <LinkButton className="sf-pointer sf-hide" title={DashboardMessage.Edit.niceToString()}
                                onClick={e => { renderer.handleEditClick!(content, lite, customDataRef, e).then((v: boolean) => v && p.reload()); }}>
                                <FontAwesomeIcon aria-hidden={true} icon="pen-to-square" className="me-1" />
                            </LinkButton>
                        }
                    </div>
                </div>
            }
            <div data-part-content={partContentKey} className="card-body py-2 px-3 d-flex flex-column">
                <ErrorBoundary>
                    {React.createElement(state.component, contentProps)}
                </ErrorBoundary>
            </div>
        </div>
    );
}
