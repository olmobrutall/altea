// Schema-management operations (Signum's `Administrator`). These act on the database
// schema rather than on data — creating temporary tables/views, resetting sequences, etc.

import { Connector } from "./connection/connector";
import { Entity, type Type, type View, type ViewType } from "../data/entity";
import { ExecutionMode } from "./executionMode";
import { Synchronizer, type Replacements } from "./sync/synchronizer";
import { existsTable as existsObjectName } from "./sync/syncTableRead";
import { table as tableQuery } from "./table";
import type { Table } from "./schema/table";

// Signum's Administrator.CreateTemporaryTable<T>() — materialise a SQL Server temp table
// for a `@tableName("#...")` view type, to be populated with executeInsert (Signum's
// UnsafeInsertView). Resolves the ViewType to its Table (the same ViewBuilder-built table
// `view(T)` / the insert target uses, so the shapes match), renders its CREATE TABLE via the
// dialect SqlBuilder, and runs the DDL on the CURRENT connection.
//
// Temp tables are connection-scoped; inside a Transaction (e.g. a txTest's
// Transaction.noCommit) the connection is pinned, so this CREATE, the subsequent INSERT
// and any SELECT all share it and see the same temp table.
export const Administrator = {
    async createTemporaryTable<V extends View>(viewType: ViewType<V>): Promise<void> {
        const connector = Connector.current();
        const table = connector.schema.view(viewType);
        const create = connector.sqlBuilder.createTableSql(table);
        await create.executeNonQuery();
    },

    // Signum's Administrator.ExistsTable(ITable): does this table exist in the database RIGHT NOW? Reads
    // `table.name`, so inside a Synchronizer.useOldTableName scope it checks the PRE-rename name — which is
    // where the rows actually are while a synchronization script is being generated.
    existsTable(table: Table): Promise<boolean> {
        return existsObjectName(table.name);
    },

    // Signum's Administrator.TryRetrieveAll(Type, Replacements) — THE way a synchronizer reads a seeded
    // table's current rows. Temporarily points the in-memory Table (and its renamed columns) at the names
    // the database still uses, then runs an ORDINARY LINQ query, so the rows come back as real entities
    // through the normal binder / retriever: no hand-written SELECT, no manual column mapping, mixins and
    // conversions included for free.
    //
    // Three cases, matching Signum:
    //   • the table was RENAMED this run  -> read it by its old name (useOldTableName)
    //   • the table does not exist yet    -> no current rows (its CREATE is later in THIS script)
    //   • any other read failure          -> let it throw; the caller turns it into a commented
    //                                        SqlPreCommand so the script surfaces it instead of crashing.
    //
    // Runs in ExecutionMode.global (Signum's AvoidCache/ExecutionMode.Global): synchronization is trusted
    // framework code and must see every row, ungated by authorization.
    async tryRetrieveAll<T extends Entity>(type: Type<T>, replacements: Replacements): Promise<T[]> {
        const table = Connector.current().schema.tryTable(type as Type<Entity>);
        if (table == null)
            return [];

        // Column scope FIRST: its replacement bucket is keyed by the table's MODEL name.
        using _columns = Synchronizer.useOldColumnNames(table, replacements);
        using _name = Synchronizer.useOldTableName(table, replacements);

        if (!await Administrator.existsTable(table))
            return [];

        return await ExecutionMode.global(() => tableQuery(type).toArray()) as T[];
    },
};

