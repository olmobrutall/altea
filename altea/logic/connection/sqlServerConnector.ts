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

    constructor(schema: Schema, private readonly config: MssqlConfig | string) {
        super(schema, /* isPostgres */ false, /* maxNameLength */ 128);
    }

    // The mssql pool must be connect()-ed before use; cache the in-flight promise
    // so concurrent callers share one connection attempt.
    private getPool(): Promise<ConnectionPool> {
        if (this.pool != null)
            return Promise.resolve(this.pool);
        return (this.connecting ??= this.connect());
    }

    private async connect(): Promise<ConnectionPool> {
        const pool = new ConnectionPool(this.config);
        await pool.connect();
        this.pool = pool;
        return pool;
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

        return [procedures, views, constraints, tables, schemas];
    }
}
