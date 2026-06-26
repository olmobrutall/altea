import { AsyncLocalStorage } from 'node:async_hooks';
import type { Schema } from '../schema/schema';
import { SqlBuilder } from '../sync/sqlBuilder';
import type { SqlPreCommand, SqlPreCommandSimple } from '../sync/sqlPreCommand';

// Ambient holder for the active connector. Connectors are server-only, so this
// uses node's AsyncLocalStorage directly rather than the browser/server-agnostic
// Statics context abstraction.
const connectorStorage = new AsyncLocalStorage<Connector>();

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

    // ---- Ambient access -----------------------------------------------------

    static default: Connector | undefined;

    static current(): Connector {
        const c = connectorStorage.getStore() ?? Connector.default;
        if (c == null)
            throw new Error('No current Connector. Set Connector.default or wrap the call in Connector.withConnector(connector, fn).');
        return c;
    }

    static withConnector<R>(connector: Connector, fn: () => R): R {
        return connectorStorage.run(connector, fn);
    }

    // ---- Live execution -----------------------------------------------------
    //
    // Both take raw SQL + positional parameters. The ergonomic entry points are
    // SqlPreCommand.executeNonQuery() / .executeQuery(), which read the SQL and
    // parameters off the command and dispatch to the *current* connector.

    // Runs a single statement, returning the affected row count.
    abstract executeNonQuery(sql: string, parameters?: unknown[]): Promise<number>;

    // Runs a query and returns its rows.
    abstract executeQuery(sql: string, parameters?: unknown[]): Promise<unknown[]>;

    // Releases the underlying connection/pool.
    abstract closeConnection(): Promise<void>;

    // Executes a whole generation/sync script statement by statement, in order,
    // on *this* connector (regardless of the ambient current()).
    async executeScript(command: SqlPreCommand): Promise<void> {
        for (const leaf of command.leaves())
            await this.executeNonQuery(leaf.sql, leaf.parameters?.map(p => p.value));
    }
}
