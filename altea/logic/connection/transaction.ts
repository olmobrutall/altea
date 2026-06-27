import { AsyncLocalStorage } from 'node:async_hooks';
import { Connector } from './connector';
import type { ConnectionHandle, IsolationLevel } from './connector';

// Lambda-based, async port of Signum's Transaction (Engine/Connection/Transaction.cs).
//
// Instead of `using (var tr = new Transaction()) { ...; tr.Commit(); }`, you wrap
// the work in a callback:
//
//     const result = await Transaction.create(async () => {
//         // ...do stuff on the current Connector...
//         return await myQuery.executeNonQuery();
//     });
//
// The callback returning normally commits; throwing rolls back and rethrows — no
// explicit Commit() call. Connectors are a connection *factory*: the real
// connection + database transaction live on a ConnectionHandle held by the core
// transaction here, kept in an AsyncLocalStorage context variable. Every
// executeNonQuery/executeQuery on the Connector inside the callback transparently
// routes to that pinned connection (see Connector.executeNonQuery).
//
// Nesting: the first Transaction.create opens a RealTransaction; a nested one
// reuses it via a FakedTransaction (no second database transaction). Other
// flavours: forceNew (independent real transaction), none (connection but no
// transaction — autocommit), namedSavePoint (savepoint inside the parent).
//
// Like Signum, the stack is keyed by Connector, so independent databases keep
// independent transactions within the same call.

// ---- User-facing hook + data types ------------------------------------------

export type TransactionUserData = Record<string, unknown>;
export type CommitHandler = (userData: TransactionUserData) => void | Promise<void>;
export type RolledbackHandler = (userData: TransactionUserData) => void | Promise<void>;

// ---- Core transaction (internal) --------------------------------------------
//
// One node of the implicit transaction stack. Exported only so the Connector
// dispatcher can find and start the active one; not part of the public surface.
export interface ICoreTransaction {
    readonly parent: ICoreTransaction | undefined;
    // True once this node (or an ancestor it delegates to) has been rolled back.
    readonly isRolledBack: boolean;
    readonly userData: TransactionUserData;

    // Lazily acquires the connection / opens the database transaction. Cheap to
    // call repeatedly; only the first call does work.
    start(): Promise<void>;
    // The pinned connection. Throws if called before start().
    connectionHandle(): ConnectionHandle;

    commit(): Promise<void>;
    rollback(error: unknown): Promise<void>;
    finish(): Promise<void>;
    callPostRealCommit(): Promise<void>;

    addPreRealCommit(handler: CommitHandler): void;
    addPostRealCommit(handler: CommitHandler): void;
    addRolledback(handler: RolledbackHandler): void;
}

// Per-connector stack of active core transactions. Server-only (it owns database
// connections), so this uses node's AsyncLocalStorage directly, matching
// connector.ts rather than the browser/server-agnostic Statics abstraction.
const currents = new AsyncLocalStorage<Map<Connector, ICoreTransaction>>();

// Used by Connector.executeNonQuery/executeQuery to route a statement onto the
// active transaction's connection (or undefined → use a pooled connection).
export function currentCoreTransaction(connector: Connector): ICoreTransaction | undefined {
    return currents.getStore()?.get(connector);
}

function getCurrentCore(): ICoreTransaction {
    const core = currents.getStore()?.get(Connector.current());
    if (core == null)
        throw new Error('No Transaction created yet. Wrap the call in Transaction.create(...).');
    return core;
}

// Runs handlers in order, by live index so a handler may enqueue more (the
// pre-real-commit pattern, e.g. flushing more work right before COMMIT).
async function runHandlers(handlers: CommitHandler[], userData: TransactionUserData): Promise<void> {
    for (let i = 0; i < handlers.length; i++)
        await handlers[i](userData);
}

// ---- Core transaction implementations ---------------------------------------

// The outermost transaction (or any forceNew): owns a real connection + database
// transaction.
class RealTransaction implements ICoreTransaction {
    private handle: ConnectionHandle | undefined;
    private started = false;
    private rolledBack = false;
    private data: TransactionUserData | undefined;
    private readonly pre: CommitHandler[] = [];
    private readonly post: CommitHandler[] = [];
    private readonly rolled: RolledbackHandler[] = [];

    constructor(
        private readonly connector: Connector,
        readonly parent: ICoreTransaction | undefined,
        private readonly isolation: IsolationLevel | undefined,
    ) {
        if (parent?.isRolledBack)
            throw new Error('Cannot start a transaction inside a rolled-back parent transaction.');
    }

    get isRolledBack(): boolean { return this.rolledBack; }
    get userData(): TransactionUserData { return (this.data ??= {}); }

    async start(): Promise<void> {
        if (this.started) return;
        this.handle = await this.connector.openConnection();
        await this.handle.beginTransaction(this.isolation);
        this.started = true;
    }

    connectionHandle(): ConnectionHandle {
        if (this.handle == null)
            throw new Error('Transaction not started.');
        return this.handle;
    }

    async commit(): Promise<void> {
        if (!this.started) return; // no statement ran → nothing to commit
        await runHandlers(this.pre, this.userData);
        await this.handle!.commit();
    }

    async rollback(error: unknown): Promise<void> {
        if (this.rolledBack) return;
        this.rolledBack = true;
        if (this.started) {
            await this.handle!.rollback();
            await runHandlers(this.rolled, this.userData);
        }
    }

    async finish(): Promise<void> {
        if (this.handle != null) {
            await this.handle.dispose();
            this.handle = undefined;
        }
    }

    async callPostRealCommit(): Promise<void> {
        await runHandlers(this.post, this.userData);
    }

    addPreRealCommit(handler: CommitHandler): void { this.pre.push(handler); }
    addPostRealCommit(handler: CommitHandler): void { this.post.push(handler); }
    addRolledback(handler: RolledbackHandler): void { this.rolled.push(handler); }
}

// A nested normal transaction: shares the parent's connection/transaction and
// creates no real database transaction. Commit is a no-op; rollback rolls back
// the whole (real) transaction, as in Signum.
class FakedTransaction implements ICoreTransaction {
    constructor(readonly parent: ICoreTransaction) {
        if (parent.isRolledBack)
            throw new Error('Cannot start a transaction inside a rolled-back parent transaction.');
    }

    get isRolledBack(): boolean { return this.parent.isRolledBack; }
    get userData(): TransactionUserData { return this.parent.userData; }

    start(): Promise<void> { return this.parent.start(); }
    connectionHandle(): ConnectionHandle { return this.parent.connectionHandle(); }

    async commit(): Promise<void> { /* the real parent commits */ }
    rollback(error: unknown): Promise<void> { return this.parent.rollback(error); }
    async finish(): Promise<void> { /* the real parent finishes */ }
    async callPostRealCommit(): Promise<void> { /* the real parent fires hooks */ }

    addPreRealCommit(handler: CommitHandler): void { this.parent.addPreRealCommit(handler); }
    addPostRealCommit(handler: CommitHandler): void { this.parent.addPostRealCommit(handler); }
    addRolledback(handler: RolledbackHandler): void { this.parent.addRolledback(handler); }
}

// A connection without a database transaction (autocommit). Each statement
// commits on its own; rollback cannot undo already-executed statements.
class NoneTransaction implements ICoreTransaction {
    private handle: ConnectionHandle | undefined;
    private started = false;
    private rolledBack = false;
    private data: TransactionUserData | undefined;
    private readonly pre: CommitHandler[] = [];
    private readonly post: CommitHandler[] = [];
    private readonly rolled: RolledbackHandler[] = [];

    constructor(
        private readonly connector: Connector,
        readonly parent: ICoreTransaction | undefined,
    ) {}

    get isRolledBack(): boolean { return this.rolledBack; }
    get userData(): TransactionUserData { return (this.data ??= {}); }

    async start(): Promise<void> {
        if (this.started) return;
        this.handle = await this.connector.openConnection(); // no beginTransaction → autocommit
        this.started = true;
    }

    connectionHandle(): ConnectionHandle {
        if (this.handle == null)
            throw new Error('Transaction not started.');
        return this.handle;
    }

    async commit(): Promise<void> {
        if (this.started) await runHandlers(this.pre, this.userData);
    }

    async rollback(error: unknown): Promise<void> {
        if (this.rolledBack) return;
        this.rolledBack = true;
        if (this.started) await runHandlers(this.rolled, this.userData);
    }

    async finish(): Promise<void> {
        if (this.handle != null) {
            await this.handle.dispose();
            this.handle = undefined;
        }
    }

    async callPostRealCommit(): Promise<void> {
        await runHandlers(this.post, this.userData);
    }

    addPreRealCommit(handler: CommitHandler): void { this.pre.push(handler); }
    addPostRealCommit(handler: CommitHandler): void { this.post.push(handler); }
    addRolledback(handler: RolledbackHandler): void { this.rolled.push(handler); }
}

// A savepoint inside the parent's real transaction: can roll back independently
// without aborting the whole transaction.
class NamedTransaction implements ICoreTransaction {
    private started = false;
    private rolledBack = false;
    private data: TransactionUserData | undefined;
    private readonly pre: CommitHandler[] = [];
    private readonly post: CommitHandler[] = [];
    private readonly rolled: RolledbackHandler[] = [];

    constructor(readonly parent: ICoreTransaction, private readonly savePointName: string) {
        if (parent.isRolledBack)
            throw new Error('Cannot start a savepoint inside a rolled-back parent transaction.');
    }

    get isRolledBack(): boolean { return this.rolledBack || this.parent.isRolledBack; }
    get userData(): TransactionUserData { return (this.data ??= {}); }

    async start(): Promise<void> {
        if (this.started) return;
        await this.parent.start();
        await this.parent.connectionHandle().saveSavePoint(this.savePointName);
        this.started = true;
    }

    connectionHandle(): ConnectionHandle { return this.parent.connectionHandle(); }

    async commit(): Promise<void> { /* savepoint is committed with the parent */ }

    async rollback(error: unknown): Promise<void> {
        if (this.rolledBack || this.parent.isRolledBack) return;
        this.rolledBack = true;
        if (this.started) {
            await this.parent.connectionHandle().rollbackToSavePoint(this.savePointName);
            await runHandlers(this.rolled, this.userData);
        }
    }

    async finish(): Promise<void> { /* the real parent finishes */ }

    // Defer this savepoint's hooks to the real parent so they fire (or not) with
    // the actual COMMIT, carrying this node's own userData.
    async callPostRealCommit(): Promise<void> {
        for (const handler of this.pre)
            this.parent.addPreRealCommit(() => handler(this.userData));
        for (const handler of this.post)
            this.parent.addPostRealCommit(() => handler(this.userData));
    }

    addPreRealCommit(handler: CommitHandler): void { this.pre.push(handler); }
    addPostRealCommit(handler: CommitHandler): void { this.post.push(handler); }
    addRolledback(handler: RolledbackHandler): void { this.rolled.push(handler); }
}

// SQL Server savepoint names and Postgres savepoint identifiers are interpolated
// raw, so constrain them to a plain identifier to keep that safe.
function validateSavePointName(name: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error(`Invalid savepoint name '${name}'. Use letters, digits and underscores, starting with a letter or underscore.`);
}

// ---- Public API -------------------------------------------------------------

export class Transaction {
    private constructor() {}

    // The default transaction. First one opens a real database transaction;
    // nested ones reuse it (no second transaction). Commits on normal return,
    // rolls back and rethrows on error.
    static create<T>(fn: () => Promise<T>, isolation?: IsolationLevel): Promise<T> {
        return Transaction.run(
            (connector, parent) => parent != null
                ? new FakedTransaction(parent)
                : new RealTransaction(connector, undefined, isolation),
            fn,
        );
    }

    // Always opens an independent real database transaction on its own
    // connection, even when nested inside another transaction.
    static forceNew<T>(fn: () => Promise<T>, isolation?: IsolationLevel): Promise<T> {
        return Transaction.run(
            (connector, parent) => new RealTransaction(connector, parent, isolation),
            fn,
        );
    }

    // A pinned connection but no database transaction (autocommit). For DDL or
    // statements that cannot run inside a transaction.
    static none<T>(fn: () => Promise<T>): Promise<T> {
        return Transaction.run(
            (connector, parent) => new NoneTransaction(connector, parent),
            fn,
        );
    }

    // A savepoint inside the surrounding real transaction; rolling back undoes
    // only the work since the savepoint. Must be nested inside another transaction.
    static namedSavePoint<T>(savePointName: string, fn: () => Promise<T>): Promise<T> {
        validateSavePointName(savePointName);
        return Transaction.run(
            (connector, parent) => {
                if (parent == null)
                    throw new Error('Transaction.namedSavePoint must be nested inside another transaction.');
                return new NamedTransaction(parent, savePointName);
            },
            fn,
        );
    }

    // Orchestrates one scope: build the core transaction, push it on the
    // per-connector stack for the duration of fn (via AsyncLocalStorage), then
    // commit on success or roll back on failure. The stack pop is automatic when
    // the AsyncLocalStorage.run scope unwinds.
    private static async run<T>(
        factory: (connector: Connector, parent: ICoreTransaction | undefined) => ICoreTransaction,
        fn: () => Promise<T>,
    ): Promise<T> {
        const connector = Connector.current();
        const parentMap = currents.getStore();
        const parentCore = parentMap?.get(connector);
        const core = factory(connector, parentCore);

        const map = new Map(parentMap ?? []);
        map.set(connector, core);

        let committed = false;
        let result: T;
        try {
            result = await currents.run(map, async () => {
                const value = await fn();
                if (core.isRolledBack)
                    throw new Error('The transaction was rolled back and cannot be committed.');
                // Commit inside the scope so pre-commit hooks still see the
                // ambient transaction and can run statements on it.
                await core.commit();
                committed = true;
                return value;
            });
        } catch (error) {
            if (!committed) {
                // Don't let a rollback failure mask the original error.
                try { await core.rollback(error); } catch { /* ignore */ }
            }
            await core.finish();
            throw error;
        }

        await core.finish();
        await core.callPostRealCommit();
        return result;
    }

    // ---- Ambient state / hooks ----------------------------------------------

    // Whether a transaction is currently active for the given connector.
    static hasTransaction(connector: Connector = Connector.current()): boolean {
        return currents.getStore()?.has(connector) ?? false;
    }

    // The active transaction's pinned connection, starting it if needed.
    static async currentConnection(): Promise<ConnectionHandle> {
        const core = getCurrentCore();
        await core.start();
        return core.connectionHandle();
    }

    // Mutable per-transaction bag, shared with hooks. Like Signum's UserData.
    static userData(): TransactionUserData {
        return getCurrentCore().userData;
    }

    // Runs just before the real COMMIT (may execute statements on the transaction).
    static preRealCommit(handler: CommitHandler): void {
        getCurrentCore().addPreRealCommit(handler);
    }

    // Runs after the real COMMIT succeeds (the connection is already released).
    static postRealCommit(handler: CommitHandler): void {
        getCurrentCore().addPostRealCommit(handler);
    }

    // Runs when this transaction is rolled back.
    static rolledback(handler: RolledbackHandler): void {
        getCurrentCore().addRolledback(handler);
    }
}
