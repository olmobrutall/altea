// Schema-management operations (Signum's `Administrator`). These act on the database
// schema rather than on data — creating temporary tables/views, resetting sequences, etc.

import * as path from "node:path";
import { Connector } from "./connection/connector";
import { Entity, type Type, type View, type ViewType } from "../data/entity";
import { ExecutionMode } from "./executionMode";
import { Synchronizer, type Replacements } from "./sync/synchronizer";
import { existsTable as existsObjectName } from "./sync/syncTableRead";
import { table as tableQuery } from "./table";
import type { Table } from "./schema/table";
import type { IColumn } from "./schema/column";
import type { Lite } from "../data/lite";
import { Transaction } from "./connection/transaction";
import { SqlPreCommand, SqlPreCommandSimple } from "./sync/sqlPreCommand";

// Signum's `Administrator.AfterSynchronize` event — fires at the end of a schema synchronize, after
// the script (if any) has been written, with the file name and the `Replacements` the sync collected.
//
// It exists so a subscriber can chain follow-up prompts onto the sync the developer already runs, which
// is what @altea/altea-user-assets' token migrations use it for: the renames a schema sync just resolved
// are exactly the ones that invalidate the query TOKENS stored inside user assets, and the Replacements
// bag is where those renames are. `fileName`/`replacements` are null for an already-synchronized
// database, as in Signum — a subscriber may still want to run (there can be pending token work with no
// schema work).
//
// The SEAM is here, in core, where Signum keeps it; the CALL is in the app's sync command, because that
// is what owns the console session (Signum's Administrator.Synchronize is that command).
export const afterSynchronize: ((fileName: string | null, replacements: Replacements | null) => Promise<void> | void)[] = [];

/** Fire {@link afterSynchronize} in registration order, awaiting each. */
export async function onAfterSynchronize(fileName: string | null, replacements: Replacements | null): Promise<void> {
    for (const handler of afterSynchronize)
        await handler(fileName, replacements);
}

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
    /**
     * Signum's `Administrator.WithSnapshotOrTemplateDatabase` — wrap a full GENERATION so that what it
     * produces can be restored, over and over, by {@link restoreSnapshotOrDatabase}. A test suite that
     * drives a real database generates once through this, then rewinds to it before each test.
     *
     * The two dialects reach the same place from opposite directions, as in Signum:
     *  - SQL Server generates into the real database and, on the way out, takes a SNAPSHOT of it.
     *  - PostgreSQL has no snapshots, so generation is REDIRECTED into `<db>_Template` and the real
     *    database is (re)created from it as a template on the way out.
     *
     * `await using _ = await Administrator.withSnapshotOrTemplateDatabase();` — the work happens when the
     * scope is disposed, so everything the generation did is inside it.
     */
    async withSnapshotOrTemplateDatabase(templateName?: string): Promise<AsyncDisposable> {
        const connector = Connector.current();
        const dbName = connector.databaseName();
        const template = templateName ?? dbName + "_Template";

        if (!connector.isPostgres)
            return { [Symbol.asyncDispose]: () => Administrator.snapshots.createSnapshot(template) };

        // Point the whole generation at the template database, created empty from the maintenance one.
        await connector.withDatabase(POSTGRES_MAINTENANCE_DB, () => Administrator.postgresTools.createDatabase(template));
        await connector.changeDatabase(template);

        return {
            async [Symbol.asyncDispose](): Promise<void> {
                await connector.withDatabase(POSTGRES_MAINTENANCE_DB,
                    () => Administrator.postgresTools.createDatabase(dbName, { fromTemplate: template }));
                await connector.changeDatabase(dbName);
            },
        };
    },

    /**
     * Signum's `Administrator.RestoreSnapshotOrDatabase` — put the database back exactly as
     * {@link withSnapshotOrTemplateDatabase} left it, discarding everything written since.
     *
     * It replaces the whole database, so nothing else may be USING it: on PostgreSQL every other
     * connection is terminated first (an application server holding a pool included — it reconnects),
     * and on SQL Server the restore takes the database SINGLE_USER for the duration. A server that
     * caches rows in memory is not told by any of this: invalidate its caches afterwards
     * (`POST /api/cache/invalidateAll`).
     */
    async restoreSnapshotOrDatabase(templateName?: string): Promise<void> {
        const connector = Connector.current();
        const dbName = connector.databaseName();
        const template = templateName ?? dbName + "_Template";

        if (!connector.isPostgres) {
            await Administrator.snapshots.restoreSnapshot(template);
            return;
        }

        await connector.withDatabase(POSTGRES_MAINTENANCE_DB,
            () => Administrator.postgresTools.createDatabase(dbName, { fromTemplate: template }));
        // The pool was closed to switch away; the next statement opens a fresh one on the new database.
        await connector.closeConnection();
    },

    /** SQL Server database snapshots (Signum's `Administrator.Snapshots`). */
    snapshots: {
        /** `CREATE DATABASE … AS SNAPSHOT OF <db>`, replacing any snapshot of the same name. */
        async createSnapshot(snapshotName: string, options?: { overwrite?: boolean }): Promise<void> {
            const connector = Connector.current();
            const dbName = connector.databaseName();

            if (options?.overwrite !== false) {
                const existing = await connector.executeQuery(
                    "SELECT name FROM sys.databases WHERE name = @p0", [snapshotName]);
                if (existing.length > 0)
                    await Administrator.snapshots.dropSnapshot(snapshotName);
            }

            // A snapshot names a file per data file of the source; the ROWS file (type 0) is the one
            // Signum uses, written beside the process's working directory.
            const files = await connector.executeQuery(
                "SELECT name FROM sys.database_files WHERE type = 0") as { name: string }[];
            const logical = files[0]?.name;
            if (logical == null)
                throw new Error(`Cannot snapshot '${dbName}': it reports no data file.`);

            const file = path.join(process.cwd(), snapshotName + ".ss").replace(/'/g, "''");
            await connector.executeNonQuery(
                `CREATE DATABASE ${sqlServerName(snapshotName)} ON (NAME=${sqlServerName(logical)}, FILENAME='${file}')`
                + ` AS SNAPSHOT OF ${sqlServerName(dbName)}`);
        },

        async dropSnapshot(snapshotName: string): Promise<void> {
            await Connector.current().executeNonQuery(`DROP DATABASE ${sqlServerName(snapshotName)}`);
        },

        /** Roll the database back to a snapshot of it. Takes the database SINGLE_USER while it runs. */
        async restoreSnapshot(snapshotName: string): Promise<void> {
            const connector = Connector.current();
            const dbName = sqlServerName(connector.databaseName());
            await connector.executeNonQuery(
                `USE master;\n`
                + `ALTER DATABASE ${dbName} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n`
                + `RESTORE DATABASE ${dbName} FROM DATABASE_SNAPSHOT = '${snapshotName.replace(/'/g, "''")}';\n`
                + `ALTER DATABASE ${dbName} SET MULTI_USER;`);
            await connector.closeConnection();
        },
    },

    /** Database-level PostgreSQL operations (Signum's `Administrator.PostgressTools`). */
    postgresTools: {
        /**
         * `DROP DATABASE IF EXISTS` + `CREATE DATABASE` (optionally `WITH TEMPLATE`), terminating every
         * other connection to both first — Postgres refuses either statement while one is open, and the
         * application server under test is exactly such a connection.
         *
         * The CURRENT connector must be pointed at another database (`postgres`): a database cannot be
         * dropped from inside itself.
         */
        async createDatabase(dbName: string, options?: { fromTemplate?: string; closeConnections?: boolean }): Promise<void> {
            const connector = Connector.current();
            if (options?.closeConnections !== false) {
                await Administrator.postgresTools.closeConnections(dbName);
                if (options?.fromTemplate != null)
                    await Administrator.postgresTools.closeConnections(options.fromTemplate);
            }

            await connector.executeNonQuery(`DROP DATABASE IF EXISTS ${postgresName(dbName)};`);
            await connector.executeNonQuery(`CREATE DATABASE ${postgresName(dbName)}`
                + (options?.fromTemplate != null ? ` WITH TEMPLATE ${postgresName(options.fromTemplate)}` : "")
                + ";");
        },

        /** Terminate every backend connected to `dbName` except this one. */
        async closeConnections(dbName: string): Promise<void> {
            await Connector.current().executeNonQuery(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity`
                + ` WHERE datname = $1 AND pid <> pg_backend_pid();`, [dbName]);
        },
    },

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


/** The database a PostgreSQL statement that drops or creates ANOTHER database is issued from. */
const POSTGRES_MAINTENANCE_DB = "postgres";

/**
 * A database / file name that is about to be interpolated into DDL. `CREATE DATABASE` and
 * `RESTORE DATABASE` take no parameters in either dialect, so the name has to be part of the statement
 * text — which is safe only for a plain identifier, and that is what this asserts.
 */
function assertPlainName(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(name))
        throw new Error(`'${name}' is not a plain database name. A snapshot / template name is written`
            + ` into DDL, which takes no parameters, so it must be a bare identifier.`);
    return name;
}

function sqlServerName(name: string): string { return `[${assertPlainName(name)}]`; }
function postgresName(name: string): string { return `"${assertPlainName(name)}"`; }

// Signum's Administrator.MoveAllForeignKeys: point every foreign key that references `from` at `to`
// instead, in every table of the schema (collection rows included). What it is for is deleting a row that
// others still point at — ReNew moves a deleted user's history onto its "Deleted" system user. `shouldMove`
// narrows it to some columns.
export async function moveAllForeignKeys<T extends Entity>(
    from: Lite<T>, to: Lite<T>, shouldMove?: (table: Table, column: IColumn) => boolean,
): Promise<void> {
    if (from.entityType !== to.entityType)
        throw new Error("from and to should have the same type");
    if (from.id === to.id)
        throw new Error("from and to should not be the same");

    const connector = Connector.current();
    const schema = connector.schema;
    const refTable = schema.table(from.entityType as Type<Entity>);
    const p = (i: number): string => connector.isPostgres ? `$${i + 1}` : `@p${i}`;

    const updates: SqlPreCommand[] = [];
    for (const t of schema.tables.values())
        for (const col of Object.values(t.columns))
            if (col.referenceTable === refTable && (shouldMove == null || shouldMove(t, col)))
                updates.push(new SqlPreCommandSimple(
                    `UPDATE ${connector.sqlBuilder.objectName(t.name)}\nSET ${connector.sqlBuilder.sqlEscape(col.name)} = ${p(0)}\nWHERE ${connector.sqlBuilder.sqlEscape(col.name)} = ${p(1)}`,
                    [{ name: p(0), value: to.id }, { name: p(1), value: from.id }]));

    await Transaction.create(async () => {
        for (const update of updates)
            await update.executeNonQuery();
    });
}
