import { ConnectionPool } from 'mssql';
import type { config as MssqlConfig } from 'mssql';
import type { Schema } from '../schema/schema';
import type { SqlPreCommandSimple } from '../sync/sqlPreCommand';
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

    async executeNonQuery(command: SqlPreCommandSimple): Promise<number> {
        const pool = await this.getPool();
        // batch() (not query()) so standalone-batch DDL like CREATE SCHEMA runs.
        const res = await pool.request().batch(command.sql);
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
}
