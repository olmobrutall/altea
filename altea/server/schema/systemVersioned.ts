import { ObjectName } from './objectName';
import { AbstractDbType, IsNullable } from './dbType';
import { ColumnBase, type SystemVersionKind } from './column';

// A system-versioning period column (Signum's SqlServerPeriodColumn / PostgresPeriodColumn).
// SQL Server keeps a start/end pair of `datetime2` (rendered GENERATED ALWAYS AS ROW
// START/END HIDDEN); Postgres keeps a single `sys_period` of type `tstzrange`. The other
// dialect's slot in AbstractDbType is unused (a period column only exists on its own dialect).
export class SystemPeriodColumn extends ColumnBase {
    constructor(name: string, kind: SystemVersionKind) {
        super(name, kind === 'period'
            ? new AbstractDbType('datetime2', 'tstzrange')      // PG-only column
            : new AbstractDbType('datetime2', 'timestamptz'));  // SS-only column (start/end)
        this.nullable = IsNullable.No;
        this.systemVersion = kind;
    }
}

// Port of Signum's SystemVersionedInfo (Schema.Basics.cs): the description of a table's
// system-versioning — the history table and the period columns. Dialect-divergent:
//   • SQL Server → two `datetime2` columns (startColumnName / endColumnName)
//   • Postgres   → one `tstzrange` column (postgresSysPeriodColumnName)
// Built per-dialect by the SchemaBuilder from the @systemVersioned decorator.
export class SystemVersionedInfo {
    constructor(
        public readonly historyTableName: ObjectName,
        public readonly startColumnName?: string,
        public readonly endColumnName?: string,
        public readonly postgresSysPeriodColumnName?: string,
    ) { }

    static sqlServer(historyTableName: ObjectName, startColumnName: string, endColumnName: string): SystemVersionedInfo {
        return new SystemVersionedInfo(historyTableName, startColumnName, endColumnName, undefined);
    }

    static postgres(historyTableName: ObjectName, sysPeriodColumnName: string): SystemVersionedInfo {
        return new SystemVersionedInfo(historyTableName, undefined, undefined, sysPeriodColumnName);
    }

    get isPostgres(): boolean {
        return this.postgresSysPeriodColumnName != null;
    }

    // The physical period columns to add to the table (and mirror on the history table).
    columns(): SystemPeriodColumn[] {
        if (this.postgresSysPeriodColumnName != null)
            return [new SystemPeriodColumn(this.postgresSysPeriodColumnName, 'period')];
        return [
            new SystemPeriodColumn(this.startColumnName!, 'start'),
            new SystemPeriodColumn(this.endColumnName!, 'end'),
        ];
    }
}

// Per-type @systemVersioned configuration (Signum's [SystemVersioned] attribute), read off
// the TypeInfo by the SchemaBuilder. Column/history names are optional overrides; the builder
// supplies dialect defaults (SS SysStartDate/SysEndDate, PG sys_period; history = <table>History).
export interface SystemVersionedConfig {
    startColumnName?: string;
    endColumnName?: string;
    sysPeriodColumnName?: string;
    historyTableName?: string;
}
