import * as React from "react";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import { toAbsoluteUrl } from "@altea/altea/client/AppContext";
import { withoutAggregate } from "@altea/altea/client/FindOptions";
import type { ColumnOption, ColumnOptionParsed, FilterOptionParsed } from "@altea/altea/client/FindOptions";
import type { ResultRow, ResultTable } from "@altea/altea/data/dynamicQuery/queryRequest";
import { ChartRequestModel } from "../../data/ChartRequest";
import { ChartClient } from "../ChartClient";

// Copy-and-fix of Signum.Chart/Templates/ChartTable.tsx — the chart's data as a plain result TABLE (the
// "Show data" toggle of a chart page / a dashboard's UserChartPart). Header click re-orders the chart's
// columns; double-clicking a row drills down (the row's entity, else the underlying query filtered by that
// row's key columns).
//
// altea divergences: no FullscreenComponent wrapper (not ported); `token.fullKey` / `hasAggregate(t)` /
// `t.queryTokenType == "Aggregate"` become the QueryToken CLASS's `fullKey()` / `hasAggregate()` /
// `isAggregate()`; `cr.columns` is a plain `ChartColumnEmbedded[]` (altea has no MList, so no `.element`).

interface ChartTableProps {
    resultTable: ResultTable;
    chartRequest: ChartRequestModel;
    lastChartRequest: ChartRequestModel;
    onOrderChanged: () => void;
    onReload?: (e: React.MouseEvent<any>) => void;
}

export default function ChartTableComponent(p: ChartTableProps): React.JSX.Element {

    function handleHeaderClick(e: React.MouseEvent<any>, col: ColumnOptionParsed): void {
        const chartCol = p.chartRequest.columns
            .firstOrNull(a => a.token?.token != null && a.token.token.fullKey() == col.token!.fullKey());

        if (chartCol) {
            ChartClient.handleOrderColumn(p.chartRequest, chartCol, e.shiftKey);
            p.onOrderChanged();
        }
    }

    function handleOnDoubleClick(e: React.MouseEvent<HTMLTableRowElement>, row: ResultRow): void {
        const lcr = p.lastChartRequest;

        if (row.entity) {
            window.open(toAbsoluteUrl(Navigator.navigateRoute(row.entity)));
            return;
        }

        const filters = lcr.filterOptions.map(f => withoutAggregate(f)!).filter(Boolean);
        const columns: ColumnOption[] = [];

        lcr.columns.filter(a => a.token).forEach((a, i) => {

            const t = a.token!.token!;

            if (!t.hasAggregate()) {
                filters.push({
                    token: t,
                    operation: "EqualTo",
                    value: row.columns[i],
                    frozen: false,
                } as FilterOptionParsed);
            }

            if (t.parent != undefined) { // Avoid Count and simple Columns that are already added
                if (t.isAggregate())
                    columns.push({ token: t.parent.fullKey(), summaryToken: t.fullKey() });
                else
                    columns.push({ token: t.fullKey() });
            }
        });

        window.open(toAbsoluteUrl(Finder.findOptionsPath({
            queryName: lcr.queryKey,
            filterOptions: Finder.toFilterOptions(filters),
            columnOptions: columns,
            columnOptionsMode: "ReplaceOrAdd",
        })));
    }

    function orderClassName(column: ColumnOptionParsed): string {
        if (column.token == undefined)
            return "";

        const c = p.chartRequest.columns
            .filter(a => a.token?.token != null && a.token.token.fullKey() == column.token!.fullKey())
            .firstOrNull();

        if (c == undefined || c.orderByType == null)
            return "";

        return (c.orderByType == "Ascending" ? "asc" : "desc") + (" l" + c.orderByIndex);
    }

    const resultTable = p.resultTable;
    const chartRequest = p.chartRequest;

    const qs = Finder.getSettings(chartRequest.queryKey);

    const columns = chartRequest.columns.filter(cc => cc.token != undefined)
        .map(cc => ({ token: cc.token!.token, displayName: cc.displayName } as ColumnOptionParsed))
        .map(co => {

            const formatter = (qs?.formatters && qs.formatters[co.token!.fullKey()])
                ?? Finder.formatRules.filter(a => a.isApplicable(co.token!, undefined, undefined))
                    .last("FormatRules").formatter(co.token!, undefined, undefined);

            let resultIndex: number | "Entity" = resultTable.columns.indexOf(co.token!.fullKey());

            if (resultIndex == -1 && co.token?.isEntity())
                resultIndex = "Entity";

            return ({ column: co, cellFormatter: formatter, resultIndex: resultIndex });
        });

    const hasEntity = !ChartClient.hasAggregates(chartRequest);

    const entityFormatter = qs?.entityFormatter
        ?? Finder.entityFormatRules.filter(a => a.isApplicable(undefined)).last("EntityFormatRules").formatter;

    return (
        <div className="sf-scroll-table-container">
            <table className="sf-search-results table table-hover table-sm">
                <thead>
                    <tr>
                        {hasEntity && <th></th>}
                        {columns.map((col, i) =>
                            <th key={i} data-column-name={col.column.token!.fullKey()}
                                onClick={e => handleHeaderClick(e, col.column)}>
                                <span className={"sf-header-sort " + orderClassName(col.column)} />
                                <span> {col.column.displayName || col.column.token!.niceName()}</span>
                            </th>)}
                    </tr>
                </thead>
                <tbody>
                    {
                        resultTable.rows.map((row, i) => {
                            const ctx: Finder.CellFormatterContext = {
                                refresh: undefined,
                                columns: resultTable.columns,
                                row: row,
                                rowIndex: i,
                            };
                            return (
                                <tr key={i} onDoubleClick={e => handleOnDoubleClick(e, row)}>
                                    {hasEntity &&
                                        <td className={entityFormatter.cellClass}>
                                            {entityFormatter.formatter(ctx)}
                                        </td>
                                    }
                                    {columns.map((c, j) =>
                                        <td key={j} className={c.cellFormatter && c.cellFormatter.cellClass}>
                                            {c.resultIndex == -1 || c.cellFormatter == undefined ? undefined :
                                                c.cellFormatter.formatter(c.resultIndex == "Entity" ? row.entity : row.columns[c.resultIndex], ctx,
                                                    { column: c.column, resultIndex: c.resultIndex, columnIndex: j, cellFormatter: c.cellFormatter })}
                                        </td>)
                                    }
                                </tr>
                            );
                        })
                    }
                </tbody>
            </table>
        </div>
    );
}
