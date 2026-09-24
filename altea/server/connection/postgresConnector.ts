import { Pool, types as pgTypes } from 'pg';
import type { PoolConfig, PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import type { Schema } from '../schema/schema';
import type { IColumn } from '../schema/column';
import { Clock, TimeZoneMode } from '../../data/utils/clock';

// Postgres returns int8 (bigint — the type of COUNT(*), SUM(int), and Ticks) as a
// string to avoid precision loss past 2^53. altea treats these as JS numbers, so a
// per-pool parser coerces OID 20 (int8) → Number; everything else keeps pg's default
// parser. Notably numeric/OID 1700 STAYS a string: a `Decimal` (decimal.js) field is
// materialised from that exact string (see denormalizeDecimal), so no precision is lost.
// int4 ids are unaffected (already numbers).
// OIDs of the temporal types (date/time/timestamp/timestamptz/interval). node-postgres'
// default parsers build JS Date objects in the *local* timezone, which shifts a
// `timestamp without time zone` wall-clock; instead keep the raw text and let the
// projector parse it into a Temporal (see denormalizeTemporal).
const PG_TEMPORAL_OIDS = new Set([1082, 1083, 1114, 1184, 1186]);

const identityParser = (value: string | null) => value;

const ALTEA_PG_TYPES = {
    getTypeParser(oid: number, format?: unknown): unknown {
        if (oid === 20)
            return (value: string | null) => (value == null ? null : Number(value));
        if (PG_TEMPORAL_OIDS.has(oid))
            return identityParser;
        return (pgTypes.getTypeParser as (oid: number, format?: unknown) => unknown)(oid, format);
    },
};
import { Connector } from './connector';
import type { ConnectionHandle, IsolationLevel } from './connector';
import { ForeignKeyException, UniqueKeyException } from './databaseExceptions';

// The half of node-postgres' `DatabaseError` this reads — the structured fields the server sends
// alongside the message. They are what makes the Postgres path so much shorter than the SQL Server one:
// Signum has to regex the table and the constraint out of the text, and here they arrive as fields.
// All optional: an error raised before the server answered (a connection failure) carries none of them.
interface PostgresError {
    code?: string;
    detail?: string;
    schema?: string;
    table?: string;
    constraint?: string;
}

/**
 * The value list inside a Postgres constraint DETAIL — `Key (clean_name)=(Artist) already exists.` →
 * `Artist`, `Key (state_id)=(0) is not present in table "alert_state".` → `0`.
 *
 * Only the `(cols)=(values)` skeleton is matched, and that skeleton is NOT localized (the words around
 * it are, by `lc_messages`), so this reads the same on a German or Spanish server. Greedy on purpose: a
 * value may itself contain a parenthesis (`Key (name)=(Foo (Bar)) already exists.`).
 */
function detailValues(detail: string | undefined): string | undefined {
    return detail == null ? undefined : /\)\s*=\s*\((.*)\)/.exec(detail)?.[1];
}

/** The last double-quoted identifier in a DETAIL — the OTHER table of a foreign-key violation. */
function detailTable(detail: string | undefined): string | undefined {
    if (detail == null)
        return undefined;
    const quoted = detail.match(/"[^"]*"/g);
    return quoted == null ? undefined : quoted[quoted.length - 1].slice(1, -1);
}

// Maps a dialect-neutral isolation level to a Postgres BEGIN clause.
function pgIsolation(isolation: IsolationLevel): string {
    switch (isolation) {
        case 'ReadUncommitted': return 'READ UNCOMMITTED';
        case 'ReadCommitted': return 'READ COMMITTED';
        case 'RepeatableRead': return 'REPEATABLE READ';
        case 'Serializable': return 'SERIALIZABLE';
        case 'Snapshot':
            throw new Error('Snapshot isolation is not supported by PostgreSQL; use RepeatableRead or Serializable.');
    }
}

// A pg client checked out of the pool and pinned for a Transaction's lifetime.
// Savepoint names are validated by the caller (Transaction.namedSavePoint).
class PostgresConnectionHandle implements ConnectionHandle {
    constructor(private readonly client: PoolClient) {}

    async beginTransaction(isolation?: IsolationLevel): Promise<void> {
        await this.client.query(isolation != null ? `BEGIN ISOLATION LEVEL ${pgIsolation(isolation)}` : 'BEGIN');
    }

    async commit(): Promise<void> {
        await this.client.query('COMMIT');
    }

    async rollback(): Promise<void> {
        await this.client.query('ROLLBACK');
    }

    async saveSavePoint(name: string): Promise<void> {
        await this.client.query(`SAVEPOINT ${name}`);
    }

    async rollbackToSavePoint(name: string): Promise<void> {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    }

    async executeNonQuery(sql: string, parameters: unknown[] = []): Promise<number> {
        const res = await this.client.query(sql, parameters);
        return res.rowCount ?? 0;
    }

    async executeQuery(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
        const res = await this.client.query(sql, parameters);
        return res.rows;
    }

    // COPY … FROM STDIN in the default TEXT format. Values arrive already normalised
    // (Temporal/Decimal → strings) so encoding is per JS runtime type; nulls are \N and
    // tab/newline/backslash are escaped. Signum's Npgsql path uses BeginBinaryImport;
    // node-pg has no binary importer, so text COPY is the portable equivalent.
    async bulkInsert(destinationTable: string, columns: IColumn[], rows: unknown[][]): Promise<void> {
        const cols = columns.map(c => '"' + c.name.replace(/"/g, '""') + '"').join(', ');
        const stream = this.client.query(copyFrom(`COPY ${destinationTable} (${cols}) FROM STDIN`));
        await new Promise<void>((resolve, reject) => {
            stream.on('error', reject);
            stream.on('finish', () => resolve());
            for (const row of rows)
                stream.write(row.map(encodeCopyText).join('\t') + '\n');
            stream.end();
        });
    }

    async dispose(): Promise<void> {
        this.client.release();
    }
}

// Encodes one value for a COPY text stream: \N for null, 't'/'f' for booleans, ISO for
// Dates, bytea's hex input syntax for binary, and backslash/tab/newline/CR escaped for
// text. Everything else is stringified (numbers, and the strings normalizeScalar already
// produced for Temporal/Decimal).
function encodeCopyText(value: unknown): string {
    if (value == null) return '\\N';
    if (value === true) return 't';
    if (value === false) return 'f';
    // A Blob column (bytea). `String(bytes)` would decode the buffer as text — sending the raw
    // bytes, NULs included, so Postgres aborts the whole COPY with "invalid byte sequence for
    // encoding UTF8: 0x00". bytea's own input syntax is hex (`\x48656c6c6f`), and COPY's text
    // format needs that leading backslash escaped, hence `\\x…`.
    if (value instanceof Uint8Array)
        return '\\\\x' + Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
    const s = value instanceof Date ? value.toISOString() : String(value);
    return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// PostgreSQL connector. Dialect: postgres column types, double-quote escaping,
// 63-char identifier limit. Executes through a lazily-created `pg` pool.
export class PostgresConnector extends Connector {
    private pool: Pool | undefined;

    // `config` is PUBLIC (Signum: `Connector.CreateConnection()`): altea-cache's PostgresBroadcast needs its
    // OWN long-lived connection for LISTEN/NOTIFY, which must not come from the pool (it is never returned).
    // Not readonly: `changeDatabase` re-points it at another database on the same server (it replaces the
    // object rather than mutating it, so a component holding the old one keeps a coherent copy).
    constructor(schema: Schema, public config: PoolConfig | string) {
        super(schema, /* isPostgres */ true, /* maxNameLength */ 63);
    }

    /**
     * The server's major version, once {@link detectServerCapabilities} has run — Signum's
     * `PostgreSqlConnector.PostgresVersion`, narrowed to the part anything actually branches on.
     */
    serverVersion: { major: number } | undefined;

    /**
     * Signum's `PostgresVersionDetector.Detect`: `SHOW server_version`, tolerant of failure.
     *
     * altea diverges on WHEN, because it must: Signum detects synchronously in the connector's constructor,
     * and altea has no synchronous database access — so this is an async step the host runs right after
     * constructing the connector and BEFORE the schema is built, which is the point at which a generated
     * GUID key's default is decided (see SchemaBuilder). Leaving it uncalled is safe: an unknown version
     * means "assume modern", which is Signum's own answer for a null version.
     */
    override async detectServerCapabilities(): Promise<void> {
        try {
            const rows = await this.executeQuery("SHOW server_version") as { server_version: string }[];
            const raw = rows[0]?.server_version;
            const major = raw == undefined ? undefined : Number.parseInt(raw, 10);
            if (major != undefined && Number.isInteger(major))
                this.serverVersion = { major };
        } catch {
            // Undetectable — leave it unknown, which reads as modern.
        }
    }

    /**
     * `uuidv7()` is NATIVE from PostgreSQL 18; before that the time-ordered generator is
     * `uuid_generate_v1()` from the uuid-ossp extension. Unknown ⇒ modern, as in Signum
     * (`PostgresVersion == null || PostgresVersion.Major >= 18`).
     */
    override get supportsUuidV7(): boolean {
        return this.serverVersion == undefined || this.serverVersion.major >= 18;
    }

    /**
     * Signum's `PostgreSqlConnector.ReplaceException`: SQLSTATE 23505 (unique violation) and 23503
     * (foreign-key violation) become the framework exceptions that name the entity and the property;
     * everything else is handed back untouched.
     *
     * The one thing the driver does NOT say is which SIDE failed — both a blocked DELETE and a dangling
     * INSERT report the constraint's own (referencing) table. Signum decides by looking for "INSERT" /
     * "UPDATE" in the exception's localized message; the seam has the statement, so the leading verb
     * answers it instead, with the DETAIL comparison behind it for a statement whose verb says nothing
     * (a blocked delete names the referencing table in BOTH `table` and the detail, a dangling write
     * names the referenced one in the detail).
     */
    protected override replaceException(error: unknown, sql: string): unknown {
        if (error == null || typeof error !== "object")
            return error;
        const pg = error as PostgresError;
        switch (pg.code) {
            case "23505":
                return new UniqueKeyException(this, error, {
                    indexName: pg.constraint,
                    tableName: pg.table,
                    schemaName: pg.schema,
                    values: detailValues(pg.detail),
                });
            case "23503": {
                const other = detailTable(pg.detail);
                const verb = /^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase();
                const isInsert = verb === "INSERT" || verb === "UPDATE" ? true
                    : verb === "DELETE" ? false
                    : other != null && pg.table != null && other.toLowerCase() !== pg.table.toLowerCase();
                return new ForeignKeyException(this, error, {
                    constraintName: pg.constraint,
                    tableName: pg.table,
                    schemaName: pg.schema,
                    referedTableName: other,
                    isInsert,
                });
            }
            default:
                return error;
        }
    }

    private getPool(): Pool {
        const base = typeof this.config === 'string' ? { connectionString: this.config } : this.config;
        if (this.pool != null)
            return this.pool;

        // A UTC clock stores `timestamptz` (dbType.ts), and every conversion between it and a plain
        // wall time — a bound PlainDateTime parameter, a `::timestamp` cast, date_trunc / EXTRACT, the
        // text a read hands back — happens in the SESSION's zone. Pinning it to UTC makes all of them
        // the clock's frame, whatever the server's or the role's default is.
        const options = Clock.mode === TimeZoneMode.Utc ? [base.options, '-c TimeZone=UTC'].filter(o => o).join(' ') : base.options;

        const pool = new Pool({ ...base, options, types: ALTEA_PG_TYPES as PoolConfig['types'] });

        // An IDLE pooled client whose backend went away (a server restart, a `pg_terminate_backend`, a
        // dropped network) emits `error` on the POOL, and node kills the process for an unhandled 'error'
        // event — so without this listener a database hiccup takes the application server down with it.
        // The pool has already discarded the client by the time this runs; the next query opens a fresh
        // one. Logged, not thrown: nobody is awaiting it.
        pool.on('error', err => {
            console.warn(`[postgres] an idle connection was dropped (${(err as Error)?.message ?? err});`
                + ` the pool will open a new one.`);
        });

        return (this.pool = pool);
    }

    async openConnection(): Promise<ConnectionHandle> {
        try {
            return new PostgresConnectionHandle(await this.getPool().connect());
        } catch (err) {
            throw this.connectionError(err);
        }
    }

    protected connectionTarget(): string {
        if (typeof this.config === 'string')
            return this.config;
        const c = this.config;
        return c.connectionString ?? `${c.host ?? 'localhost'}:${c.port ?? 5432}/${c.database ?? ''}`;
    }

    async closeConnection(): Promise<void> {
        await this.pool?.end();
        this.pool = undefined;
    }

    // ---- The database this connector is pointed at ---------------------------
    //
    // A connection string reaches here in either libpq form: the URI (`postgresql://user@host/dbname`)
    // or the keyword one (`host=… dbname=…`). Both are read and rewritten, because either is a legal
    // value of the environment variable an application boots from.

    override databaseName(): string {
        if (typeof this.config !== "string")
            return this.config.database ?? (this.config.connectionString != null
                ? databaseOf(this.config.connectionString)
                : "");
        return databaseOf(this.config);
    }

    protected override setDatabaseName(databaseName: string): void {
        if (typeof this.config !== "string") {
            if (this.config.connectionString != null)
                this.config = { ...this.config, connectionString: withDatabase(this.config.connectionString, databaseName) };
            else
                this.config = { ...this.config, database: databaseName };
        } else {
            this.config = withDatabase(this.config, databaseName);
        }
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
        -- functions / procedures (skip those owned by an extension, e.g. pgvector's — they
        -- cannot be dropped individually; the extension itself is left in place, and re-generation
        -- re-creates it idempotently via CREATE EXTENSION IF NOT EXISTS)
        FOR r IN (SELECT pns.nspname, pp.proname, pp.oid
                FROM pg_proc pp, pg_namespace pns
                WHERE pns.oid=pp.pronamespace
                    AND pns.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
                    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = pp.oid AND d.deptype = 'e')
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

/** The database a libpq connection string names — the URI's path, or its `dbname=` keyword. */
function databaseOf(connectionString: string): string {
    if (/^postgres(ql)?:\/\//i.test(connectionString))
        return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));

    return /(?:^|\s)dbname\s*=\s*('[^']*'|\S*)/i.exec(connectionString)?.[1]?.replace(/^'|'$/g, "") ?? "";
}

/** The same connection string, naming `databaseName` instead. */
function withDatabase(connectionString: string, databaseName: string): string {
    if (/^postgres(ql)?:\/\//i.test(connectionString)) {
        const url = new URL(connectionString);
        url.pathname = "/" + encodeURIComponent(databaseName);
        return url.toString();
    }

    if (/(?:^|\s)dbname\s*=/i.test(connectionString))
        return connectionString.replace(/((?:^|\s)dbname\s*=\s*)('[^']*'|\S*)/i, `$1${databaseName}`);

    return `${connectionString} dbname=${databaseName}`;
}
