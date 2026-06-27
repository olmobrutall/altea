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

    // Drops every view, table, sequence, extension and function in all
    // non-system schemas, plus owned non-default schemas. Ported from Signum's
    // PostgreSqlConnectorScripts.RemoveAllScript (the ExecuteAs role handling is
    // dropped — altea has no per-schema execute-as role).
    async cleanDatabase(): Promise<void> {
        await this.executeNonQuery(PostgresConnector.removeAllScript);
    }

    private static readonly removeAllScript = `
DO $$
DECLARE
        r RECORD;
BEGIN
        -- normal and materialised views
        FOR r IN (SELECT pns.nspname, pc.relname
                FROM pg_class pc, pg_namespace pns
                WHERE pns.oid=pc.relnamespace
                    AND pns.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
                    AND pc.relname NOT LIKE 'pg_%'
                    AND pc.relkind IN ('v', 'm')
            ) LOOP
                EXECUTE format('DROP VIEW %I.%I CASCADE;', r.nspname, r.relname);
        END LOOP;
        -- tables
        FOR r IN (SELECT pns.nspname, pc.relname
                FROM pg_class pc, pg_namespace pns
                WHERE pns.oid=pc.relnamespace
                    AND pns.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
                    AND pc.relkind='r'
            ) LOOP
                EXECUTE format('DROP TABLE %I.%I CASCADE;', r.nspname, r.relname);
        END LOOP;
        -- sequences
        FOR r IN (SELECT pns.nspname, pc.relname
                FROM pg_class pc, pg_namespace pns
                WHERE pns.oid=pc.relnamespace
                    AND pns.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
                    AND pc.relkind='S'
            ) LOOP
                EXECUTE format('DROP SEQUENCE %I.%I;', r.nspname, r.relname);
        END LOOP;
        -- functions / procedures
        FOR r IN (SELECT pns.nspname, pp.proname, pp.oid
                FROM pg_proc pp, pg_namespace pns
                WHERE pns.oid=pp.pronamespace
                    AND pns.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
            ) LOOP
                EXECUTE format('DROP FUNCTION %I.%I(%s);', r.nspname, r.proname,
                    pg_get_function_identity_arguments(r.oid));
        END LOOP;
        -- non-default schemata we own
        FOR r IN (SELECT pns.nspname
                FROM pg_namespace pns, pg_roles pr
                WHERE pr.oid=pns.nspowner
                    AND pns.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast', 'public')
                    AND pr.rolname=current_user
            ) LOOP
                EXECUTE format('DROP SCHEMA %I;', r.nspname);
        END LOOP;
END; $$;`;
}
