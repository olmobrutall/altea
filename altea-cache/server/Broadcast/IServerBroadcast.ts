// Port of Signum's `IServerBroadcast` (Signum.Caching/CacheLogic.cs). The transport that tells SIBLING
// processes to invalidate: one method name + one string argument, deliberately tiny, because the payload is
// only ever "this table changed" / "everything changed".
//
// Two implementations, matching Signum's usable set: `PostgresBroadcast` (LISTEN/NOTIFY) and
// `SimpleHttpBroadcast` (the peers' own HTTP endpoints) — the latter is what a SQL Server app uses, since
// Signum's SqlDependency has no Node equivalent (the driver has no query notifications) and the HTTP
// transport is what Signum itself offers for any database without pub/sub.
//
// altea divergence: Signum's `event Action<string, string>? Receive` becomes a handler ARRAY (altea has no
// C# events; every other altea hook list works this way), and `send` is async-tolerant — a Node transport
// writes to a socket.
export interface IServerBroadcast {
    /** Whether the transport is connected and listening. */
    readonly running: boolean;

    /** Connect + subscribe if not already (Signum's StartIfNecessary). Idempotent. */
    startIfNecessary(): void | Promise<void>;

    /** Publish `(methodName, argument)` to every OTHER process. Never to this one. */
    send(methodName: string, argument: string): void;

    /** Handlers invoked for a message from another process. CacheLogic pushes one. */
    readonly onReceive: ((methodName: string, argument: string) => void)[];

    /** Shut the transport down (a graceful process exit). */
    stop(): void | Promise<void>;

    /** Shown on the statistics panel — Signum renders `ServerBroadcast?.ToString()`. */
    toString(): string;
}
