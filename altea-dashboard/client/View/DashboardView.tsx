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
import { DashboardEntity, DashboardEntity_Parts, DashboardMessage, type IPartEntity } from "../../data/Dashboard";
import { DashboardClient, type PanelPartContentProps } from "../DashboardClient";
import { DashboardController } from "./DashboardFilterController";
import { DashboardTooltipIcon } from "./DashboardTooltipIcon";
import { parseIcon, fallbackIcon, getContrastingTextColor } from "@altea/altea/client/Components/IconHelpers";
import "../Dashboard.css";

// Port of Signum's Signum.Dashboard/View/DashboardView.tsx — lays the parts out on the 12-column grid
// (optionally COMBINING consecutive rows whose columns line up, so parts stack in a shared column), renders
// each part's card chrome, and hosts the dashboard-level pinned filters.
//
// altea divergences: no `cachedQueries` prop (CachedQuery is deferred); `translated(part, …)` is not ported
// (raw stored text); a part row is a plain @part entity, so `mlistItemContext` yields row contexts directly
// (Signum's `c.value.element`).

export default function DashboardView(p: {
    dashboard: DashboardEntity,
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
                                                    dashboardController={dashboardController} reload={p.reload} deps={p.deps} />
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
                                        <PanelPart key={k} ctx={pctx} entity={p.entity} dashboardController={dashboardController}
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
                    {DashboardClient.onDashboardPageActions.map((fn, i) => <React.Fragment key={i}>{fn(p.dashboard)}</React.Fragment>)}
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
    parts: TypeContext<DashboardEntity_Parts>[];
}

export interface PanelPartProps {
    ctx: TypeContext<DashboardEntity_Parts>;
    entity?: Entity;
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

    const state = useAPI(() => DashboardClient.partRenderers[typeName]?.component()
        .then((c: React.ComponentType<PanelPartContentProps<IPartEntity>>) => ({ component: c, lastType: typeName }))
        ?? Promise.resolve(undefined),
        [typeName], { avoidReset: true });

    if (state == null || state.lastType == null)
        return null;

    const part = p.ctx.value;
    const renderer = DashboardClient.partRenderers[typeName];
    const lite = p.entity ? p.entity.toLite() : undefined;
    const partContentKey = part.guid;

    const contentProps = {
        partEmbedded: part,
        content: content,
        entity: lite,
        deps: p.deps,
        dashboardController: p.dashboardController,
        customDataRef: customDataRef,
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

    const title = part.hideTitle ? null : !icon ? (
        <>
            {titleText}
            {tooltipHtml && <DashboardTooltipIcon tooltipHtml={tooltipHtml} className="ms-2" iconClassName="sf-tooltip-icon" />}
        </>
    ) : (
        <span>
            {iconElement}{titleText}
            {tooltipHtml && <DashboardTooltipIcon tooltipHtml={tooltipHtml} className="ms-2" iconClassName="sf-tooltip-icon" />}
        </span>
    );

    const dashboardFilter = p.dashboardController?.filters.get(part);

    function handleClearFilter(): void {
        p.dashboardController.clearFilters(part);
    }

    return (
        <div className={classes("card", !part.customColor && "border-tertiary", "shadow-sm", "mb-4")} style={{ flex: p.flex ? 1 : undefined }}>
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
                    {
                        dashboardFilter && <span className="badge bg-tertiary text-dark border ms-2 sf-filter-pill">
                            {dashboardFilter.rows.length} {DashboardMessage.RowsSelected.niceToString()}
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
