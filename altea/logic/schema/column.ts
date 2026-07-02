import { AbstractDbType, IsNullable } from './dbType';
import type { PrimaryKeyType } from '../../entities/reflection';
import type { Table } from './table';

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
    ) {
        super(name, referenceTable.primaryKey.column.dbType);
        this.referenceTable = referenceTable;
        // Always nullable: at most one implementation column is populated.
        this.nullable = IsNullable.Yes;
    }
}

// The id half of @implementedByAll (stores the target row's primary key value).
export class ImplementedByAllIdColumn extends ColumnBase {
    // Signum stores an @implementedByAll id in one column per primary-key TYPE (int /
    // long / guid); only the column matching the target's PK type is non-null. `pkType`
    // records which type this column serves, so materialisation/equality can pick it.
    constructor(name: string, dbType: AbstractDbType, public readonly pkType: PrimaryKeyType) {
        super(name, dbType);
        this.nullable = IsNullable.Yes;
    }
}

// The discriminator half of @implementedByAll: which entity type the id refers to,
// stored as the target's TypeEntity int id (Signum's ImplementedByAllTypeColumn).
// Typed as the TypeEntity primary key and pointed at its table; no FK constraint
// (Signum's common AvoidForeignKey for the discriminator — it keeps generation
// order simple and avoids the per-row check).
export class ImplementedByAllTypeColumn extends ColumnBase {
    constructor(name: string, referenceTable: Table) {
        super(name, referenceTable.primaryKey.column.dbType);
        this.referenceTable = referenceTable;
        this.nullable = IsNullable.Yes;
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
