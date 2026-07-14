import { reflect } from "../../../entities/reflection";
import { tableName, viewPrimaryKey, quoted } from "../../../entities/decorators";
import { int } from "../../../entities/basics";
import { view } from "../../table";
import { View } from "../../../entities/entity";
import type { Query } from "../../query";

// Port of Signum's Engine/Sync/SqlServer/SysTables.cs — the strongly-typed IView classes
// over SQL Server's system catalog (sys.*). A view class = @reflect (Signum's `: IView`) +
// @tableName (Signum's [TableName]) + @viewPrimaryKey fields (Signum's [ViewPrimaryKey]);
// [AutoExpressionField] navigation becomes @quoted methods calling view(T) directly (these
// classes are server-only, so no logic-layer prototype expansion is needed).
//
// Navigation returns exactly what view() yields — Query<T> for a collection, Promise<T> for
// a single row — so the expressions work in-memory too; inside a query, the client adds `.$v`
// at the call site to strip the Promise. This mirrors Signum's IQueryable<T> / T navigation.
//
// Scoped to the lean synchronizer (tables / columns / foreign keys): the temporal, index,
// stats, full-text, vector and partition views are omitted. Column names are raw (verbatim
// field names), matching the catalog.

@reflect
@tableName("sys.databases")
export class SysDatabases extends View {
    @viewPrimaryKey database_id!: int;
    name!: string;
    collation_name!: string;
}

@reflect
@tableName("sys.schemas")
export class SysSchemas extends View {
    @viewPrimaryKey schema_id!: int;
    name!: string;

    @quoted
    tables(): Query<SysTables> { return view(SysTables).filter(t => t.schema_id == this.schema_id); }
}

@reflect
@tableName("sys.tables")
export class SysTables extends View {
    name!: string;
    @viewPrimaryKey object_id!: int;
    schema_id!: int;
    // System-versioning (temporal) metadata (SQL Server 2016+). temporal_type: 0 none,
    // 1 history table, 2 system-versioned main table. history_table_id points a versioned main
    // table at its history table (in sys.tables).
    temporal_type!: int;
    history_table_id!: int;

    @quoted
    columns(): Query<SysColumns> { return view(SysColumns).filter(c => c.object_id == this.object_id); }

    // The table's PERIOD FOR SYSTEM_TIME definition, if any (Signum's SysTables.Periods()).
    @quoted
    periods(): Query<SysPeriods> { return view(SysPeriods).filter(p => p.object_id == this.object_id); }

    // The history table a system-versioned table versions into (null if not versioned) — Signum's
    // TemporalTableName lookup by history_table_id. Nullable, so navigations off it read through
    // OUTER APPLYs.
    @quoted
    temporalTable(): Promise<SysTables | null> { return view(SysTables).firstOrNull(ht => ht.object_id == this.history_table_id); }

    @quoted
    foreignKeys(): Query<SysForeignKeys> { return view(SysForeignKeys).filter(fk => fk.parent_object_id == this.object_id); }

    @quoted
    keyConstraints(): Query<SysKeyConstraints> { return view(SysKeyConstraints).filter(fk => fk.parent_object_id == this.object_id); }

    @quoted
    indices(): Query<SysIndexes> { return view(SysIndexes).filter(ix => ix.object_id == this.object_id); }

    // singleOrNull (not single) so navigating `.schema()` off a NULLABLE SysTables reference — e.g.
    // `temporalTable().$v!.schema()` for a table with no history — reads through an OUTER APPLY and
    // preserves the outer row. A `single()` here is a CROSS APPLY, which by design drops the row
    // when the receiver's schema_id is null. (For a non-null receiver the schema always exists, so
    // singleOrNull returns it just the same.)
    @quoted
    schema(): Promise<SysSchemas | null> { return view(SysSchemas).singleOrNull(a => a.schema_id == this.schema_id); }
}

// sys.periods — the PERIOD FOR SYSTEM_TIME of a system-versioned table (Signum's SysPeriods).
// start_column_id / end_column_id resolve to the period columns via sys.columns.
@reflect
@tableName("sys.periods")
export class SysPeriods extends View {
    @viewPrimaryKey object_id!: int;
    start_column_id!: int;
    end_column_id!: int;
}

@reflect
@tableName("sys.columns")
export class SysColumns extends View {
    name!: string;
    @viewPrimaryKey object_id!: int;
    column_id!: int;
    default_object_id!: int;
    collation_name!: string;
    is_nullable!: boolean;
    user_type_id!: int;
    system_type_id!: int;
    max_length!: int;
    precision!: int;
    scale!: int;
    is_identity!: boolean;

    @quoted
    type(): Promise<SysTypes> { return view(SysTypes).single(a => a.system_type_id == this.system_type_id && a.user_type_id == this.user_type_id); }
}

@reflect
@tableName("sys.default_constraints")
export class SysDefaultConstraints extends View {
    name!: string;
    @viewPrimaryKey object_id!: int;
    parent_object_id!: int;
    parent_column_id!: int;
    definition!: string;
    is_system_named!: boolean;
}

@reflect
@tableName("sys.types")
export class SysTypes extends View {
    @viewPrimaryKey system_type_id!: int;
    user_type_id!: int;
    name!: string;
}

@reflect
@tableName("sys.key_constraints")
export class SysKeyConstraints extends View {
    name!: string;
    @viewPrimaryKey object_id!: int;
    schema_id!: int;
    parent_object_id!: int;
    type!: string;

    @quoted
    schema(): Promise<SysSchemas> { return view(SysSchemas).single(a => a.schema_id == this.schema_id); }
}

@reflect
@tableName("sys.foreign_keys")
export class SysForeignKeys extends View {
    @viewPrimaryKey object_id!: int;
    schema_id!: int;
    name!: string;
    parent_object_id!: int;
    referenced_object_id!: int;
    is_disabled!: boolean;
    is_not_trusted!: boolean;

    @quoted
    foreignKeyColumns(): Query<SysForeignKeyColumns> { return view(SysForeignKeyColumns).filter(fkc => fkc.constraint_object_id == this.object_id); }

    @quoted
    schema(): Promise<SysSchemas> { return view(SysSchemas).single(a => a.schema_id == this.schema_id); }

    @quoted
    referencedTable(): Promise<SysTables> { return view(SysTables).single(a => a.object_id == this.referenced_object_id); }
}

@reflect
@tableName("sys.foreign_key_columns")
export class SysForeignKeyColumns extends View {
    @viewPrimaryKey constraint_object_id!: int;
    constraint_column_id!: int;
    parent_object_id!: int;
    parent_column_id!: int;
    referenced_object_id!: int;
    referenced_column_id!: int;
}

@reflect
@tableName("sys.indexes")
export class SysIndexes extends View {
    @viewPrimaryKey index_id!: int;
    name!: string;
    object_id!: int;
    is_unique!: boolean;
    is_primary_key!: boolean;
    type!: int;
    filter_definition!: string;

    @quoted
    indexColumns(): Query<SysIndexColumn> { return view(SysIndexColumn).filter(ixc => ixc.index_id == this.index_id && ixc.object_id == this.object_id); }
}

// sys.objects / sys.sql_modules — read by SchemaAssets.SyncProcedures/SyncViews to recover the
// existing stored procedures, functions and views (and their verbatim definition text) from the
// catalog. `type` is the 2-char object type ("P" procedure, "FN"/"IF"/"TF" function, "V" view);
// sys.sql_modules.definition is the CREATE text as stored (Signum keys the diff off it).
@reflect
@tableName("sys.objects")
export class SysObjects extends View {
    @viewPrimaryKey object_id!: int;
    schema_id!: int;
    name!: string;
    type!: string;

    @quoted
    schema(): Promise<SysSchemas> { return view(SysSchemas).single(a => a.schema_id == this.schema_id); }
}

@reflect
@tableName("sys.sql_modules")
export class SysSqlModules extends View {
    @viewPrimaryKey object_id!: int;
    definition!: string;
}

@reflect
@tableName("sys.views")
export class SysViews extends View {
    @viewPrimaryKey object_id!: int;
    schema_id!: int;
    name!: string;

    @quoted
    schema(): Promise<SysSchemas> { return view(SysSchemas).single(a => a.schema_id == this.schema_id); }
}

@reflect
@tableName("sys.index_columns")
export class SysIndexColumn extends View {
    @viewPrimaryKey object_id!: int;
    index_id!: int;
    column_id!: int;
    index_column_id!: int;
    key_ordinal!: int;
    partition_ordinal!: int;
    is_included_column!: boolean;
    is_descending_key!: boolean;
}
