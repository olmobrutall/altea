import { randomUUID } from "node:crypto";
import { PasswordEncoding } from "@altea/altea/server/passwordEncoding";
import { CacheLogic } from "../CacheLogic";
import type { IServerBroadcast } from "./IServerBroadcast";

// Port of Signum's SimpleHttpBroadcast (Signum.Caching/Broadcast/SimpleHttpBroadcast.cs): invalidation by
// POSTing to the sibling servers' own `/api/cache/invalidate*` endpoints. The transport of choice when the
// database offers no pub/sub (SQL Server, where query notifications need Service Broker support the Node
// driver does not have) — every node just needs to know the others' URLs.
//
// The endpoints are ANONYMOUS (the caller is a sibling process, not a user), so each request carries a hash
// of a shared secret; a request whose hash doesn't match is refused.
//
// altea divergences:
//  - Signum skips its own message by comparing machine name + application name; altea sends a per-PROCESS
//    id, which is strictly more precise (two processes of the same app on one machine are told apart, so a
//    node may safely list its own URL).
//  - `HttpClient` → `fetch` (built into Node), fire-and-forget with a short timeout: invalidation is
//    best-effort and must never slow down (or fail) the write that triggered it.
export interface SimpleHttpBroadcastOptions {
    /** The shared secret every participating server is configured with. */
    broadcastSecret: string;
    /** The other servers' base URLs, `;` or `,` separated (Signum's broadcastUrls). */
    broadcastUrls: string;
    /** Per-request timeout in ms (altea addition — Signum blocks on `.Result`). */
    timeoutMs?: number;
}

export class SimpleHttpBroadcast implements IServerBroadcast {
    readonly onReceive: ((methodName: string, argument: string) => void)[] = [];
    readonly running = true;

    readonly secretHash: string;
    private readonly urls: string[];
    private readonly timeoutMs: number;
    // This process's identity, echoed back in each message so we can ignore our own.
    private readonly origin = randomUUID();

    constructor(options: SimpleHttpBroadcastOptions) {
        this.secretHash = PasswordEncoding.hashPassword("", options.broadcastSecret).toString("base64");
        this.urls = options.broadcastUrls.split(/[;,]/).map(u => u.trim()).filter(u => u.length > 0);
        this.timeoutMs = options.timeoutMs ?? 5000;
    }

    startIfNecessary(): void {
        // Nothing to connect: the transport is the sibling servers' own HTTP API.
    }

    // Signum's AssertHash — called by the controller before acting on a request body.
    assertHash(secretHash: string | undefined): void {
        if (secretHash !== this.secretHash)
            throw new Error("broadcastSecret does not match");
    }

    // Called by CacheServer for POST /api/cache/invalidateTable.
    invalidateTable(request: { secretHash?: string, methodName?: string, argument?: string, origin?: string }): void {
        this.assertHash(request.secretHash);
        if (request.origin === this.origin)
            return; // our own message, bounced back because this node's URL is in its own list
        for (const h of this.onReceive)
            h(request.methodName ?? CacheLogic.Method_InvalidateAllTables, request.argument ?? "");
    }

    // Called by CacheServer for POST /api/cache/invalidateAll.
    invalidateAllTables(request: { secretHash?: string }): void {
        this.assertHash(request.secretHash);
        for (const h of this.onReceive)
            h(CacheLogic.Method_InvalidateAllTables, "");
    }

    send(methodName: string, argument: string): void {
        const body = JSON.stringify({ secretHash: this.secretHash, methodName, argument, origin: this.origin });
        for (const url of this.urls) {
            const fullUrl = url.replace(/\/+$/, "") + "/api/cache/invalidateTable";
            void fetch(fullUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                signal: AbortSignal.timeout(this.timeoutMs),
            }).catch(() => { /* best-effort: a node that is down will reload its cache when it comes back */ });
        }
    }

    stop(): void {
    }

    toString(): string {
        return `SimpleHttpBroadcast(Urls=${this.urls.join(", ")})`;
    }
}
