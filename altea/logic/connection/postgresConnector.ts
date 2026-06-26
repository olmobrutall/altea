import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import type { Schema } from '../schema/schema';
import { Connector } from './connector';

// PostgreSQL connector. Dialect: postgres column types, double-quote escaping,
// 63-char identifier limit. Executes through a lazily-created `pg` pool.
export class PostgresConnector extends Connector {
    private pool: Pool | undefined;

    constructor(schema: Schema, private readonly config: PoolConfig | string) {
        super(schema, /* isPostgres */ true, /* maxNameLength */ 63);
    }

    private getPool(): Pool {
        return (this.pool ??= new Pool(
            typeof this.config === 'string' ? { connectionString: this.config } : this.config,
        ));
    }

    async executeNonQuery(sql: string, parameters: unknown[] = []): Promise<number> {
        const res = await this.getPool().query(sql, parameters);
        return res.rowCount ?? 0;
    }

    async executeQuery(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
        const res = await this.getPool().query(sql, parameters as unknown[]);
        return res.rows;
    }

    async closeConnection(): Promise<void> {
        await this.pool?.end();
        this.pool = undefined;
    }
}
