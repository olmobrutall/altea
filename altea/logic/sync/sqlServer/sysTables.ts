import { reflect } from "../../../entities/reflection";
import { tableName, viewPrimaryKey, quoted } from "../../../entities/decorators";
import { int } from "../../../entities/basics";
import { view } from "../../table";
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
export class SysDatabases {
    @viewPrimaryKey database_id!: int;
    name!: string;
    collation_name!: string;
}

@reflect
@tableName("sys.schemas")
export class SysSchemas {
    @viewPrimaryKey schema_id!: int;
    name!: string;

    @quoted
    tables(): Query<SysTables> { return view(SysTables).filter(t => t.schema_id == this.schema_id); }
}

@reflect
@tableName("sys.tables")
export class SysTables {
    name!: string;
    @viewPrimaryKey object_id!: int;
    schema_id!: int;

    @quoted
    columns(): Query<SysColumns> { return view(SysColumns).filter(c => c.object_id == this.object_id); }

    @quoted
    foreignKeys(): Query<SysForeignKeys> { return view(SysForeignKeys).filter(fk => fk.parent_object_id == this.object_id); }

    @quoted
    keyConstraints(): Query<SysKeyConstraints> { return view(SysKeyConstraints).filter(fk => fk.parent_object_id == this.object_id); }

    @quoted
    schema(): Promise<SysSchemas> { return view(SysSchemas).single(a => a.schema_id == this.schema_id); }
}

@reflect
@tableName("sys.columns")
export class SysColumns {
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
export class SysDefaultConstraints {
    name!: string;
    @viewPrimaryKey object_id!: int;
    parent_object_id!: int;
    parent_column_id!: int;
    definition!: string;
    is_system_named!: boolean;
}

@reflect
@tableName("sys.types")
export class SysTypes {
    @viewPrimaryKey system_type_id!: int;
    user_type_id!: int;
    name!: string;
}

@reflect
@tableName("sys.key_constraints")
export class SysKeyConstraints {
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
export class SysForeignKeys {
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
export class SysForeignKeyColumns {
    @viewPrimaryKey constraint_object_id!: int;
    constraint_column_id!: int;
    parent_object_id!: int;
    parent_column_id!: int;
    referenced_object_id!: int;
    referenced_column_id!: int;
}
