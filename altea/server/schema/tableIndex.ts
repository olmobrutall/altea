import type { ComputedColumn, IColumn } from './column';
import { PostgresTsVectorColumn } from './column';
import type { Table } from './table';
import { sqlEscape } from '../linq/sqlEscape';

// Port of Signum's Engine/Schema/TableIndexes.cs TableIndex, scoped to what altea models: a
// (possibly unique) index over one or more columns, with optional INCLUDE columns and an
// optional filtered (partial) WHERE predicate. Like Signum's TableIndex.Where, the predicate is
// stored PRE-RENDERED to SQL — the filtered-index lambda is translated once at registration
// time (IndexWhereExpressionVisitor / getIndexWhere), when the dialect is known. The index NAME
// is still computed by the SqlBuilder. The clustered / partitioned / indexed-view cases Signum
// also handles are deferred (no altea model yet).
export class TableIndex {
    includeColumns?: IColumn[];
    unique: boolean;
    // The filtered (partial) index's WHERE clause, already rendered to SQL (Signum's
    // TableIndex.Where). Undefined for a full index.
    where?: string;

    constructor(
        public readonly table: Table,
        public readonly columns: IColumn[],
        options?: { unique?: boolean; includeColumns?: IColumn[]; where?: string },
    ) {
        this.unique = options?.unique ?? false;
        this.includeColumns = options?.includeColumns;
        this.where = options?.where;
    }
}

// ---- Full-text index (Signum's FullTextTableIndex) ------------------------------------------

// SQL Server change-tracking mode for a full-text index (Signum's FullTextIndexChangeTracking).
export type FullTextIndexChangeTracking = 'Manual' | 'Auto' | 'Off' | 'Off_NoPopulation';

// The SQL fragment for a change-tracking mode (Signum's GetSqlServerChangeTracking).
export function fullTextChangeTrackingSql(ct: FullTextIndexChangeTracking): string {
    switch (ct) {
        case 'Manual': return 'MANUAL';
        case 'Auto': return 'AUTO';
        case 'Off': return 'OFF';
        case 'Off_NoPopulation': return 'OFF, NO POPULATION';
    }
}

// A Postgres tsvector lexeme weight (A highest … D lowest).
export type TsVectorWeight = 'A' | 'B' | 'C' | 'D';

export interface FullTextSqlServerOptions {
    // The FULLTEXT CATALOG the index lives in (Signum default: "DefaultFullTextCatallog").
    catalogName: string;
    changeTracking?: FullTextIndexChangeTracking;
    stoplistName?: string;
    propertyListName?: string;
}

export interface FullTextPostgresOptions {
    // Name of the generated tsvector column (Signum default: "tsvector").
    tsVectorColumnName: string;
    // The text-search configuration / language (Signum default: "english").
    configuration: string;
    // Per-column lexeme weight. Unset columns default to A, B, C, D, D, … in column order.
    weights: Record<string, TsVectorWeight>;
}

// Signum's default FULLTEXT CATALOG name (note the doubled-l spelling matches Signum's constant).
export const DEFAULT_FULLTEXT_CATALOG = 'DefaultFullTextCatallog';
// The fixed SQL Server full-text index name (Signum's SqlServerOptions.FULL_TEXT).
export const FULL_TEXT_INDEX_NAME = 'FULL_TEXT_INDEX';

// A full-text index over one or more string columns (Signum's FullTextTableIndex). Always
// non-unique. On SQL Server it becomes a `CREATE FULLTEXT INDEX … KEY INDEX <pk> ON <catalog>`
// over the source columns; on Postgres it materialises a persisted `tsvector` generated column
// (see generateColumns / getComputedColumn) and a GIN index over it.
export class FullTextTableIndex extends TableIndex {
    readonly sqlServer: FullTextSqlServerOptions;
    readonly postgres: FullTextPostgresOptions;

    constructor(
        table: Table,
        columns: IColumn[],
        options?: { sqlServer?: Partial<FullTextSqlServerOptions>; postgres?: Partial<FullTextPostgresOptions> },
    ) {
        super(table, columns, { unique: false });
        this.sqlServer = { catalogName: DEFAULT_FULLTEXT_CATALOG, ...options?.sqlServer };
        this.postgres = {
            tsVectorColumnName: PostgresTsVectorColumn.DEFAULT_NAME,
            configuration: 'english',
            weights: {},
            ...options?.postgres,
        };
    }

    // Assign a default weight to any column without one: A, B, C, D, then D for the rest
    // (Signum's PostgresOptions.DefaultWeights). Idempotent.
    private applyDefaultWeights(): void {
        const order: TsVectorWeight[] = ['A', 'B', 'C', 'D'];
        this.columns.forEach((c, i) => {
            if (this.postgres.weights[c.name] == null)
                this.postgres.weights[c.name] = order[Math.min(i, 3)];
        });
    }

    // The persisted generated-column expression backing the Postgres tsvector column
    // (Signum's FullTextTableIndex.GetComputedColumn): a `||`-concatenation of
    // setweight(to_tsvector(<config>, COALESCE(<col>, '')), <weight>) over the source columns.
    getComputedColumn(): ComputedColumn {
        this.applyDefaultWeights();
        const cfg = this.postgres.configuration;
        const expression = this.columns
            .map(c => `setweight(to_tsvector('${cfg}'::regconfig, (COALESCE(${sqlEscape(c.name, true)}, ''::character varying))::text), '${this.postgres.weights[c.name]}'::"char")`)
            .join(' || ');
        return { expression, persisted: true };
    }

    // The extra physical column(s) this index contributes to its table (Signum's GenerateColumns):
    // the persisted tsvector column on Postgres, nothing on SQL Server (which indexes the source
    // columns directly).
    generateColumns(isPostgres: boolean): IColumn[] {
        if (!isPostgres)
            return [];
        return [new PostgresTsVectorColumn(this.postgres.tsVectorColumnName, this.columns, this.getComputedColumn())];
    }
}

// Records the entity fields a selector lambda touches by running it against a proxy that
// notes each property read — the altea analogue of Signum's IndexKeyColumns.Split over an
// expression tree. Supports flat field access (`e => e.name`, `e => [e.a, e.b]`); nested
// paths (`e => e.address.city`) are not modelled.
export function recordAccessedFields(selector: (element: any) => unknown): string[] {
    const fields: string[] = [];
    const proxy = new Proxy({}, {
        get(_target, prop): unknown {
            if (typeof prop === 'string')
                fields.push(prop);
            return undefined;
        },
    });
    selector(proxy);
    if (fields.length === 0)
        throw new Error('An index selector must read at least one field, e.g. e => [e.name] or e => e.code');
    return fields;
}
