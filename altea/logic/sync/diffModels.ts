import { AbstractDbType } from '../schema/dbType';
import type { IColumn } from '../schema/column';
import type { TableIndex } from '../schema/tableIndex';
import { ObjectName, SchemaName, DatabaseName } from '../schema/objectName';
import { Connector } from '../connection/connector';
import { View } from '../../entities/entity';

// The default schema of either dialect ('dbo' / 'public') maps to altea's empty default
// SchemaName, so introspected object names match the model's. Neither is a real user schema.
function normalizeSchema(name: string): string {
    return name === 'dbo' || name === 'public' ? '' : name;
}

// Build an ObjectName from a (possibly default) schema + object name. Kept here so the
// create() factories can turn the plain strings a query projects into ObjectNames.
function objectNameOf(schema: string, name: string): ObjectName {
    return new ObjectName(name, new SchemaName(normalizeSchema(schema), new DatabaseName('')));
}

// Port of Signum's Engine/Sync/DiffModels.cs — the in-memory description of what the
// *database* currently contains, produced by the catalog readers (PostgresCatalogSchema /
// SysTablesSchema) and diffed against the model tables by SchemaSynchronizer.
//
// Scoped to altea's lean synchronizer (tables / columns / foreign keys / enum rows). The
// deferred subsystems Signum models here — system-versioning/temporal, partitions,
// full-text, vector indexes, computed/check columns, stats, statistics — are omitted or
// kept as inert data holders (DiffIndex/DiffIndexColumn), since altea's schema model has no
// TableIndex / SystemVersionedInfo to compare them against yet. Names and member order
// otherwise mirror the C#.

export class DiffSchema {
    name!: SchemaName;
    owner?: string;
}

export class DiffTable extends View {
    name!: ObjectName;

    primaryKeyName?: ObjectName;

    columns!: { [name: string]: DiffColumn };

    // Build a DiffTable from a query projection (or TS) out of plain strings + the columns
    // array (built in the query as DiffColumn.create({ … })). The schema/name strings become
    // ObjectNames (default schema normalised), the columns array is indexed by name, and
    // single-column foreign keys are hoisted onto their columns. Overrides View.create.
    static create(values: { schemaName: string; tableName: string; primaryKeyName?: string | null; owner?: string; columns: DiffColumn[]; multiForeignKeys?: DiffForeignKey[]; indices?: DiffIndex[] }): DiffTable {
        const t = new DiffTable();
        t.name = objectNameOf(values.schemaName, values.tableName);
        t.primaryKeyName = values.primaryKeyName == null ? undefined : objectNameOf(values.schemaName, values.primaryKeyName);
        t.owner = values.owner;
        t.columns = Object.fromEntries(values.columns.map(c => [c.name, c]));
        t.multiForeignKeys = values.multiForeignKeys ?? [];
        t.indices = Object.fromEntries((values.indices ?? []).map(i => [i.indexName, i]));
        t.foreignKeysToColumns();
        return t;
    }

    // The DB's indexes keyed by name (Signum's DiffTable.Indices), populated by the catalog
    // readers and diffed against the model's TableIndexes by SchemaSynchronizer.
    indices: { [name: string]: DiffIndex } = {};

    owner?: string;

    multiForeignKeys: DiffForeignKey[] = [];

    // Move every single-column foreign key from `multiForeignKeys` onto its owning column's
    // `foreignKey` slot (Signum's DiffTable.ForeignKeysToColumns). Multi-column FKs stay in
    // the list. (Check-constraint hoisting is omitted — altea has no check-constraint model.)
    foreignKeysToColumns(): void {
        for (const fk of this.multiForeignKeys.filter(a => a.columns.length === 1)) {
            this.columns[fk.columns[0].parent].foreignKey = fk;
            this.multiForeignKeys = this.multiForeignKeys.filter(a => a !== fk);
        }
    }

    toString(): string {
        return this.name.toString();
    }

    // SQL Server reports NChar/NText/NVarChar max_length in bytes; halve it to characters
    // (Signum's DiffTable.FixSqlColumnLengthSqlServer). No-op for length -1 (MAX).
    fixSqlColumnLengthSqlServer(): void {
        for (const c of Object.values(this.columns)) {
            if (c.length === -1)
                continue;
            const t = c.dbType.sqlServer.toLowerCase();
            if (t === 'nchar' || t === 'ntext' || t === 'nvarchar')
                c.length = Math.floor(c.length / 2);
        }
    }
}

export class DiffIndexColumn extends View {
    index!: number;
    columnName!: string;
    isDescending = false;
    type: DiffIndexColumnType = DiffIndexColumnType.Key;

    // Build from a query projection. `included` (SQL Server's is_included_column / a Postgres
    // INCLUDE column) marks a covering column; a partition column is not modelled by the lean
    // synchronizer (it collapses to Key). Overrides View.create.
    static create(v: { index: number; columnName: string; isDescending?: boolean; included?: boolean }): DiffIndexColumn {
        const c = new DiffIndexColumn();
        c.index = v.index;
        c.columnName = v.columnName;
        c.isDescending = v.isDescending ?? false;
        c.type = v.included ? DiffIndexColumnType.Included : DiffIndexColumnType.Key;
        return c;
    }
}

export enum DiffIndexColumnType {
    Key = 'Key',
    Included = 'Included',
    Partition = 'Partition',
}

// Port of Signum's Engine/Sync/DiffModels.cs DiffIndex, scoped to what altea's TableIndex
// models: (non-)unique multi-column indexes with optional INCLUDE columns and a filtered
// WHERE. The temporal/heap/clustered/vector/full-text/data-space concerns Signum also
// compares here are omitted (altea has no model for them).
export class DiffIndex extends View {
    isUnique = false;
    isPrimary = false;
    indexName!: string;
    // The DB's filtered-index predicate (SQL Server's filter_definition / Postgres' partial
    // predicate). Not compared directly — the WHERE is folded into the index name's signature,
    // so a changed filter surfaces as a name mismatch. Kept for completeness/diagnostics.
    filterDefinition?: string;
    columns: DiffIndexColumn[] = [];

    // Build from a query projection: the index facets + its (already ordered) columns array
    // (built in-query as DiffIndexColumn.create({ … })). Overrides View.create.
    static create(v: { indexName: string; isUnique?: boolean; isPrimary?: boolean; filterDefinition?: string | null; columns: DiffIndexColumn[] }): DiffIndex {
        const ix = new DiffIndex();
        ix.indexName = v.indexName;
        ix.isUnique = v.isUnique ?? false;
        ix.isPrimary = v.isPrimary ?? false;
        ix.filterDefinition = v.filterDefinition ?? undefined;
        // Order by the catalog's column ordinal (Signum's `orderby ic.index_column_id`) so key
        // columns precede included ones and both match the model's declaration order. Done
        // client-side to keep the reader query free of an ordered projection.
        ix.columns = [...v.columns].sort((a, b) => a.index - b.index);
        return ix;
    }

    // Faithful to Signum's DiffIndex.IndexEquals, scoped: uniqueness and the WHERE/INCLUDE
    // signature are encoded in the index NAME (so they surface via the dictionary key, not
    // here), leaving column identity + the primary-key flag to compare. A model TableIndex is
    // never a primary key in altea (the PK is a separate concern), so isPrimary must be false.
    indexEquals(dif: DiffTable, mix: TableIndex, _isPostgres: boolean): boolean {
        if (this.columnsChanged(dif, mix))
            return false;

        if (this.isPrimary)
            return false;

        return true;
    }

    // Whether the DB index's key/included columns differ from the model index's (Signum's
    // DiffIndex.ColumnsChanged).
    private columnsChanged(dif: DiffTable, mix: TableIndex): boolean {
        const keyCols = this.columns.filter(a => a.type === DiffIndexColumnType.Key);
        const incCols = this.columns.filter(a => a.type === DiffIndexColumnType.Included);
        const sameCols = identicalColumns(dif, mix.columns, keyCols);
        const sameInc = identicalColumns(dif, mix.includeColumns, incCols);
        return !(sameCols && sameInc);
    }

    // A "controlled" index is one altea itself generates — its name carries the IX_/UIX_/CIX_
    // prefix (lowercased on Postgres). Signum only ever drops/recreates controlled indexes
    // automatically; a hand-made index (other prefix) is left alone. (Signum's IsControlledIndex.)
    isControlledIndex(isPostgres: boolean): boolean {
        return (
            this.indexName.startsWith(isPostgres ? 'ix_' : 'IX_') ||
            this.indexName.startsWith(isPostgres ? 'uix_' : 'UIX_') ||
            this.indexName.startsWith(isPostgres ? 'cix_' : 'CIX_')
        );
    }

    toString(): string {
        return `${this.indexName} (${this.columns.map(c => c.columnName).join(', ')})`;
    }
}

// Signum's DiffIndex.IdenticalColumns: the model columns (in declaration order) match the DB
// index columns (in index order) one-for-one, comparing each by ColumnEquals (ignoring PK /
// identity, as an index never depends on those). undefined model columns count as empty.
function identicalColumns(dif: DiffTable, modColumns: IColumn[] | undefined, diffColumns: DiffIndexColumn[]): boolean {
    if ((modColumns?.length ?? 0) !== diffColumns.length)
        return false;

    if (diffColumns.length === 0)
        return true;

    return diffColumns.every((dc, i) => {
        const difCol = Object.values(dif.columns).find(c => c.name === dc.columnName);
        const modCol = modColumns![i];
        return difCol != null && modCol != null && difCol.columnEquals(modCol, /* ignorePrimaryKey */ true, /* ignoreIdentity */ true);
    });
}

export class DiffDefaultConstraint extends View {
    name?: string;
    definition!: string;
}

export class DiffColumn extends View {
    name!: string;
    dbType!: AbstractDbType;
    nullable!: boolean;
    collation?: string;
    length!: number;
    precision!: number;
    scale!: number;
    identity!: boolean;
    primaryKey!: boolean;

    foreignKey?: DiffForeignKey;

    defaultConstraint?: DiffDefaultConstraint;

    // Build a DiffColumn from a query projection (or TS) out of the semi-raw catalog facets:
    // the dialect type NAME becomes the AbstractDbType (only the active dialect's slot is
    // compared, so both slots mirror it), and a default definition becomes a
    // DiffDefaultConstraint. `primaryKey` stays false (columnEquals ignores it — PK is handled
    // via DiffTable.primaryKeyName). Length is stored raw; SQL Server's byte→char halving is
    // applied later by fixSqlColumnLengthSqlServer.
    static create(v: {
        name: string; typeName: string; nullable: boolean;
        length?: number; precision?: number; scale?: number; identity?: boolean;
        collation?: string | null; defaultName?: string | null; defaultDefinition?: string | null;
    }): DiffColumn {
        const c = new DiffColumn();
        c.name = v.name;
        c.dbType = new AbstractDbType(v.typeName, v.typeName);
        c.nullable = v.nullable;
        c.collation = v.collation ?? undefined;
        c.length = v.length ?? -1;
        c.precision = v.precision ?? 0;
        c.scale = v.scale ?? 0;
        c.identity = v.identity ?? false;
        c.primaryKey = false;
        if (v.defaultDefinition != null)
            c.defaultConstraint = DiffDefaultConstraint.create({ name: v.defaultName ?? undefined, definition: v.defaultDefinition });
        return c;
    }

    // Faithful to Signum's DiffColumn.ColumnEquals, minus the computed-column, check,
    // user-defined-type and generated-always comparisons (altea's IColumn models none of
    // these). Compares dialect type, collation, nullability, size/precision/scale, and —
    // unless ignored — identity and primary-key flags.
    columnEquals(other: IColumn, ignorePrimaryKey: boolean, ignoreIdentity: boolean): boolean {
        // Compare only the ACTIVE dialect's type name. Signum's AbstractDbType holds a
        // single dialect type; altea's holds both, but a DB-read DiffColumn only populates
        // the dialect it read, so comparing both slots would spuriously differ.
        const isPostgres = Connector.current().isPostgres;
        const dbTypeEquals = isPostgres
            ? this.dbType.postgres === other.dbType.postgres
            : this.dbType.sqlServer === other.dbType.sqlServer;
        return dbTypeEquals
            && this.collation === other.collation
            && this.nullable === isNullableToBool(other)
            && this.sizeEquals(other)
            && this.precisionEquals(other)
            && this.scaleEquals(other)
            && (ignoreIdentity || this.identity === other.identity)
            && (ignorePrimaryKey || this.primaryKey === other.primaryKey);
    }

    scaleEquals(other: IColumn): boolean {
        if (!other.dbType.isDecimal())
            return true;

        return other.scale == null || other.scale === this.scale;
    }

    sizeEquals(other: IColumn): boolean {
        if (other.size == null)
            return true;

        if (other.dbType.isString() || other.dbType.isBinary()) {
            if (other.size === MAX_SIZE)
                return this.length === -1;

            return other.size === this.length;
        }

        return true;
    }

    precisionEquals(other: IColumn): boolean {
        if (!other.dbType.isDecimal())
            return true;

        return other.precision == null || other.precision === 0 || other.precision === this.precision;
    }

    defaultEquals(other: IColumn): boolean {
        if (other.default == null && this.defaultConstraint == null)
            return true;

        return cleanParenthesis(this.defaultConstraint?.definition) === cleanParenthesis(other.default);
    }

    clone(): DiffColumn {
        const c = new DiffColumn();
        c.name = this.name;
        c.foreignKey = this.foreignKey;
        c.defaultConstraint = this.defaultConstraint == null ? undefined :
            Object.assign(new DiffDefaultConstraint(), { name: this.defaultConstraint.name, definition: this.defaultConstraint.definition });
        c.identity = this.identity;
        c.length = this.length;
        c.primaryKey = this.primaryKey;
        c.nullable = this.nullable;
        c.precision = this.precision;
        c.scale = this.scale;
        c.dbType = this.dbType;
        return c;
    }

    toString(): string {
        return this.name;
    }

    // Whether an in-place ALTER COLUMN from this (DB) type to `tabCol` (model) type is a
    // legal server-side conversion. Postgres is permissive (always true); SQL Server uses
    // the CAST/CONVERT compatibility matrix (Signum's CompatibleTypes_SqlServer), keyed on
    // the T-SQL type name. An incompatible pair forces the synchronizer to drop + recreate.
    compatibleTypes(tabCol: IColumn): boolean {
        if (Connector.current().isPostgres)
            return true; // CompatibleTypes_Postgres — always true

        return compatibleTypesSqlServer(this.dbType.sqlServer.toLowerCase(), tabCol.dbType.sqlServer.toLowerCase());
    }

    sizeScalePrecisionEquals(other: DiffColumn): boolean {
        return this.precision === other.precision ||
            this.scale === other.scale ||
            this.length === other.length;
    }
}

export class DiffForeignKey extends View {
    name!: ObjectName;
    targetTable!: ObjectName;
    isDisabled = false;
    isNotTrusted = false;
    columns!: DiffForeignKeyColumn[];

    // Build from plain strings (the constraint schema/name and the target table schema/name)
    // + the DiffForeignKeyColumn array — so a query can construct it directly.
    static create(values: { schemaName: string; conname: string; targetSchema: string; targetName: string; columns: DiffForeignKeyColumn[]; isDisabled?: boolean; isNotTrusted?: boolean }): DiffForeignKey {
        const fk = new DiffForeignKey();
        fk.name = objectNameOf(values.schemaName, values.conname);
        fk.targetTable = objectNameOf(values.targetSchema, values.targetName);
        fk.columns = values.columns;
        fk.isDisabled = values.isDisabled ?? false;
        fk.isNotTrusted = values.isNotTrusted ?? false;
        return fk;
    }

    toString(): string {
        return this.name.toString();
    }
}

export class DiffForeignKeyColumn extends View {
    parent!: string;
    referenced!: string;

    toString(): string {
        return `${this.parent} -> ${this.referenced}`;
    }
}

// Sentinel matching SqlBuilder.MAX_SIZE — a string/binary column of "max" length
// (nvarchar(MAX) / text). DB introspection reports these as length -1.
const MAX_SIZE = -1;

// Whether an IColumn accepts NULL. Mirrors Signum's IsNullable.ToBool() (Forced counts as
// nullable in the DB). Local copy to avoid importing the enum's helper into a data module.
function isNullableToBool(col: IColumn): boolean {
    return col.nullable !== 'No';
}

// Normalises a default/expression definition for loose comparison — strips parentheses,
// quotes and casing (Signum's CleanParenthesis).
function cleanParenthesis(p: string | undefined): string | undefined {
    if (p == null)
        return undefined;
    return p.replace(/[()']/g, '').toLowerCase();
}

// Port of Signum's CompatibleTypes_SqlServer switch, keyed on lowercased T-SQL type names
// instead of the SqlDbType enum. `false` means the CAST/CONVERT is disallowed, so the
// synchronizer must drop and recreate the column rather than ALTER it in place.
function compatibleTypesSqlServer(fromType: string, toType: string): boolean {
    switch (fromType) {
        // BLACKLIST
        case 'binary':
        case 'varbinary':
            switch (toType) {
                case 'float':
                case 'real':
                case 'ntext':
                case 'text':
                    return false;
                default:
                    return true;
            }

        case 'char':
        case 'varchar':
            return true;

        case 'nchar':
        case 'nvarchar':
            return toType !== 'image';

        case 'datetime':
        case 'smalldatetime':
            switch (toType) {
                case 'uniqueidentifier':
                case 'image':
                case 'ntext':
                case 'text':
                case 'xml':
                case 'udt':
                    return false;
                default:
                    return true;
            }

        case 'date':
            if (toType === 'time')
                return false;
            return compatibleDateTime2(toType);

        case 'time':
            if (toType === 'date')
                return false;
            return compatibleDateTime2(toType);

        case 'datetimeoffset':
        case 'datetime2':
            return compatibleDateTime2(toType);

        case 'decimal':
        case 'numeric':
        case 'float':
        case 'real':
        case 'bigint':
        case 'int':
        case 'smallint':
        case 'tinyint':
        case 'money':
        case 'smallmoney':
        case 'bit':
            switch (toType) {
                case 'date':
                case 'time':
                case 'datetimeoffset':
                case 'datetime2':
                case 'uniqueidentifier':
                case 'image':
                case 'ntext':
                case 'text':
                case 'xml':
                case 'udt':
                    return false;
                default:
                    return true;
            }

        case 'timestamp':
            switch (toType) {
                case 'nchar':
                case 'nvarchar':
                case 'date':
                case 'time':
                case 'datetimeoffset':
                case 'datetime2':
                case 'uniqueidentifier':
                case 'image':
                case 'ntext':
                case 'text':
                case 'xml':
                case 'udt':
                    return false;
                default:
                    return true;
            }

        case 'sql_variant':
        case 'variant':
            switch (toType) {
                case 'timestamp':
                case 'image':
                case 'ntext':
                case 'text':
                case 'xml':
                case 'udt':
                    return false;
                default:
                    return true;
            }

        // WHITELIST
        case 'uniqueidentifier':
            switch (toType) {
                case 'binary':
                case 'varbinary':
                case 'char':
                case 'varchar':
                case 'nchar':
                case 'nvarchar':
                case 'uniqueidentifier':
                case 'variant':
                case 'sql_variant':
                    return true;
                default:
                    return false;
            }

        case 'image':
            switch (toType) {
                case 'binary':
                case 'image':
                case 'varbinary':
                case 'timestamp':
                    return true;
                default:
                    return false;
            }

        case 'ntext':
        case 'text':
            switch (toType) {
                case 'char':
                case 'varchar':
                case 'nchar':
                case 'nvarchar':
                case 'ntext':
                case 'text':
                case 'xml':
                    return true;
                default:
                    return false;
            }

        case 'xml':
        case 'udt':
            switch (toType) {
                case 'binary':
                case 'varbinary':
                case 'char':
                case 'varchar':
                case 'nchar':
                case 'nvarchar':
                case 'xml':
                case 'udt':
                    return true;
                default:
                    return false;
            }

        default:
            // Unknown / unmodelled type — be conservative and force a recreate.
            return false;
    }
}

// Shared tail of the Date/Time/DateTimeOffset/DateTime2 blacklist cases.
function compatibleDateTime2(toType: string): boolean {
    switch (toType) {
        case 'decimal':
        case 'numeric':
        case 'float':
        case 'real':
        case 'bigint':
        case 'int':
        case 'smallint':
        case 'tinyint':
        case 'money':
        case 'smallmoney':
        case 'bit':
        case 'uniqueidentifier':
        case 'image':
        case 'ntext':
        case 'text':
        case 'xml':
        case 'udt':
            return false;
        default:
            return true;
    }
}
