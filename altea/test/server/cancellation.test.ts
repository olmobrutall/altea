import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request, Response } from "express";
import "@altea/altea/data/globals";
import "@altea/altea/server/context.node";   // the culture filter needs its async-local backing
import { OperationCanceledException, isCanceled, throwIfCanceled } from "@altea/altea/server/cancellation";
import { cancellationFilter } from "@altea/altea/server/filters/cancellationFilter";
import { composeFilters, type RequestFilterContext } from "@altea/altea/server/filters/requestFilter";
import { createWebServer, defaultFilters, type TypedRequest } from "@altea/altea/server/webApi";
import { useExceptionFilter } from "@altea/altea/server/filters/exceptionFilter";
import { Connector, type ConnectionHandle } from "@altea/altea/server/connection/connector";
import { PostgresConnector } from "@altea/altea/server/connection/postgresConnector";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { MusicLogic } from "./MusicLogic";

// Request cancellation: the AbortSignal a route is handed as `req.cancellation` (Signum's trailing
// CancellationToken), and the one checkpoint every read passes through.

// A `res` that behaves like the real one for the two things the filter looks at.
class FakeResponse extends EventEmitter {
    writableEnded = false;
    finish(): void { this.writableEnded = true; this.emit("close"); }
    abandon(): void { this.emit("close"); }
}

function ctxWith(res: FakeResponse): RequestFilterContext {
    return {
        req: { headers: {}, method: "POST", originalUrl: "/api/query/executeQuery/Album" } as Request,
        res: res as unknown as Response,
        meta: { verb: "post", path: "/api/query/executeQuery/:queryKey" },
    };
}

describe("cancellationFilter", () => {

    test("publishes a signal the handler can read", async () => {
        const res = new FakeResponse();
        let seen: AbortSignal | undefined;
        await composeFilters([cancellationFilter], async c => { seen = c.signal; })(ctxWith(res));

        assert.ok(seen instanceof AbortSignal);
        assert.equal(seen.aborted, false);
    });

    test("a client that goes away mid-handler aborts the signal, with a loggable reason", async () => {
        const res = new FakeResponse();
        let reason: unknown;
        await composeFilters([cancellationFilter], async c => {
            res.abandon();
            reason = c.signal?.reason;
            assert.equal(c.signal?.aborted, true);
        })(ctxWith(res));

        assert.ok(reason instanceof OperationCanceledException);
        assert.match((reason as Error).message, /POST \/api\/query\/executeQuery\/Album/);
    });

    test("the ordinary close at the end of a response is NOT a cancellation", async () => {
        const res = new FakeResponse();
        let signal: AbortSignal | undefined;
        await composeFilters([cancellationFilter], async c => { signal = c.signal; })(ctxWith(res));
        res.finish();

        assert.equal(signal?.aborted, false);
    });

    test("is the outermost default filter, so the signal exists for every frame", () => {
        assert.equal(defaultFilters[0], cancellationFilter);
    });
});

describe("throwIfCanceled", () => {

    test("no signal means not cancellable, never cancelled", () => {
        assert.doesNotThrow(() => throwIfCanceled(undefined));
        assert.doesNotThrow(() => throwIfCanceled(new AbortController().signal));
    });

    test("throws the abort REASON, so the message says what was abandoned", () => {
        const controller = new AbortController();
        controller.abort(new OperationCanceledException("the client hung up"));

        assert.throws(() => throwIfCanceled(controller.signal), /the client hung up/);
    });

    test("a bare abort() still reads as a cancellation", () => {
        const controller = new AbortController();
        controller.abort();

        let caught: unknown;
        try { throwIfCanceled(controller.signal); } catch (e) { caught = e; }
        assert.equal(isCanceled(caught), true);
    });

    test("an ordinary error is not one", () => {
        assert.equal(isCanceled(new Error("boom")), false);
    });
});

describe("Connector.executeQuery checkpoint", () => {

    const sb = new SchemaBuilder();
    sb.settings.isPostgres = false;
    MusicLogic.start(sb);
    sb.complete();

    class CountingConnector extends Connector {
        statements = 0;
        constructor() { super(sb.schema, false, 128); }
        openConnection(): Promise<ConnectionHandle> {
            return Promise.resolve({
                executeQuery: () => { this.statements++; return Promise.resolve([]); },
                executeNonQuery: () => { this.statements++; return Promise.resolve(0); },
                beginTransaction: () => Promise.resolve(),
                commit: () => Promise.resolve(),
                rollback: () => Promise.resolve(),
                saveSavePoint: () => Promise.resolve(),
                rollbackToSavePoint: () => Promise.resolve(),
                bulkInsert: () => Promise.resolve(),
                dispose: () => Promise.resolve(),
            } satisfies ConnectionHandle);
        }
        closeConnection(): Promise<void> { return Promise.resolve(); }
        cleanDatabase(): Promise<void> { return Promise.resolve(); }
    }

    test("an already-cancelled read never reaches the database", async () => {
        const connector = new CountingConnector();
        const controller = new AbortController();
        controller.abort(new OperationCanceledException());

        await assert.rejects(() => connector.executeQuery("SELECT 1", [], controller.signal),
            (e: unknown) => isCanceled(e));
        assert.equal(connector.statements, 0);
    });

    test("without a signal, or with a live one, the statement runs", async () => {
        const connector = new CountingConnector();
        await connector.executeQuery("SELECT 1");
        await connector.executeQuery("SELECT 1", [], new AbortController().signal);

        assert.equal(connector.statements, 2);
    });

    // The point of the checkpoint: a dynamic query is several round trips (eager children, the main
    // SELECT, lazy MLists, the stub-completion batches), and an abort between any two stops the rest.
    test("cancelling between round trips stops the next one", async () => {
        const connector = new CountingConnector();
        const controller = new AbortController();

        await connector.executeQuery("SELECT 1", [], controller.signal);
        controller.abort(new OperationCanceledException());
        await assert.rejects(() => connector.executeQuery("SELECT 2", [], controller.signal));

        assert.equal(connector.statements, 1);
    });

    test("a write takes no signal at all — it cannot be half-abandoned", async () => {
        const connector = new CountingConnector();
        const controller = new AbortController();
        controller.abort(new OperationCanceledException());

        await Connector.withConnector(connector, () => connector.executeNonQuery("UPDATE x SET y = 1"));

        assert.equal(connector.statements, 1);
    });
});

// The assumption everything above rests on: that an aborted `fetch` actually reaches Node as a closed
// response. Proven over a real socket rather than a fake `res`, because nothing else would catch it if a
// future Express or Node stopped emitting `close` before the response was written.
describe("over a real socket", () => {

    /** A WebBuilder with one route that answers only when told, listening on an ephemeral port. */
    async function serve(handler: (req: TypedRequest<never, Request["params"]>, res: Response) => Promise<void>) {
        const ws = createWebServer();
        ws.get("/api/slow", {}, handler as never);
        useExceptionFilter(ws);
        const server = await new Promise<Server>(resolve => {
            const s = ws.app.listen(0, () => resolve(s));
        });
        const port = (server.address() as AddressInfo).port;
        return { url: `http://127.0.0.1:${port}/api/slow`, close: () => new Promise<void>(r => server.close(() => r())) };
    }

    test("aborting the fetch aborts the handler's signal, with the cancellation as the reason", async () => {
        let reason: unknown;
        let aborted!: () => void;
        const sawAbort = new Promise<void>(r => { aborted = r; });

        const { url, close } = await serve(async req => {
            req.cancellation!.addEventListener("abort", () => { reason = req.cancellation!.reason; aborted(); });
            await sawAbort;
            throwIfCanceled(req.cancellation);        // what a read's next round trip would do
        });

        const controller = new AbortController();
        const call = fetch(url, { signal: controller.signal });
        await new Promise(r => setTimeout(r, 50));
        controller.abort();
        await assert.rejects(() => call);
        await sawAbort;
        await close();

        assert.ok(reason instanceof OperationCanceledException);
        assert.match((reason as Error).message, /GET \/api\/slow/);
    });

    test("a request that is answered normally never looks cancelled", async () => {
        let abortedDuringHandler: boolean | undefined;
        const { url, close } = await serve(async (req, res) => {
            abortedDuringHandler = req.cancellation?.aborted;
            res.status(200).end();
        });

        const response = await fetch(url);
        await response.text();
        await close();

        assert.equal(response.status, 200);
        assert.equal(abortedDuringHandler, false);
    });
});

// ---- In-flight cancellation, against a real PostgreSQL -----------------------------------------
//
// The checkpoint above only stops the NEXT round trip. This is the half that stops the one already
// running, and it cannot be faked: whether `pg_cancel_backend` actually reaches the backend running our
// statement is a property of the server, not of this code. Skipped without ALTEA_TEST_DB, and on SQL
// Server (whose own path is `Request.cancel()`, untestable without an instance).
const pgConn = process.env["ALTEA_TEST_DB"];
const livePg = pgConn != undefined && pgConn.startsWith("postgres");

describe.skipIf(!livePg)("in-flight cancellation (live PostgreSQL)", () => {

    const sb = new SchemaBuilder();
    MusicLogic.start(sb);
    sb.complete();

    const connect = (): PostgresConnector => new PostgresConnector(sb.schema, pgConn!);

    test("a running statement is killed, not merely abandoned", async () => {
        const connector = connect();
        const controller = new AbortController();
        setTimeout(() => controller.abort(new OperationCanceledException()), 250);

        const started = performance.now();
        let caught: unknown;
        try {
            await connector.executeQuery("SELECT pg_sleep(30)", [], controller.signal);
        } catch (e) {
            caught = e;
        }
        const elapsed = performance.now() - started;
        await connector.closeConnection();

        assert.equal(isCanceled(caught), true, "a cancelled read reports the cancellation, not SQLSTATE 57014");
        // The statement asked for 30s. Anything near that means the cancel never arrived — and the suite's
        // own 30s timeout would have fired first.
        assert.ok(elapsed < 5000, `took ${Math.round(elapsed)}ms — the backend was not actually cancelled`);
    });

    test("the connector still works afterwards (the cancelled connection is discarded, not reused)", async () => {
        const connector = connect();
        const controller = new AbortController();
        setTimeout(() => controller.abort(new OperationCanceledException()), 200);

        await assert.rejects(() => connector.executeQuery("SELECT pg_sleep(30)", [], controller.signal));
        const rows = await connector.executeQuery("SELECT 42 AS n") as { n: number }[];
        await connector.closeConnection();

        assert.equal(rows[0]?.n, 42);
    });

    test("a signal that never fires costs the query nothing", async () => {
        const connector = connect();
        const rows = await connector.executeQuery("SELECT 7 AS n", [], new AbortController().signal) as { n: number }[];
        await connector.closeConnection();

        assert.equal(rows[0]?.n, 7);
    });

    // The reason the conversion is gated on the signal: PostgreSQL reports a statement_timeout with the
    // SAME SQLSTATE as a cancel (57014). Converting it blindly would file every timeout as a cancellation
    // — unlogged, and invisible.
    test("an unsolicited 57014 is a statement_timeout and keeps its own identity", async () => {
        const connector = connect();
        let caught: unknown;
        try {
            await connector.executeQuery("SET statement_timeout = 150; SELECT pg_sleep(30)", [],
                new AbortController().signal);
        } catch (e) {
            caught = e;
        }
        await connector.closeConnection();

        assert.equal((caught as { code?: string })?.code, "57014");
        assert.equal(isCanceled(caught), false);
    });
});
