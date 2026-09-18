// `mssql` is CommonJS and exposes ConnectionPool only on its default export
// under native ESM (named imports resolve to undefined outside a bundler), so
// pull the value off the default to stay runnable under both Vite and plain
// `node`. The same name is imported type-only for annotations.
import mssql from 'mssql';
import type { config as MssqlConfig } from 'mssql';
const { ConnectionPool, Transaction: MssqlTransaction, Request: MssqlRequest, ISOLATION_LEVEL } = mssql;
type ConnectionPool = InstanceType<typeof ConnectionPool>;
type MssqlTransaction = InstanceType<typeof MssqlTransaction>;
import type { Schema } from '../schema/schema';
import type { IColumn } from '../schema/column';
import { isNullableToBool } from '../schema/dbType';
import { Connector } from './connector';
import type { ConnectionHandle, IsolationLevel } from './connector';
import { ForeignKeyException, UniqueKeyException } from './databaseExceptions';

// ---- Constraint-violation message parsing (Signum's UniqueKeyException / ForeignKeyException regexes)
//
// SQL Server sends nothing structured: `RequestError.number` is the only field, and the table, the
// constraint and the duplicate values all have to be read back out of the (LOCALIZED) message. These
// are Signum's own regexes, kept verbatim in shape — including the German variant of the duplicate-key
// sentence and the »guillemet« quoting some localized builds use — because there is no better source
// for what the server actually prints. Contrast postgresConnector, where the same facts arrive as
// fields on the error object and no message is read at all.

// Signum's UniqueKeyException.regexes (Exceptions.cs), one per localized wording of error 2601.
const DUPLICATE_KEY_REGEXES = [
    /Cannot insert duplicate key row in object '(?<table>.*)' with unique index '(?<index>.*)'\. The duplicate key value is \((?<value>.*)\)/,
    /Eine Zeile mit doppeltem Schlüssel kann in das Objekt "(?<table>.*)" mit dem eindeutigen Index "(?<index>.*)" nicht eingefügt werden\. Der doppelte Schlüsselwert ist \((?<value>.*)\)/,
];

// Signum's ForeignKeyException.indexRegex — the FK constraint name, in whichever quotes the localized
// message uses. Signum then SPLITS the name into table + column; altea looks the whole name up in the
// schema instead (see databaseExceptions), and only falls back to the split when the lookup misses.
const FOREIGN_KEY_NAME_REGEX = /['"»](FK_.+?)['"«]/i;

// Signum's ForeignKeyException.referedTable — `The conflict occurred in database "X", table "dbo.Alert",
// column 'State_ID'.` The word "table" is localized, which is a real limitation of this path; it is
// Signum's, and it only degrades the message (the sentence falls back to naming raw columns).
const REFERED_TABLE_REGEX = /table "(.+?)"/;

// The mssql `RequestError` fields this reads. `number` is the SQL Server error number, copied up from
// the underlying tedious error.
interface SqlServerError {
    number?: number;
    message?: string;
}

// Maps altea's dialect-neutral column type to the mssql type SqlBulkCopy needs. Uses the
// AbstractDbType family predicates + the SQL Server type name for the numeric/date subtypes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mssql's TYPES are loosely typed
function mssqlType(col: IColumn): any {
    const t = col.dbType;
    const name = t.sqlServer.toLowerCase();
    const c = col as { precision?: number; scale?: number; size?: number };
    if (t.isGuid()) return mssql.UniqueIdentifier;
    if (t.isBoolean()) return mssql.Bit;
    if (t.isString()) return mssql.NVarChar(mssql.MAX);
    if (t.isBinary()) return mssql.VarBinary(mssql.MAX);
    if (t.isDecimal()) return mssql.Decimal(c.precision ?? 18, c.scale ?? 2);
    if (t.isDate()) return name === 'date' ? mssql.Date
        : name === 'datetimeoffset' ? mssql.DateTimeOffset : mssql.DateTime2;
    if (t.isTime()) return mssql.Time;
    if (t.isNumber()) return name === 'bigint' ? mssql.BigInt
        : name === 'smallint' ? mssql.SmallInt
        : name === 'tinyint' ? mssql.TinyInt
        : name === 'float' ? mssql.Float
        : name === 'real' ? mssql.Real : mssql.Int;
    return mssql.NVarChar(mssql.MAX);
}

// Maps a dialect-neutral isolation level to mssql's numeric constant.
function mssqlIsolation(isolation: IsolationLevel): number {
    switch (isolation) {
        case 'ReadUncommitted': return ISOLATION_LEVEL.READ_UNCOMMITTED;
        case 'ReadCommitted': return ISOLATION_LEVEL.READ_COMMITTED;
        case 'RepeatableRead': return ISOLATION_LEVEL.REPEATABLE_READ;
        case 'Serializable': return ISOLATION_LEVEL.SERIALIZABLE;
        case 'Snapshot': return ISOLATION_LEVEL.SNAPSHOT;
    }
}

// A connection pinned for a Transaction's lifetime. When a database transaction
// is opened it runs through an mssql Transaction (and Requests bound to it);
// otherwise (Transaction.none/autocommit) it falls back to pool requests.
class SqlServerConnectionHandle implements ConnectionHandle {
    private tx: MssqlTransaction | undefined;

    constructor(private readonly pool: ConnectionPool) {}

    async beginTransaction(isolation?: IsolationLevel): Promise<void> {
        this.tx = new MssqlTransaction(this.pool);
        await this.tx.begin(isolation != null ? mssqlIsolation(isolation) : undefined);
    }

    async commit(): Promise<void> {
        if (this.tx != null) await this.tx.commit();
    }

    async rollback(): Promise<void> {
        if (this.tx != null) await this.tx.rollback();
    }

    async saveSavePoint(name: string): Promise<void> {
        await this.request().batch(`SAVE TRANSACTION ${name}`);
    }

    async rollbackToSavePoint(name: string): Promise<void> {
        await this.request().batch(`ROLLBACK TRANSACTION ${name}`);
    }

    async executeNonQuery(sql: string, parameters: unknown[] = []): Promise<number> {
        const req = this.request();
        parameters.forEach((p, i) => req.input(`p${i}`, p));
        // Parameterless statements go through batch() so standalone-batch DDL runs;
        // parameterized statements must use query(). Mirrors poolExecuteNonQuery.
        const res = parameters.length === 0 ? await req.batch(sql) : await req.query(sql);
        return (res.rowsAffected ?? []).reduce((a, b) => a + b, 0);
    }

    async executeQuery(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
        const req = this.request();
        parameters.forEach((p, i) => req.input(`p${i}`, p));
        const res = await req.query(sql);
        return res.recordset ?? [];
    }

    // SqlBulkCopy via mssql's Table + request.bulk. The request is bound to the active
    // transaction (see request()), so the bulk copy participates in it and rolls back with it.
    async bulkInsert(destinationTable: string, columns: IColumn[], rows: unknown[][]): Promise<void> {
        const tbl = new mssql.Table(destinationTable);
        for (const c of columns)
            tbl.columns.add(c.name, mssqlType(c), { nullable: isNullableToBool(c.nullable) });
        for (const row of rows)
            (tbl.rows as { add: (...v: unknown[]) => void }).add(...row);
        await this.request().bulk(tbl);
    }

    async dispose(): Promise<void> {
        // The mssql Transaction releases its pooled connection on commit/rollback;
        // just drop the reference so a stray statement can't reuse it.
        this.tx = undefined;
    }

    private request() {
        return this.tx != null ? new MssqlRequest(this.tx) : this.pool.request();
    }
}

// SQL Server connector. Dialect: SqlServer column types, [bracket] escaping,
// 128-char identifier limit, IDENTITY columns, clustered PKs. Executes through a
// lazily-connected `mssql` pool.
export class SqlServerConnector extends Connector {
    private pool: ConnectionPool | undefined;
    private connecting: Promise<ConnectionPool> | undefined;

    // Not readonly: `changeDatabase` re-points it at another database on the same server.
    constructor(schema: Schema, private config: MssqlConfig | string) {
        super(schema, /* isPostgres */ false, /* maxNameLength */ 128);
    }

    /**
     * Signum's `SqlServerConnector.ReplaceException`: error 2601 (duplicate key row in a unique index)
     * and 547 (foreign-key / reference constraint) become the framework exceptions; everything else is
     * handed back untouched.
     *
     * Signum's set also maps -2 → TimeoutException and 0/state 0/class 11 → OperationCanceledException.
     * Those are not constraint violations and altea has no counterpart class for either, so they are
     * deliberately left out of this item rather than half-ported.
     *
     * 2627 (`Violation of PRIMARY KEY constraint`) is likewise NOT mapped, matching Signum: altea
     * declares uniqueness with `CREATE UNIQUE INDEX`, which raises 2601, and a primary-key collision is
     * an engine bug rather than something to show a user. (On Postgres both share SQLSTATE 23505, so a
     * PK collision DOES reach UniqueKeyException there — and prints the raw constraint name, because a
     * primary key is not a registered TableIndex. Signum behaves identically.)
     */
    protected override replaceException(error: unknown, sql: string): unknown {
        if (error == null || typeof error !== "object")
            return error;
        const se = error as SqlServerError;
        const message = se.message ?? "";
        switch (se.number) {
            case 2601: {
                const m = DUPLICATE_KEY_REGEXES.map(rx => rx.exec(message)).find(m => m != null);
                if (m == null)
                    return error;
                return new UniqueKeyException(this, error, {
                    indexName: m.groups!["index"],
                    tableName: m.groups!["table"],
                    values: m.groups!["value"],
                });
            }
            case 547: {
                const constraintName = FOREIGN_KEY_NAME_REGEX.exec(message)?.[1];
                if (constraintName == null)
                    return error;
                // Locale-independent where Signum's `Message.Contains("INSERT")` is not: the failing
                // statement is in hand (see Connector.runTranslating), and only a DELETE can be the
                // blocked side. Signum's message test stays behind it for a statement that is neither.
                const verb = /^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase();
                const isInsert = verb === "INSERT" || verb === "UPDATE" ? true
                    : verb === "DELETE" ? false
                    : message.includes("INSERT") || message.includes("UPDATE");
                return new ForeignKeyException(this, error, {
                    constraintName,
                    // Error 547 names only the CONFLICTING table, which is the referenced one on a
                    // dangling write and the referencing one on a blocked delete — so it is passed as
                    // `referedTableName` only in the case where that is what it means.
                    referedTableName: isInsert ? REFERED_TABLE_REGEX.exec(message)?.[1] : undefined,
                    isInsert,
                });
            }
            default:
                return error;
        }
    }

    // The mssql pool must be connect()-ed before use; cache the in-flight promise
    // so concurrent callers share one connection attempt.
    private getPool(): Promise<ConnectionPool> {
        if (this.pool != null)
            return Promise.resolve(this.pool);
        return (this.connecting ??= this.connect());
    }

    private async connect(): Promise<ConnectionPool> {
        try {
            const pool = new ConnectionPool(this.config);
            await pool.connect();
            this.pool = pool;
            return pool;
        } catch (err) {
            // Clear the cached in-flight promise before rethrowing: `??=` would otherwise keep the
            // REJECTED promise forever, so every later call replays this one failure — the database
            // coming back up would still read as down until the process restarts.
            this.connecting = undefined;
            throw this.connectionError(err);
        }
    }

    protected connectionTarget(): string {
        if (typeof this.config === "string")
            return this.config;
        const c = this.config;
        return `${c.server ?? "localhost"}${c.port != null ? ":" + c.port : ""}/${c.database ?? ""}`;
    }

    async openConnection(): Promise<ConnectionHandle> {
        const handle = new SqlServerConnectionHandle(await this.getPool());
        // The projector normalises a raw DATEPART(weekday) to the ISO day-of-week using the
        // session DATEFIRST (ToDayOfWeekExpression), so cache it once. Read directly on the
        // handle (not executeQuery) so it never shows up in a SQL dump.
        if (this.dateFirst === undefined) {
            const rows = await handle.executeQuery("SELECT @@DATEFIRST AS df");
            this.dateFirst = Number((rows[0] as { df: number }).df);
        }
        return handle;
    }

    async closeConnection(): Promise<void> {
        await this.pool?.close();
        this.pool = undefined;
        this.connecting = undefined;
    }

    // ---- The database this connector is pointed at ---------------------------
    //
    // The connection string's `Database=` (ADO.NET also spells it `Initial Catalog=`, and so may a string
    // copied out of a Signum appsettings.json — both are read, the first is written).

    override databaseName(): string {
        if (typeof this.config !== "string")
            return this.config.database ?? "";
        return /(?:^|;)\s*(?:database|initial catalog)\s*=\s*([^;]*)/i.exec(this.config)?.[1]?.trim() ?? "";
    }

    protected override setDatabaseName(databaseName: string): void {
        if (typeof this.config !== "string") {
            this.config = { ...this.config, database: databaseName };
            return;
        }

        this.config = /(?:^|;)\s*(?:database|initial catalog)\s*=/i.test(this.config)
            ? this.config.replace(/((?:^|;)\s*(?:database|initial catalog)\s*=\s*)([^;]*)/i, `$1${databaseName}`)
            : `${this.config.replace(/;\s*$/, "")};Database=${databaseName}`;
    }

    // Drops all procedures, views, FK constraints, tables and non-system schemas,
    // in dependency-safe order. Ported from Signum's
    // SqlConnectorScripts.RemoveAllScript (temporal/partition/full-text steps are
    // omitted — altea doesn't generate those yet). Each cursor script is run as
    // its own batch.
    async cleanDatabase(): Promise<void> {
        for (const script of SqlServerConnector.removeAllScripts())
            await this.executeNonQuery(script);
    }

    // System schemas never dropped; views/schemas exclude these (dbo is kept for
    // its objects but is itself a system schema, so it is never dropped either).
    private static readonly systemSchemas = [
        'dbo', 'guest', 'INFORMATION_SCHEMA', 'sys',
        'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin',
        'db_backupoperator', 'db_datareader', 'db_datawriter',
        'db_denydatareader', 'db_denydatawriter',
    ];

    private static removeAllScripts(): string[] {
        const list = (names: readonly string[]) => names.map(s => `'${s}'`).join(', ');
        const systemSchemas = list(SqlServerConnector.systemSchemas);
        const systemSchemasExceptDbo = list(SqlServerConnector.systemSchemas.filter(s => s !== 'dbo'));

        const procedures = `declare @schema nvarchar(128), @proc nvarchar(128), @type nvarchar(128)
DECLARE @sql nvarchar(255)
declare cur cursor fast_forward for
select routine_schema, routine_name, routine_type from information_schema.routines
open cur
    fetch next from cur into @schema, @proc, @type
    while @@fetch_status <> -1
    begin
        select @sql = 'DROP '+ @type +' [' + @schema + '].[' + @proc + '];'
        exec sp_executesql @sql
        fetch next from cur into @schema, @proc, @type
    end
close cur
deallocate cur`;

        const views = `declare @schema nvarchar(128), @view nvarchar(128)
DECLARE @sql nvarchar(255)
declare cur cursor fast_forward for
select distinct table_schema, table_name from information_schema.tables
where table_type = 'VIEW' and table_schema not in (${systemSchemasExceptDbo})
open cur
    fetch next from cur into @schema, @view
    while @@fetch_status <> -1
    begin
        select @sql = 'DROP VIEW [' + @schema + '].[' + @view + '];'
        exec sp_executesql @sql
        fetch next from cur into @schema, @view
    end
close cur
deallocate cur`;

        // A system-versioned (temporal) table can't be dropped while SYSTEM_VERSIONING is ON, and
        // its history table is locked to it — so turn versioning OFF first, which detaches both
        // into ordinary tables the `tables` step can then drop. temporal_type 2 = the versioned
        // main table (its history table is 1, freed by the same ALTER).
        const disableVersioning = `declare @schema nvarchar(128), @tbl nvarchar(128)
DECLARE @sql nvarchar(255)
declare cur cursor fast_forward for
select s.name, t.name from sys.tables t join sys.schemas s on t.schema_id = s.schema_id where t.temporal_type = 2
open cur
    fetch next from cur into @schema, @tbl
    while @@fetch_status <> -1
    begin
        select @sql = 'ALTER TABLE [' + @schema + '].[' + @tbl + '] SET (SYSTEM_VERSIONING = OFF);'
        exec sp_executesql @sql
        fetch next from cur into @schema, @tbl
    end
close cur
deallocate cur`;

        const constraints = `declare @schema nvarchar(128), @tbl nvarchar(128), @constraint nvarchar(128)
DECLARE @sql nvarchar(255)
declare cur cursor fast_forward for
select distinct cu.constraint_schema, cu.table_name, cu.constraint_name
from information_schema.table_constraints tc
join information_schema.referential_constraints rc on rc.unique_constraint_name = tc.constraint_name
join information_schema.constraint_column_usage cu on cu.constraint_name = rc.constraint_name
open cur
    fetch next from cur into @schema, @tbl, @constraint
    while @@fetch_status <> -1
    begin
        select @sql = 'ALTER TABLE [' + @schema + '].[' + @tbl + '] DROP CONSTRAINT [' + @constraint + '];'
        exec sp_executesql @sql
        fetch next from cur into @schema, @tbl, @constraint
    end
close cur
deallocate cur`;

        const tables = `declare @schema nvarchar(128), @tbl nvarchar(128)
DECLARE @sql nvarchar(255)
declare cur cursor fast_forward for
select distinct table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE'
open cur
    fetch next from cur into @schema, @tbl
    while @@fetch_status <> -1
    begin
        select @sql = 'DROP TABLE [' + @schema + '].[' + @tbl + '];'
        exec sp_executesql @sql
        fetch next from cur into @schema, @tbl
    end
close cur
deallocate cur`;

        const schemas = `declare @schema nvarchar(128)
DECLARE @sql nvarchar(255)
declare cur cursor fast_forward for
select schema_name from information_schema.schemata where schema_name not in (${systemSchemas})
open cur
    fetch next from cur into @schema
    while @@fetch_status <> -1
    begin
        select @sql = 'DROP SCHEMA [' + @schema + '];'
        exec sp_executesql @sql
        fetch next from cur into @schema
    end
close cur
deallocate cur`;

        // Full-text catalogs are independent objects that survive DROP TABLE (a table's full-text
        // INDEX is dropped with it, but its CATALOG is not) — so drop them explicitly, after the
        // tables, or a re-generation fails with "a full-text catalog already exists". Empty on a
        // database without the Full-Text Search feature (sys.fulltext_catalogs has no rows).
        const fullTextCatalogs = `declare @cat nvarchar(128)
DECLARE @sql nvarchar(255)
declare cur cursor fast_forward for
select name from sys.fulltext_catalogs
open cur
    fetch next from cur into @cat
    while @@fetch_status <> -1
    begin
        select @sql = 'DROP FULLTEXT CATALOG [' + @cat + '];'
        exec sp_executesql @sql
        fetch next from cur into @cat
    end
close cur
deallocate cur`;

        return [procedures, views, disableVersioning, constraints, tables, fullTextCatalogs, schemas];
    }
}
