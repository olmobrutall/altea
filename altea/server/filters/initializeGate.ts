import type { IncomingMessage } from "node:http";
import { formatError } from "../formatError";

// Port of Signum's `SignumInitializeFilterAttribute` (old/Framework/Signum/API/Filters/SignumExceptionFilterAttribute.cs):
// the host builds the schema and LISTENS without touching the database, and the database work
// (`Schema.initialize`, the background runners, the start event) runs on the first request that needs it.
// `initialized` flips only on success, so a database that is down when the process starts costs that
// request an error, not the whole host — the next request tries again.
//
// altea divergences, documented inline:
//  - Signum's `lock` becomes ONE shared attempt (`pending`): concurrent requests await the same promise
//    instead of queueing, and a failed attempt is forgotten so the next request starts a new one.
//  - APP-level Express middleware, not a per-route filter, and mounted by the `WebBuilder` constructor
//    BEFORE the user scope: authentication already reads the database (and altea-isolation / altea-rest
//    `app.use` middleware runs before routing), while Signum's resource filter ran after ASP.NET's.
//  - `startInBackground`, which Signum does not have: a host may try once eagerly at start, so a healthy
//    boot is warm before the first request, while a failure is only logged.

export namespace InitializeGate {
    /**
     * Signum's `InitializeDatabase`. Set by the HOST before it listens. Unset, the gate lets every request
     * through (a test that builds a WebBuilder over an already-initialized schema), where Signum would throw.
     */
    export let initializeDatabase: (() => Promise<void>) | undefined;

    /**
     * Which requests need the database. Signum's filter ran for MVC actions only; the API is the equivalent
     * here, so the SPA and its assets still load and can show the failure as an error modal.
     */
    export let appliesTo: (path: string) => boolean = path => path.startsWith("/api");

    let initialized = false;
    let pending: Promise<void> | undefined;

    export function isInitialized(): boolean {
        return initialized || initializeDatabase == undefined;
    }

    /** Run `initializeDatabase` if it has not succeeded yet. Concurrent callers share one attempt. */
    export function ensure(): Promise<void> {
        if (isInitialized())
            return Promise.resolve();

        return pending ??= initializeDatabase!().then(
            () => { initialized = true; pending = undefined; },
            err => { pending = undefined; throw err; });
    }

    /**
     * Try once right after `listen`, without making a failure fatal: the request that next passes the gate
     * retries it.
     */
    export function startInBackground(appName: string): void {
        void ensure().then(
            () => console.log(`[${appName}] database initialized`),
            err => console.warn(`[${appName}] database not available yet, will retry on next request:\n${formatError(err)}`));
    }
}

interface AppLike { use(handler: (req: { path: string }, res: unknown, next: (err?: unknown) => void) => void): void; }

/** Mounted once, FIRST, by the WebBuilder constructor. Nothing else should call this. */
export function useInitializeGate(app: AppLike): void {
    app.use((req, _res, next) => {
        if (InitializeGate.isInitialized() || !InitializeGate.appliesTo(req.path)) {
            next();
            return;
        }
        // A failure goes to `next(err)`, so the exception filter answers the HttpError the client shows.
        InitializeGate.ensure().then(() => next(), next);
    });
}

/**
 * The WebSocket side: an upgrade is refused while the database is not initialized (the client hook
 * reconnects). It does not trigger the initialization itself — a hub connection is never the first thing a
 * page does.
 */
export function rejectUpgradeIfNotInitialized(_req: IncomingMessage, socket: { write(data: string): unknown; destroy(): void }): boolean {
    if (InitializeGate.isInitialized())
        return false;

    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return true;
}
