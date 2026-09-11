// Port of the `IServerBroadcast` half of Signum.Caching's CacheLogic.cs — see port/Cache.md.
//
// The transport that tells SIBLING processes to invalidate: one method name + one string argument,
// deliberately tiny, because the payload is only ever "this table changed" / "everything changed".
//
// Two implementations: `PostgresBroadcast` (LISTEN/NOTIFY) and `SimpleHttpBroadcast` (the peers' own HTTP
// endpoints), the latter being what a SQL Server app uses — there are no query notifications to lean on.
export interface IServerBroadcast {
    /** Whether the transport is connected and listening. */
    readonly running: boolean;

    /** Connect + subscribe if not already. Idempotent. */
    startIfNecessary(): void | Promise<void>;

    /** Publish `(methodName, argument)` to every OTHER process. Never to this one. */
    send(methodName: string, argument: string): void;

    /** Handlers invoked for a message from another process. CacheLogic pushes one. */
    readonly onReceive: ((methodName: string, argument: string) => void)[];

    /** Shut the transport down (a graceful process exit). */
    stop(): void | Promise<void>;

    /** Shown on the statistics panel. */
    toString(): string;
}
