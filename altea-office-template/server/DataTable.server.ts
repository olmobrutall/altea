// altea's stand-in for `System.Data.DataTable` — the shape TableBinder binds into a chart or a table.
//
// Signum.Word leans on ADO.NET's DataTable as the neutral currency between "where the data came from"
// (a model method, a UserQuery, a UserChart) and "where it goes" (a DrawingML table's cells, a chart's
// series/categories/values). TypeScript has no such type, so this is the minimum that TableBinder needs:
// ordered columns carrying a name / caption / value kind, and rows of positional values.
//
// `DataColumnKind` replaces `DataColumn.DataType` (a System.Type). TableBinder only ever asks one question
// of it — "can this column be a chart series?", i.e. is it numeric or a date — so a three-way tag is both
// sufficient and clearer than carrying a TypeReference around.

/** What a column holds, to the only resolution TableBinder cares about. */
export type DataColumnKind = "number" | "date" | "other";

export class DataColumn {
    constructor(
        readonly columnName: string,
        readonly kind: DataColumnKind = "other",
        /** The display name (Signum's `DataColumn.Caption`); falls back to `columnName`. */
        readonly caption?: string,
    ) { }

    get displayName(): string { return this.caption ?? this.columnName; }

    /** Signum's `ReflectionTools.IsNumber(col.DataType) || IsDate(col.DataType)` chart-series test. */
    get canBeChartSeries(): boolean { return this.kind === "number" || this.kind === "date"; }
}

export class DataTable {
    readonly columns: DataColumn[] = [];
    readonly rows: unknown[][] = [];

    constructor(columns: DataColumn[] = [], rows: unknown[][] = []) {
        this.columns = columns;
        this.rows = rows;
    }

    /** The value of `row` in the column at `index`. */
    static valueAt(row: unknown[], index: number): unknown {
        return row[index];
    }

    indexOfColumn(column: DataColumn): number {
        return this.columns.indexOf(column);
    }
}

/**
 * Signum's `ToDataTablePivot` — turn a three-column (y, x, value) result into a matrix: one output row per
 * distinct `rowColumnIndex` value, one output column per distinct `columnColumnIndex` value.
 *
 * A chart template with a single series cannot show "sales per month PER country" from a flat result; the
 * author writes `Pivot(0,1,2)` in the shape's alternative text and this reshapes the table so each country
 * becomes its own series.
 */
export function toDataTablePivot(dt: DataTable, rowColumnIndex: number, columnColumnIndex: number, valueIndex: number): DataTable {
    // Insertion-ordered so the output is deterministic (C#'s GroupAggregateToDictionary + Distinct).
    const grouped = new Map<unknown, Map<unknown, unknown>>();
    const allColumns: unknown[] = [];
    const seenColumn = new Set<unknown>();

    for (const row of dt.rows) {
        const rowKey = row[rowColumnIndex];
        let inner = grouped.get(rowKey);
        if (inner == null) {
            inner = new Map<unknown, unknown>();
            grouped.set(rowKey, inner);
        }
        const colKey = row[columnColumnIndex];
        inner.set(colKey, row[valueIndex]);
        if (!seenColumn.has(colKey)) {
            seenColumn.add(colKey);
            allColumns.push(colKey);
        }
    }

    const rowColumn = dt.columns[rowColumnIndex];
    const valueColumn = dt.columns[valueIndex];

    const columns = [new DataColumn(rowColumn.columnName, rowColumn.kind, rowColumn.caption)];
    for (const c of allColumns)
        columns.push(new DataColumn(String(c), valueColumn.kind));

    const rows = [...grouped].map(([key, inner]) => [key, ...allColumns.map(c => inner.get(c))]);

    return new DataTable(columns, rows);
}

/** Signum's `UserChartDataTableProvider.ParsePivot` — reads `Pivot(0,1,2)` out of the alternative text. */
export function parsePivot(pivotStr: string): { colY: number; colX: number; colValue: number } | undefined {
    const m = /^Pivot\s*\(\s*(?<colY>\d+)\s*,\s*(?<colX>\d+)\s*,\s*(?<colValue>\d+)\s*\)\s*$/.exec(pivotStr);
    if (m == null)
        return undefined;

    return {
        colY: parseInt(m.groups!["colY"], 10),
        colX: parseInt(m.groups!["colX"], 10),
        colValue: parseInt(m.groups!["colValue"], 10),
    };
}
