import type { ComputedColumn, IColumn } from './column';
import { PostgresTsVectorColumn } from './column';
import type { Table } from './table';
import type { Field } from './field';
import { FieldImplementedBy, FieldImplementedByAll } from './field';
import { IsNullable } from './dbType';
import { indexWhereIsNull } from './indexWhere';
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

// One field's contribution to a composite index: the FIELD it came from and the columns it owns
// (Signum's IndexKeyColumns.Split, which returns `(Field? field, IColumn[] columns)` pairs). The
// field is what a UNIQUE index has to look at, because a polymorphic one owns SEVERAL columns of
// which exactly one is filled per row — see {@link multiUniqueIndexes}.
export interface IndexBlock {
    readonly field: Field | undefined;
    readonly columns: IColumn[];
}

/**
 * Expand a composite UNIQUE index over a list of fields into the indexes it really needs — Signum's
 * `SchemaBuilder.AddMultiUniqueIndex`, one for one.
 *
 * A polymorphic reference is stored as SEVERAL columns with exactly ONE filled per row: an
 * `@implementedBy` has a column per implementation, an `@implementedByAll` an id column per
 * configured primary-key type beside the discriminator. A single index over all of them cannot say
 * "this reference is unique per owner": every row would compare equal on the columns it leaves NULL,
 * and on SQL Server (where NULLs compare equal in a unique index) that is a constraint on the wrong
 * thing entirely. So the index is expanded into the CARTESIAN PRODUCT of each polymorphic block's
 * alternatives — one partial index per combination, filtered to the rows that actually use it.
 *
 * The filter is what makes each one correct, and it applies to ordinary nullable columns too: a row
 * with a NULL in a covered column takes no part in the uniqueness (a string additionally excludes
 * `''`, as Signum does). `globalWhere` is the caller's own predicate, ANDed onto every one.
 */
export function multiUniqueIndexes(
    table: Table,
    blocks: readonly IndexBlock[],
    isPostgres: boolean,
    options?: { includeColumns?: IColumn[]; where?: string },
): TableIndex[] {
    const result: TableIndex[] = [];
    const and = (...parts: (string | undefined)[]): string | undefined => {
        const kept = parts.filter(p => p != null && p !== "");
        return kept.length === 0 ? undefined : kept.join(" AND ");
    };
    const notNull = (c: IColumn): string => `${sqlEscape(c.name, isPostgres)} IS NOT NULL`;

    const recurse = (i: number, prevColumns: IColumn[], prevWhere: string | undefined): void => {
        if (i === blocks.length) {
            result.push(new TableIndex(table, prevColumns, {
                unique: true,
                includeColumns: options?.includeColumns,
                where: and(prevWhere, options?.where),
            }));
            return;
        }
        const block = blocks[i];
        const field = block.field;
        if (field instanceof FieldImplementedBy) {
            for (const imp of field.implementationColumns)
                recurse(i + 1, [...prevColumns, imp],
                    and(prevWhere, imp.nullable === IsNullable.No ? undefined : notNull(imp)));
        }
        else if (field instanceof FieldImplementedByAll) {
            for (const id of field.idColumns)
                recurse(i + 1, [...prevColumns, field.typeColumn, id],
                    and(prevWhere, id.nullable === IsNullable.No ? undefined
                        : `(${notNull(field.typeColumn)} AND ${notNull(id)})`));
        }
        else {
            const filter = block.columns
                .filter(c => c.nullable !== IsNullable.No)
                .map(c => c.dbType.isString() ? `${notNull(c)} AND ${sqlEscape(c.name, isPostgres)} <> ''` : notNull(c))
                .join(" AND ");
            recurse(i + 1, [...prevColumns, ...block.columns], and(prevWhere, filter));
        }
    };

    recurse(0, [], undefined);
    return result;
}

/**
 * The unique index a FIELD-level `@unique` asks for — Signum's `Field.GenerateUniqueIndex`.
 *
 * The point is the FILTER. A `@unique` field that is optional must still let SEVERAL rows leave it
 * empty, so the index covers only the rows that fill it: `col IS NOT NULL`, and for a string `AND
 * col <> ''` besides — empty is empty. Without it the constraint says something stronger than the
 * model does (and on SQL Server, where NULLs compare equal in a unique index, something quite
 * wrong: at most one row may leave the field empty). A required field needs no filter, and gets
 * none.
 *
 * A polymorphic `@implementedBy` returns SEVERAL indexes — one per implementation column, each
 * filtered to the rows that use it — because uniqueness is per target table, not across the union.
 * That is a different shape from `multiUniqueIndexes`, which expands a CLASS-level composite index
 * into the cartesian product of its blocks; this one is a single field.
 */
export function generateUniqueIndexes(table: Table, field: Field, columns: IColumn[]): TableIndex[] {
    if (field instanceof FieldImplementedBy)
        return field.implementationColumns.map(imp => new TableIndex(table, [imp], {
            unique: true,
            where: imp.nullable === IsNullable.No
                ? undefined
                : `${sqlEscape(imp.name, table.isPostgres)} IS NOT NULL`,
        }));

    return [new TableIndex(table, columns, { unique: true, where: indexWhereIsNull(field, false, table) })];
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

// ---- Vector index (Signum's VectorTableIndex) -----------------------------------------------

export type PGVectorIndexType = 'HNSW' | 'IVFFlat';
export type PGVectorDistanceMetric = 'Cosine' | 'L2' | 'InnerProduct' | 'L1' | 'Hamming' | 'Jaccard';
export type SqlServerVectorIndexType = 'DiskANN';
export type SqlVectorDistanceMetric = 'Cosine' | 'Euclidean' | 'DotProduct';

// The Postgres access method (hnsw / ivfflat) for a vector index type (Signum's GetPGVectorIndex).
export function pgVectorIndexMethod(t: PGVectorIndexType): string {
    return t === 'IVFFlat' ? 'ivfflat' : 'hnsw';
}

// The pgvector operator class for a distance metric (Signum's GetPGVectorDistanceMetric).
export function pgVectorOperatorClass(m: PGVectorDistanceMetric): string {
    switch (m) {
        case 'L2': return 'vector_l2_ops';
        case 'InnerProduct': return 'vector_ip_ops';
        case 'Cosine': return 'vector_cosine_ops';
        case 'L1': return 'vector_l1_ops';
        case 'Hamming': return 'bit_hamming_ops';
        case 'Jaccard': return 'bit_jaccard_ops';
    }
}

// The SQL Server METRIC keyword for a distance metric (Signum's GetSqlVectorDistanceMetric).
export function sqlVectorMetric(m: SqlVectorDistanceMetric): string {
    switch (m) {
        case 'Cosine': return 'cosine';
        case 'Euclidean': return 'euclidean';
        case 'DotProduct': return 'dot';
    }
}

export interface VectorSqlServerOptions {
    metric: SqlVectorDistanceMetric;
    indexType: SqlServerVectorIndexType;
    maxDegreeOfParallelism?: number;
}

export interface VectorPostgresOptions {
    indexType: PGVectorIndexType;
    metric: PGVectorDistanceMetric;
    lists?: number;
}

// A nearest-neighbour index over a single `vector(N)` column (Signum's VectorTableIndex). On SQL
// Server it becomes `CREATE VECTOR INDEX … WITH (METRIC, TYPE, [MAXDOP])`; on Postgres a
// `CREATE INDEX … USING hnsw|ivfflat (col <op_class>)` (pgvector). Non-unique. The vector column
// is user-declared, so no columns are generated.
export class VectorTableIndex extends TableIndex {
    readonly sqlServer: VectorSqlServerOptions;
    readonly postgres: VectorPostgresOptions;

    constructor(
        table: Table,
        column: IColumn,
        options?: { sqlServer?: Partial<VectorSqlServerOptions>; postgres?: Partial<VectorPostgresOptions> },
    ) {
        super(table, [column], { unique: false });
        this.sqlServer = { metric: 'Cosine', indexType: 'DiskANN', ...options?.sqlServer };
        this.postgres = { indexType: 'HNSW', metric: 'Cosine', ...options?.postgres };
    }
}
