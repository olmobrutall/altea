import { AsyncLocalStorage } from 'node:async_hooks';
import type { Schema } from '../schema/schema';
import { SqlBuilder } from '../sync/sqlBuilder';
import type { SqlPreCommand, SqlPreCommandSimple } from '../sync/sqlPreCommand';
import { currentCoreTransaction } from './transaction';

// Ambient holder for the active connector. Connectors are server-only, so this
// uses node's AsyncLocalStorage directly rather than the browser/server-agnostic
// Statics context abstraction.
const connectorStorage = new AsyncLocalStorage<Connector>();

// A sink that executeQuery/executeNonQuery pass their SQL through when
// Connector.currentLogger is set — the analog of Signum's Connector.CurrentLogger
// (a TextWriter). Implementations decide where the text goes. NOTE: parameter
// values are passed verbatim, so only enable this against local/test databases.
export interface SqlLogger {
    log(sql: string, parameters: unknown[], elapsedMs: number): void;
}

// Writes each statement to the integrated terminal as a SQL comment block — the
// altea analog of Signum's DebugTextWriter. Used by the tests when debugging a
// single file (see altea-test/test/setup.ts).
export class ConsoleSqlLogger implements SqlLogger {
    log(sql: string, parameters: unknown[], elapsedMs: number): void {
        const params = parameters.length ? `\n-- params: ${JSON.stringify(parameters)}` : "";
        console.log(`-- ${elapsedMs.toFixed(1)} ms${params}\n${sql}\n`);
    }
}

// Transaction isolation levels, dialect-neutral. Mapped to the driver's own
// constants by each ConnectionHandle. `Snapshot` is SQL Server only.
export type IsolationLevel =
    | 'ReadUncommitted'
    | 'ReadCommitted'
    | 'RepeatableRead'
    | 'Serializable'
    | 'Snapshot';

// A pinned connection (optionally with an open database transaction) that
// statements execute against — the dialect-neutral role ADO.NET fills with
// DbConnection + DbTransaction. Created by Connector.openConnection() and owned
// by a Transaction's core for its lifetime. This is what lets every
// executeNonQuery/executeQuery inside a Transaction run on the *same* physical
// connection, instead of an arbitrary one from the pool.
export interface ConnectionHandle {
    // Opens a real database transaction on this connection. Skipped by
    // Transaction.none (autocommit). Optional isolation overrides the default.
    beginTransaction(isolation?: IsolationLevel): Promise<void>;
    // Commits / rolls back the transaction opened by beginTransaction. No-op if
    // none was opened (none/autocommit mode).
    commit(): Promise<void>;
    rollback(): Promise<void>;
    // Savepoints, for nested Transaction.namedSavePoint inside a real transaction.
    saveSavePoint(name: string): Promise<void>;
    rollbackToSavePoint(name: string): Promise<void>;
    // Runs a statement on this pinned connection.
    executeNonQuery(sql: string, parameters?: unknown[]): Promise<number>;
    executeQuery(sql: string, parameters?: unknown[]): Promise<unknown[]>;
    // Returns the connection to the pool / closes it.
    dispose(): Promise<void>;
}

// Binds a Schema to a concrete database: owns the dialect-specific SqlBuilder,
// exposes the dialect flag + identifier-length limit it needs, and executes
// commands against the live database. Mirrors Signum's Connector, scoped to what
// generation + the (stubbed) query path use today.
//
// Access the active connector through Connector.current() — an AsyncLocalStorage
// override (Connector.withConnector) falling back to a process-wide default
// (Connector.default), mirroring Signum's Current/Default split.
export abstract class Connector {
    readonly sqlBuilder: SqlBuilder;

    // `isPostgres` / `maxNameLength` are constructor parameters (not abstract
    // fields) so they are assigned before `new SqlBuilder(this)` reads them —
    // subclass field initializers would run too late (after super()).
    protected constructor(
        public readonly schema: Schema,
        public readonly isPostgres: boolean,
        public readonly maxNameLength: number,
    ) {
        this.sqlBuilder = new SqlBuilder(this);
    }

    // The session's SET DATEFIRST value (SQL Server), used by the projector to normalise a
    // raw DATEPART(weekday) to the ISO day-of-week (ToDayOfWeekExpression). Loaded lazily by
    // the SQL Server connector; stays undefined elsewhere (Postgres uses EXTRACT(isodow),
    // which is already ISO and needs no DATEFIRST).
    dateFirst: number | undefined;

    // ---- Ambient access -----------------------------------------------------

    static default: Connector | undefined;

    // Optional SQL logger — the analog of Signum's Connector.CurrentLogger. When
    // set, every executeQuery/executeNonQuery writes its SQL (+ parameters +
    // elapsed ms) to it. Process-wide and off by default; the tests turn it on
    // when debugging a single file so the terminal shows the generated SQL.
    static currentLogger: SqlLogger | undefined;

    static current(): Connector {
        const c = connectorStorage.getStore() ?? Connector.default;
        if (c == null)
            throw new Error('No current Connector. Set Connector.default or wrap the call in Connector.withConnector(connector, fn).');
        return c;
    }

    static withConnector<R>(connector: Connector, fn: () => R): R {
        return connectorStorage.run(connector, fn);
    }

    // ---- Utilities ----------------------------------------------------------

    // Redacts passwords from a connection string so it is safe to log, covering
    // both the key=value form (Password=... / Pwd=...) and the URL userinfo form
    // (scheme://user:password@host).
    static redactConnectionString(connectionString: string): string {
        return connectionString
            .replace(/(password|pwd)=([^;]*)/gi, "$1=***")
            .replace(/(:\/\/[^:/@]+:)([^@]*)@/g, "$1***@");
    }

    // ---- Live execution -----------------------------------------------------
    //
    // Both take raw SQL + positional parameters. The ergonomic entry points are
    // SqlPreCommand.executeNonQuery() / .executeQuery(), which read the SQL and
    // parameters off the command and dispatch to the *current* connector.
    //
    // Runs a single statement, returning the affected row count.
    executeNonQuery(sql: string, parameters: unknown[] = []): Promise<number> {
        return this.withLogging(sql, parameters, () =>
            this.ensureConnection(handle => handle.executeNonQuery(sql, parameters)));
    }

    // Runs a query and returns its rows.
    executeQuery(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
        return this.withLogging(sql, parameters, () =>
            this.ensureConnection(handle => handle.executeQuery(sql, parameters)));
    }

    // Times `run` and reports the statement to Connector.currentLogger when one is
    // set; a no-op fast path otherwise. The statement is logged even if it throws.
    private async withLogging<T>(sql: string, parameters: unknown[], run: () => Promise<T>): Promise<T> {
        const logger = Connector.currentLogger;
        if (logger == null)
            return run();
        const start = performance.now();
        try {
            return await run();
        } finally {
            logger.log(sql, parameters, performance.now() - start);
        }
    }

    // Decides which connection an action runs on — the analog of Signum's
    // EnsureConnectionRetry. When a Transaction is active for this connector, the
    // action runs on its pinned connection; otherwise it runs on a throwaway
    // connection opened just for this call. (This is where transient-fault retry
    // would wrap the no-transaction branch, as SqlServerRetry.Retry does.)
    protected async ensureConnection<T>(action: (handle: ConnectionHandle) => Promise<T>): Promise<T> {
        const core = currentCoreTransaction(this);
        if (core != null) {
            await core.start();
            return action(core.connectionHandle());
        }

        const handle = await this.openConnection();
        try {
            return await action(handle);
        } finally {
            await handle.dispose();
        }
    }

    // ---- Driver primitive ---------------------------------------------------

    // Pins a dedicated connection from the pool. Owned by a Transaction's core for
    // its lifetime, or opened-and-disposed per statement by ensureConnection when
    // no transaction is active.
    abstract openConnection(): Promise<ConnectionHandle>;

    // Releases the underlying connection/pool.
    abstract closeConnection(): Promise<void>;

    // Drops every table/view/constraint/etc. in the database, leaving it empty —
    // the equivalent of Signum's Connector.CleanDatabase. Used to make a full
    // generation re-runnable against a dirty database. Dialect-specific.
    abstract cleanDatabase(): Promise<void>;

    // Executes a whole generation/sync script statement by statement, in order,
    // on *this* connector (regardless of the ambient current()).
    async executeScript(command: SqlPreCommand): Promise<void> {
        for (const leaf of command.leaves())
            await this.executeNonQuery(leaf.sql, leaf.parameters?.map(p => p.value));
    }
}
