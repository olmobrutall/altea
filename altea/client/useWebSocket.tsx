import * as React from "react";
import { useForceUpdate } from "./Hooks";
import { toAbsoluteUrl } from "./AppContext";

// Port of Signum's `useSignalR.tsx` (itself derived from react-use-signalr) — the client half of altea's
// SignalR substitute. See server/webSocketHub.ts for what the substitute does and does not cover; here the
// shape of the three hooks is kept identical to Signum's so the components that use them (ConcurrentUser)
// read the same, with `HubConnection` replaced by the small `HubConnection` class below:
//
//   useSignalRConnection(url, options)          → useWebSocketConnection(path)
//   useSignalRGroup(conn, { enter, exit, deps}) → useWebSocketGroup(conn, { … })   (unchanged shape)
//   useSignalRCallback(conn, name, cb, deps)    → useWebSocketCallback(conn, name, cb, deps)
//
// Divergences from the SignalR client:
//  - RECONNECT is ours (`withAutomaticReconnect` in Signum): an exponential backoff capped at 30s, reset
//    on a clean open. A reconnect gets a NEW server-side connection id, so a consumer must re-enter its
//    groups — which the `state` dependency in useWebSocketGroup already forces.
//  - AUTHENTICATION rides the first frame, not the request headers (a browser WebSocket cannot set
//    headers, and a token in the query string leaks into proxy logs). The token comes from
//    `setAccessTokenFactory` — the same token `client/Services` sends as `Authorization: Bearer`, so a
//    socket is exactly as authenticated as an ajax call — and is re-read on every (re)connect, so a
//    refreshed token is picked up.
//  - `window.__disableSignalR` (Signum's IIS connection-limit escape hatch on Windows client OS) becomes
//    `window.__disableWebSockets`, kept because the ConcurrentUser widget renders a warning from it.

declare global {
    interface Window {
        __disableWebSockets?: string | null;
    }
}

export type HubConnectionState = "Connecting" | "Connected" | "Reconnecting" | "Disconnected";

const authenticateMethod = "$authenticate";

// SignalR's `IHttpConnectionOptions.accessTokenFactory`, as a module-level seam: core stays
// auth-agnostic, and the auth module installs one (`setAccessTokenFactory(AuthClient.getAuthToken)`)
// exactly as it installs `setExtraHeaders` for the metadata fetch. Read on every (re)connect, so a
// refreshed token is picked up without touching the hook.
let _accessTokenFactory: (() => string | undefined) | undefined;
export function setAccessTokenFactory(factory: (() => string | undefined) | undefined): void {
    _accessTokenFactory = factory;
}

/** The client-side counterpart of server/webSocketHub.ts's HubConnection. */
export class HubConnection {
    state: HubConnectionState = "Disconnected";
    /** The server's connection id, pushed on `$connected`. Signum reads SignalR's `connectionId`. */
    connectionId: string | undefined;

    private socket: WebSocket | undefined;
    private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
    private readonly queue: string[] = [];
    private retries = 0;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private stopped = false;

    constructor(readonly url: string, private readonly onStateChange: () => void) { }

    on(method: string, handler: (...args: any[]) => void): void {
        let set = this.handlers.get(method);
        if (set == undefined)
            this.handlers.set(method, set = new Set());
        set.add(handler);
    }

    off(method: string, handler: (...args: any[]) => void): void {
        this.handlers.get(method)?.delete(handler);
    }

    /** SignalR's `connection.send(name, …args)`. Buffered while connecting, dropped once stopped. */
    send(method: string, ...args: unknown[]): Promise<void> {
        if (this.stopped)
            return Promise.resolve();

        const frame = JSON.stringify({ m: method, a: args });
        if (this.socket?.readyState === WebSocket.OPEN)
            this.socket.send(frame);
        else
            this.queue.push(frame);

        return Promise.resolve();
    }

    start(): void {
        this.stopped = false;
        this.open();
    }

    stop(): void {
        this.stopped = true;
        if (this.retryTimer != undefined)
            clearTimeout(this.retryTimer);
        this.queue.length = 0;
        const socket = this.socket;
        this.socket = undefined;
        this.setState("Disconnected");
        socket?.close();
    }

    private setState(state: HubConnectionState): void {
        if (this.state === state)
            return;
        this.state = state;
        this.onStateChange();
    }

    private open(): void {
        this.setState(this.retries === 0 ? "Connecting" : "Reconnecting");

        const socket = this.socket = new WebSocket(this.url);

        socket.onopen = () => {
            if (this.socket !== socket)
                return;
            this.retries = 0;
            // Auth first, then everything the consumer queued while we were connecting — the server holds
            // those frames until authentication resolves, so no round-trip is needed here.
            socket.send(JSON.stringify({ m: authenticateMethod, a: [_accessTokenFactory?.()] }));
            for (const frame of this.queue.splice(0))
                socket.send(frame);
            this.setState("Connected");
        };

        socket.onmessage = e => {
            let frame: { m: string; a?: unknown[] };
            try {
                frame = JSON.parse(e.data as string);
            } catch {
                console.warn("[websocket] malformed frame", e.data);
                return;
            }
            if (frame.m === "$connected") {
                this.connectionId = frame.a?.[0] as string;
                this.onStateChange();
                return;
            }
            const handlers = this.handlers.get(frame.m);
            if (handlers != undefined)
                for (const h of [...handlers])
                    h(...(frame.a ?? []));
        };

        socket.onclose = () => {
            if (this.socket !== socket || this.stopped)
                return;
            this.socket = undefined;
            this.connectionId = undefined;
            this.setState("Disconnected");
            const delay = Math.min(1000 * 2 ** this.retries, 30_000);
            this.retries++;
            this.retryTimer = setTimeout(() => { if (!this.stopped) this.open(); }, delay);
        };

        socket.onerror = () => { /* `onclose` always follows; the backoff there is the only handling. */ };
    }
}

let messageShownFor: string[] = [];

export function useWebSocketConnection(path: string): HubConnection | undefined {

    const forceUpdate = useForceUpdate();

    if (window.__disableWebSockets) {
        if (!messageShownFor.includes(path)) {
            console.warn("Skipped: " + path);
            console.warn(window.__disableWebSockets);
            messageShownFor.push(path);
        }
        return undefined;
    }

    // `toAbsoluteUrl` gives the same origin+base the ajax calls use, so a vite dev proxy (`ws: true`) or a
    // reverse proxy in front of the API host is honoured without extra configuration.
    const connection = React.useMemo(() => {
        const absolute = toAbsoluteUrl(path, window.__baseNameAPI);
        const url = new URL(absolute, window.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return new HubConnection(url.toString(), forceUpdate);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);

    React.useEffect(() => {
        connection.start();
        return () => connection.stop();
    }, [connection]);

    return connection;
}

export function useWebSocketGroup(connection: HubConnection | undefined, options: {
    enterGroup: (connection: HubConnection) => Promise<void>;
    exitGroup: (connection: HubConnection) => Promise<void>;
    deps: any[];
}): void {

    React.useEffect(() => {
        if (connection == undefined || connection.state !== "Connected")
            return;

        void options.enterGroup(connection);

        return () => {
            if (connection.state === "Connected")
                void options.exitGroup(connection).catch(e => {
                    if (connection.state === "Connected")
                        throw e;
                    /* the socket dropped mid-exit: the server already cleaned the group up on close */
                });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connection, connection?.state, ...options.deps]);
}

export function useWebSocketCallback(connection: HubConnection | undefined, methodName: string, callback: (...args: any[]) => void, deps: any[]): void {

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const memo = React.useCallback(callback, deps);

    React.useEffect(() => {
        if (connection == undefined || connection.state !== "Connected")
            return;

        connection.on(methodName, memo);
        return () => connection.off(methodName, memo);
    }, [connection, connection?.state, memo, methodName]);
}
