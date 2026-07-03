import { AbstractDbType } from '../schema/dbType';
import type { IColumn } from '../schema/column';
import { ObjectName, SchemaName } from '../schema/objectName';
import { Connector } from '../connection/connector';

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

export class DiffTable {
    name!: ObjectName;

    primaryKeyName?: ObjectName;

    columns!: { [name: string]: DiffColumn };

    // Kept as plain data holders — populated by the readers, but not diffed by the lean
    // synchronizer (no index model to compare against). Signum's SimpleIndices/ViewIndices
    // accessors and the temporal/period/versioning fields are intentionally omitted.
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

export class DiffIndexColumn {
    index!: number;
    columnName!: string;
    isDescending = false;
    isIncluded = false;
    type: DiffIndexColumnType = DiffIndexColumnType.Key;
}

export enum DiffIndexColumnType {
    Key = 'Key',
    Included = 'Included',
    Partition = 'Partition',
}

// Inert data holder (see DiffTable.indices). The full DiffIndex/IndexEquals machinery from
// Signum is deferred until altea grows a TableIndex model.
export class DiffIndex {
    isUnique = false;
    isPrimary = false;
    indexName!: string;
    columns: DiffIndexColumn[] = [];

    toString(): string {
        return `${this.indexName} (${this.columns.map(c => c.columnName).join(', ')})`;
    }
}

export class DiffDefaultConstraint {
    name?: string;
    definition!: string;
}

export class DiffColumn {
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

export class DiffForeignKey {
    name!: ObjectName;
    targetTable!: ObjectName;
    isDisabled = false;
    isNotTrusted = false;
    columns!: DiffForeignKeyColumn[];

    toString(): string {
        return this.name.toString();
    }
}

export class DiffForeignKeyColumn {
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
