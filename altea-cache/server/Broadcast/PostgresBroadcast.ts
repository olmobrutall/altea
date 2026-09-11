import { Client } from "pg";
import { Connector } from "@altea/altea/server/connection/connector";
import { PostgresConnector } from "@altea/altea/server/connection/postgresConnector";
import { CacheLogic } from "../CacheLogic";
import type { IServerBroadcast } from "./IServerBroadcast";

// Port of Signum.Caching's Broadcast/PostgresBroadcast.cs — see port/Cache.md.
//
// Cross-process cache invalidation over Postgres LISTEN/NOTIFY. The payload is `<method>/<pid>/<argument>`,
// and a message whose pid is OUR pid is IGNORED — that is how a process avoids acting on its own
// invalidations.
//
// The connection is a DEDICATED `Client`, never a pooled one: a LISTENing connection is not returned to
// the pool. Its sockets are `unref()`ed so it cannot hold the process open. The payload goes through
// `pg_notify(...)` as a PARAMETER rather than interpolated into a `NOTIFY` statement — a clean type name
// may contain a quote, and hand-built SQL here is a needless injection surface.
export const BROADCAST_CHANNEL = "altea_broadcast";

export class PostgresBroadcast implements IServerBroadcast {
    readonly onReceive: ((methodName: string, argument: string) => void)[] = [];
    private client: Client | undefined;
    private starting = false;
    running = false;

    // The pid the payload carries, so a process ignores its own messages.
    private readonly pid = process.pid;

    async startIfNecessary(): Promise<void> {
        if (this.running || this.starting)
            return;
        this.starting = true;
        try {
            const connector = Connector.current();
            if (!(connector instanceof PostgresConnector))
                throw new Error("PostgresBroadcast requires a PostgresConnector");

            const base = typeof connector.config === "string" ? { connectionString: connector.config } : connector.config;
            const client = new Client(base);
            try {
                await client.connect();
            } catch (err) {
                // This is the FIRST connection the process opens (Schema.initialize starts the cache before
                // anything queries), so it is the one a stopped database is met by — and pg's own rejection
                // is an AggregateError with an empty message. Name the target, keep the driver error as
                // `cause`; see Connector.connectionError.
                throw connector.connectionError(err, "the cache invalidation listener");
            }

            client.on("notification", msg => {
                try {
                    const payload = msg.payload ?? "";
                    const methodName = payload.substring(0, payload.indexOf("/"));
                    const rest = payload.substring(payload.indexOf("/") + 1);
                    const pid = Number(rest.substring(0, rest.indexOf("/")));
                    const argument = rest.substring(rest.indexOf("/") + 1);
                    if (pid === this.pid)
                        return;
                    for (const h of this.onReceive)
                        h(methodName, argument);
                } catch {
                    // A malformed payload must never take the listener down.
                }
            });

            client.on("error", () => {
                // The connection dropped (a restart, `pg_terminate_backend`, a network blip). Everything
                // this process holds may have been changed by someone else while we were deaf, so treat it
                // as "invalidate everything".
                this.running = false;
                this.client = undefined;
                for (const h of this.onReceive)
                    h(CacheLogic.Method_InvalidateAllTables, "");
            });

            await client.query(`LISTEN ${BROADCAST_CHANNEL}`);
            // Don't keep the event loop alive just to listen (a CLI/terminal host must still exit).
            (client as { connection?: { stream?: { unref?: () => void } } }).connection?.stream?.unref?.();

            this.client = client;
            this.running = true;
        } finally {
            this.starting = false;
        }
    }

    send(methodName: string, argument: string): void {
        const payload = `${methodName}/${this.pid}/${argument}`;
        // Fire-and-forget on the ORDINARY connection (the pool), so the notification rides the caller's
        // transaction: Postgres delivers a NOTIFY only when the transaction commits, which is exactly the
        // semantics wanted — a rolled-back write must not invalidate anyone's cache.
        void Connector.current()
            .executeNonQuery("SELECT pg_notify($1, $2)", [BROADCAST_CHANNEL, payload])
            .catch(() => { /* invalidation is best-effort: a failed notify must not fail the request */ });
    }

    async stop(): Promise<void> {
        this.running = false;
        const client = this.client;
        this.client = undefined;
        await client?.end().catch(() => { /* shutting down */ });
    }

    toString(): string {
        return `PostgresBroadcast(Running = ${this.running})`;
    }
}
