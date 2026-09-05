import { AbstractDbType, IsNullable } from './dbType';
import type { PrimaryKeyType } from '../../data/reflection';
import type { Table } from './table';

// A system-versioning period column's role (Signum's SystemVersionColumnType + the
// Postgres range variant): SQL Server has a `start`/`end` pair, Postgres a single
// `period` tstzrange. Marks the column so the DDL generator emits GENERATED ALWAYS AS
// ROW START/END (SS) and the reader/synchronizer treats it as system-managed.
export type SystemVersionKind = 'start' | 'end' | 'period';

// A computed (generated) column expression (Signum's Maps.ComputedColumn). `persisted`
// STORED on Postgres / PERSISTED on SQL Server. Used by the Postgres full-text tsvector
// column, which is a persisted GENERATED ALWAYS AS (setweight(to_tsvector(...))) STORED
// column indexed by a GIN index.
export interface ComputedColumn {
    readonly expression: string;
    readonly persisted: boolean;
}

// A single physical column in a table. Mirrors Signum's IColumn. Every Field
// produces zero or more of these via Field.columns(); Table flattens them into
// its `columns` dictionary. `readonly` here documents the consumer contract —
// the concrete classes assign in their constructors.
export interface IColumn {
    readonly name: string;
    readonly dbType: AbstractDbType;
    readonly nullable: IsNullable;
    readonly primaryKey: boolean;
    readonly identity: boolean;
    readonly size?: number;
    readonly precision?: number;
    readonly scale?: number;
    readonly collation?: string;
    readonly default?: string;
    // Set for FK columns (FieldReference / implementation columns). The DDL
    // generator turns this into a FOREIGN KEY constraint.
    readonly referenceTable?: Table;
    readonly avoidForeignKey: boolean;
    // Native array column (e.g. Postgres text[]). Reserved — always false today,
    // since primitive collections are rejected by the builder for now.
    readonly collection: boolean;
    // Set on a system-versioning period column (Signum's SqlServerPeriodColumn /
    // PostgresPeriodColumn). Undefined for ordinary columns.
    readonly systemVersion?: SystemVersionKind;
    // Set on a computed/generated column (Signum's IColumn.ComputedColumn). The DDL generator
    // emits GENERATED ALWAYS AS (<expression>) [STORED|PERSISTED]. Undefined for ordinary columns.
    readonly computedColumn?: ComputedColumn;
}

// Base implementation with sensible defaults; subclasses tweak fields in their
// constructors. Fields are mutable on the class but exposed as readonly through
// IColumn.
export class ColumnBase implements IColumn {
    nullable: IsNullable = IsNullable.No;
    primaryKey = false;
    identity = false;
    size?: number;
    precision?: number;
    scale?: number;
    collation?: string;
    default?: string;
    referenceTable?: Table;
    avoidForeignKey = false;
    collection = false;
    systemVersion?: SystemVersionKind;
    computedColumn?: ComputedColumn;

    constructor(
        public name: string,
        public dbType: AbstractDbType,
    ) { }
}

export class PrimaryKeyColumn extends ColumnBase {
    constructor(name: string, dbType: AbstractDbType, identity: boolean) {
        super(name, dbType);
        this.primaryKey = true;
        this.identity = identity;
    }
}

export class ValueColumn extends ColumnBase {
    constructor(name: string, dbType: AbstractDbType, nullable: IsNullable, size?: number, precision?: number, scale?: number) {
        super(name, dbType);
        this.nullable = nullable;
        this.size = size;
        this.precision = precision;
        this.scale = scale;
    }
}

// FK column to a single concrete table.
export class ReferenceColumn extends ColumnBase {
    constructor(
        name: string,
        referenceTable: Table,
        nullable: IsNullable,
        public readonly isLite: boolean,
        avoidForeignKey = false,
    ) {
        super(name, referenceTable.primaryKey.column.dbType);
        this.referenceTable = referenceTable;
        this.nullable = nullable;
        this.avoidForeignKey = avoidForeignKey;
    }
}

// One column of a polymorphic @implementedBy reference (one per implementation).
export class ImplementationColumn extends ColumnBase {
    constructor(
        name: string,
        referenceTable: Table,
        public readonly isLite: boolean,
        // Normally omitted, and the column is then NULLABLE: a polymorphic field owns one column per
        // implementation and at most one of them is populated. A field that resolves to a SINGLE
        // implementation owns just the one column, so it can carry the field's own nullability — which is
        // what makes a @backReference declared @implementedBy (and widened by the app) come out NOT NULL,
        // as Signum's ParentID is.
        nullable: IsNullable = IsNullable.Yes,
    ) {
        super(name, referenceTable.primaryKey.column.dbType);
        this.referenceTable = referenceTable;
        this.nullable = nullable;
    }
}

// The id half of @implementedByAll (stores the target row's primary key value).
export class ImplementedByAllIdColumn extends ColumnBase {
    // Signum stores an @implementedByAll id in one column per primary-key TYPE (int /
    // long / guid); only the column matching the target's PK type is non-null. `pkType`
    // records which type this column serves, so materialisation/equality can pick it.
    constructor(
        name: string,
        dbType: AbstractDbType,
        public readonly pkType: PrimaryKeyType,
        // Nullable when the schema configures SEVERAL pk types (only one column is filled per row);
        // with a single one the column carries the FIELD's own nullability. Signum's
        // `idNullable = primaryKeyTypes.Count() > 1 ? Yes : nullable`.
        nullable: IsNullable = IsNullable.Yes,
    ) {
        super(name, dbType);
        this.nullable = nullable;
    }
}

// The discriminator half of @implementedByAll: which entity type the id refers to,
// stored as the target's TypeEntity int id (Signum's ImplementedByAllTypeColumn, which is an
// ordinary ImplementationColumn there). Typed as the TypeEntity primary key and pointed at its
// table, and it carries the FIELD's own nullability — unlike the id columns, exactly one
// discriminator is written per row, so a non-nullable reference has a NOT NULL discriminator.
//
// DIVERGENCE: no FK constraint. Signum builds one (a Southwind database has
// `fk_concurrent_user_target_entity_id_type`) and drops it only for an explicit
// `[AvoidForeignKey]`. altea cannot yet: an FK here makes a sync that REMOVES a type row fail on
// the constraint, and the `EntityEvents<TypeEntity>.preDeleteSqlSync` cascade that sweeps such a
// table's orphans is unported (see altea-view-log's header). Restore it with that cascade.
export class ImplementedByAllTypeColumn extends ColumnBase {
    constructor(name: string, referenceTable: Table, nullable: IsNullable = IsNullable.Yes) {
        super(name, referenceTable.primaryKey.column.dbType);
        this.referenceTable = referenceTable;
        this.nullable = nullable;
        this.avoidForeignKey = true;
    }
}

// NULL-indicator column for a nullable embedded value.
export class EmbeddedHasValueColumn extends ColumnBase {
    constructor(name: string) {
        super(name, new AbstractDbType('bit', 'bool'));
        this.nullable = IsNullable.No;
    }
}

// The synthetic `tsvector` column a Postgres full-text index materialises (Signum's
// PostgresTsVectorColumn). It is a persisted generated column whose expression concatenates
// `setweight(to_tsvector(<config>, COALESCE(<col>, '')), <weight>)` over the indexed source
// columns; a GIN index is then built over it. SQL Server has no analogue — there the FULLTEXT
// index covers the source columns directly, so this column is generated on Postgres only.
export class PostgresTsVectorColumn extends ColumnBase {
    static readonly DEFAULT_NAME = 'tsvector';

    constructor(name: string, public readonly sourceColumns: IColumn[], computedColumn: ComputedColumn) {
        super(name, TSVECTOR_DB_TYPE);
        this.nullable = IsNullable.Yes;
        this.computedColumn = computedColumn;
    }
}

// tsvector is Postgres-only; the SQL Server slot is never emitted (the column only ever
// exists on a Postgres table), but AbstractDbType requires both dialect names.
export const TSVECTOR_DB_TYPE = new AbstractDbType('tsvector', 'tsvector');
