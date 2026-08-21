import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

// NEW in altea — the substitute for ASP.NET **SignalR**, which Signum uses for its server→client push
// (Signum.ConcurrentUser's `ConcurrentUserHub`, and Alerts/Workflow notifications). Node has no SignalR
// server, and the client-side `@microsoft/signalr` package speaks a protocol only that server implements,
// so the hub abstraction is re-created here over a plain WebSocket (`ws`) — deliberately narrowed to the
// three things Signum's hubs actually use:
//
//   1. a stable per-connection id      (SignalR's `Context.ConnectionId`, stored on presence rows)
//   2. GROUPS                          (`Groups.AddToGroupAsync` / `Clients.Group(x).Method(...)`)
//   3. client→server METHOD calls      (a hub's public methods, invoked by `connection.send("Name", …)`)
//
// Everything else SignalR provides is out of scope: no negotiation handshake, no transport fallback
// (long-polling / SSE), no streaming, no MessagePack, no invocation RESULTS (every hub method Signum
// declares returns void or Task), and no automatic reconnect on the server side — the client hook
// (client/useWebSocket.tsx) reconnects, which is where SignalR's `withAutomaticReconnect` lived anyway.
//
// The wire format is one JSON object per frame: `{ m: "MethodName", a: [ …args ] }`, in BOTH directions.
// That is SignalR's invocation message stripped of its envelope (type/invocationId/target/arguments) —
// there are no results to correlate, so an invocation id would be dead weight.
//
// AUTHENTICATION is a per-hub seam rather than ambient. A browser `WebSocket` cannot set request headers,
// so altea's `Authorization: Bearer <token>` (client/Services) cannot ride the upgrade — and putting a
// token in the query string would log it in every proxy. So a connection starts UNAUTHENTICATED and must
// send `{ m: "$authenticate", a: [token] }` as its first frame; `authenticate` resolves it to whatever the
// owning module wants on `conn.user`, and until it resolves every other frame is QUEUED (not dropped, so
// the client never has to wait for a round-trip before its first real call). A hub that leaves
// `authenticate` unset is open, and `requireAuthentication` (default true when an authenticate hook is
// installed) decides whether an unauthenticated frame is an error.

/** One frame, in either direction. `m` = method name, `a` = positional arguments. */
export interface HubFrame {
    m: string;
    a?: unknown[];
}

/** The frame a client sends first to authenticate itself. */
export const authenticateMethod = "$authenticate";

export class HubConnection {
    readonly id: string = randomUUID();
    readonly groups = new Set<string>();
    /** Whatever the hub's `authenticate` resolved to (altea-concurrent-user puts the UserWithClaims here). */
    user: unknown;
    isAuthenticated = false;

    constructor(readonly hub: WebSocketHub, readonly socket: WebSocket, readonly request: IncomingMessage) { }

    /** SignalR's `Clients.Client(id).Method(args)`. Silently no-ops on a closed socket. */
    send(method: string, ...args: unknown[]): void {
        if (this.socket.readyState !== 1 /* OPEN */)
            return;
        this.socket.send(JSON.stringify({ m: method, a: args } satisfies HubFrame));
    }
}

export type HubMethod = (conn: HubConnection, ...args: any[]) => void | Promise<void>;

export class WebSocketHub {
    /** Client→server methods (a SignalR `Hub`'s public methods). Names are matched exactly. */
    readonly methods: Record<string, HubMethod> = {};

    /** SignalR's `OnConnectedAsync` / `OnDisconnectedAsync`. */
    onConnected?: (conn: HubConnection) => void | Promise<void>;
    onDisconnected?: (conn: HubConnection) => void | Promise<void>;

    /**
     * Resolves the `$authenticate` frame's token to a user (put on `conn.user`), or throws to reject the
     * connection. Left unset the hub is open to anyone who can reach the port.
     */
    authenticate?: (token: string | undefined, req: IncomingMessage) => Promise<unknown>;

    /** When an `authenticate` hook is installed, whether a frame arriving before it succeeded is an error. */
    requireAuthentication = true;

    /** Anything thrown by a hub method or lifecycle hook (Signum's LogHubExceptionFilter). */
    onError: (e: unknown, context: string) => void = (e, context) =>
        console.error(`[websocket] ${context}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);

    readonly connections = new Map<string, HubConnection>();
    private readonly groups = new Map<string, Set<HubConnection>>();

    constructor(readonly path: string) { }

    // ---- groups (SignalR's IGroupManager) ---------------------------------------------------------

    addToGroup(conn: HubConnection, group: string): void {
        conn.groups.add(group);
        let set = this.groups.get(group);
        if (set == undefined)
            this.groups.set(group, set = new Set());
        set.add(conn);
    }

    removeFromGroup(conn: HubConnection, group: string): void {
        conn.groups.delete(group);
        const set = this.groups.get(group);
        if (set != undefined) {
            set.delete(conn);
            if (set.size === 0)
                this.groups.delete(group);
        }
    }

    /** SignalR's `Clients.Group(group).Method(args)`. A group with no members is a no-op, as there. */
    sendToGroup(group: string, method: string, ...args: unknown[]): void {
        const set = this.groups.get(group);
        if (set == undefined)
            return;
        for (const conn of set) {
            try {
                conn.send(method, ...args);
            } catch (e) {
                this.onError(e, `sendToGroup('${group}', '${method}')`);
            }
        }
    }

    sendToAll(method: string, ...args: unknown[]): void {
        for (const conn of this.connections.values())
            conn.send(method, ...args);
    }

    // ---- connection lifecycle (driven by WebBuilder.attachWebSockets) ------------------------------

    /** @internal — called by the upgrade router once a socket is established on this hub's path. */
    accept(socket: WebSocket, request: IncomingMessage): void {
        const conn = new HubConnection(this, socket, request);
        this.connections.set(conn.id, conn);

        // Frames that arrived before `$authenticate` resolved. Held rather than dropped so a client can
        // pipeline its first real call right behind the auth frame (which is what useWebSocket does).
        const pending: HubFrame[] = [];
        let authenticating: Promise<void> | undefined;

        socket.on("message", raw => {
            let frame: HubFrame;
            try {
                frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as HubFrame;
            } catch (e) {
                this.onError(e, `${this.path}: malformed frame`);
                return;
            }

            if (frame.m === authenticateMethod) {
                authenticating = this.runAuthenticate(conn, frame.a?.[0] as string | undefined)
                    .then(() => {
                        const queued = pending.splice(0);
                        for (const f of queued)
                            void this.invoke(conn, f);
                    });
                return;
            }

            if (this.authenticate != undefined && !conn.isAuthenticated) {
                if (authenticating != undefined)
                    pending.push(frame);          // auth in flight — replayed above
                else if (this.requireAuthentication)
                    this.onError(new Error(`'${frame.m}' before ${authenticateMethod}`), this.path);
                else
                    void this.invoke(conn, frame);
                return;
            }

            void this.invoke(conn, frame);
        });

        socket.on("close", () => {
            this.connections.delete(conn.id);
            for (const group of [...conn.groups])
                this.removeFromGroup(conn, group);
            void Promise.resolve(this.onDisconnected?.(conn))
                .catch(e => this.onError(e, `${this.path}: onDisconnected`));
        });

        socket.on("error", e => this.onError(e, `${this.path}: socket`));

        // The client needs the server-side id (SignalR exposes it as `connection.connectionId` after
        // negotiation): ConcurrentUser stores it on its presence rows and filters itself out of the list.
        conn.send("$connected", conn.id);

        void Promise.resolve(this.onConnected?.(conn))
            .catch(e => this.onError(e, `${this.path}: onConnected`));
    }

    private async runAuthenticate(conn: HubConnection, token: string | undefined): Promise<void> {
        if (this.authenticate == undefined) {
            conn.isAuthenticated = true;
            return;
        }
        try {
            conn.user = await this.authenticate(token, conn.request);
            conn.isAuthenticated = true;
        } catch (e) {
            this.onError(e, `${this.path}: ${authenticateMethod}`);
            conn.socket.close(4001, "Unauthorized");
        }
    }

    private async invoke(conn: HubConnection, frame: HubFrame): Promise<void> {
        const method = this.methods[frame.m];
        if (method == undefined) {
            this.onError(new Error(`Unknown hub method '${frame.m}'`), this.path);
            return;
        }
        try {
            await method(conn, ...(frame.a ?? []));
        } catch (e) {
            this.onError(e, `${this.path}: ${frame.m}`);
        }
    }
}

/**
 * @internal Routes HTTP `upgrade` requests to the hub registered for their path. One `WebSocketServer`
 * in `noServer` mode per process does the handshake for every hub, mirroring how `MapHub<T>(path)` calls
 * share one SignalR middleware.
 */
export function attachHubs(server: { on(event: "upgrade", listener: (req: IncomingMessage, socket: any, head: Buffer) => void): unknown }, hubs: Map<string, WebSocketHub>): void {
    if (hubs.size === 0)
        return;

    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
        // `req.url` is path + query; hubs are keyed by path alone.
        const path = (req.url ?? "").split("?")[0]!;
        const hub = hubs.get(path);
        if (hub == undefined) {
            // Not ours: leave the socket to whatever else listens for `upgrade` (vite's HMR proxy, …).
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => hub.accept(ws, req));
    });
}
