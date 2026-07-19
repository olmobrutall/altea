import type { QueryToken } from "./tokens/queryToken";
import { Pagination } from "./requests";

// Port of Signum's `ResultColumn`/`ResultTable`/`ResultRow` (DynamicQuery/Requests/ResultTable.cs):
// the materialised, columnar output of a query. Each ResultColumn holds one token's values across
// all rows; a ResultRow reads a column's value at its row index.

export class ResultColumn {
    index = 0;
    constructor(public readonly token: QueryToken, public readonly values: unknown[]) { }
    toString(): string { return `Col${this.index}: ${this.token.toString()}`; }
}

export class ResultRow {
    constructor(public readonly index: number, private readonly table: ResultTable) { }

    // Value by column index (Signum's row[i]).
    value(columnIndex: number): unknown {
        return this.table.columns[columnIndex].values[this.index];
    }
    // Value by token (Signum's row[column]).
    getValue(token: QueryToken): unknown {
        return this.table.getColumn(token).values[this.index];
    }
    // The row's entity (the "Entity" column), if present.
    get entity(): unknown {
        return this.table.entityColumn?.values[this.index];
    }
}

export class ResultTable {
    readonly entityColumn?: ResultColumn;
    readonly columns: ResultColumn[];
    readonly rows: ResultRow[];

    constructor(
        allColumns: ResultColumn[],
        public readonly totalElements: number | undefined,
        public readonly pagination: Pagination,
    ) {
        // Signum splits out the row's own "Entity" column from the display columns.
        this.entityColumn = allColumns.find(c => c.token.isEntity());
        this.columns = allColumns.filter(c => !c.token.isEntity());
        this.columns.forEach((c, i) => { c.index = i; });

        const rowCounts = new Set(allColumns.map(c => c.values.length));
        if (rowCounts.size > 1)
            throw new Error("ResultColumns have inconsistent row counts");
        const rowCount = allColumns.length === 0 ? 0 : allColumns[0].values.length;
        this.rows = Array.from({ length: rowCount }, (_, i) => new ResultRow(i, this));
    }

    get hasEntities(): boolean { return this.entityColumn != undefined; }

    private _byToken?: Map<string, ResultColumn>;
    getColumn(token: QueryToken): ResultColumn {
        if (token.isEntity() && this.entityColumn != undefined)
            return this.entityColumn;
        this._byToken ??= new Map(this.columns.map(c => [c.token.fullKey(), c]));
        const c = this._byToken.get(token.fullKey());
        if (c == undefined)
            throw new Error(`Token ${token.fullKey()} not found in the ResultTable`);
        return c;
    }

    get totalPages(): number | undefined {
        return this.pagination instanceof Pagination.Paginate && this.totalElements != undefined
            ? Math.ceil(this.totalElements / this.pagination.elementsPerPage)
            : undefined;
    }
}
