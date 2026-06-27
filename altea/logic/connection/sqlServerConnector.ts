// `mssql` is CommonJS and exposes ConnectionPool only on its default export
// under native ESM (named imports resolve to undefined outside a bundler), so
// pull the value off the default to stay runnable under both Vite and plain
// `node`. The same name is imported type-only for annotations.
import mssql from 'mssql';
import type { config as MssqlConfig } from 'mssql';
const { ConnectionPool } = mssql;
type ConnectionPool = InstanceType<typeof ConnectionPool>;
import type { Schema } from '../schema/schema';
import { Connector } from './connector';

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

    async executeNonQuery(sql: string, parameters: unknown[] = []): Promise<number> {
        const pool = await this.getPool();
        const req = pool.request();
        parameters.forEach((p, i) => req.input(`p${i}`, p));
        // With no parameters, use batch() (not query()) so standalone-batch DDL
        // like CREATE SCHEMA runs; parameterized statements must go through query().
        const res = parameters.length === 0 ? await req.batch(sql) : await req.query(sql);
        return (res.rowsAffected ?? []).reduce((a, b) => a + b, 0);
    }

    async executeQuery(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
        const pool = await this.getPool();
        const req = pool.request();
        parameters.forEach((p, i) => req.input(`p${i}`, p));
        const res = await req.query(sql);
        return res.recordset ?? [];
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
