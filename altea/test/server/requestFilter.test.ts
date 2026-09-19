import { test, describe } from "vitest";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
    composeFilters, holdingFilter, type RequestFilter, type RequestFilterContext,
} from "@altea/altea/server/filters/requestFilter";
import { defaultFilters } from "@altea/altea/server/webApi";

// The pipeline that wraps every route. Its ORDER is the part worth pinning: each frame has to be able to
// see what it needs — the gate before the auth snapshot, and both before the culture chain. Get it wrong
// and nothing throws; the gate just starts seeing nobody, which reads as "everything is 403" or, worse,
// as "everyone is anonymous".

function ctx(): RequestFilterContext {
    return { req: { headers: {} } as Request, res: {} as Response, meta: { verb: "get", path: "/x" } };
}

/** A filter that records when it enters and leaves. */
function recording(log: string[], name: string): RequestFilter {
    return async (_c, next) => { log.push(`>${name}`); await next(); log.push(`<${name}`); };
}

describe("composeFilters", () => {

    test("runs filters outermost-first and nests them around the handler", async () => {
        const log: string[] = [];
        const run = composeFilters(
            [recording(log, "a"), recording(log, "b")],
            async () => { log.push("handler"); });

        await run(ctx());

        assert.deepEqual(log, [">a", ">b", "handler", "<b", "<a"]);
    });

    test("an empty chain is just the handler", async () => {
        const log: string[] = [];
        await composeFilters([], async () => { log.push("handler"); })(ctx());
        assert.deepEqual(log, ["handler"]);
    });

    test("every filter sees the SAME context, so one can publish to the next", async () => {
        const seen: unknown[] = [];
        const publish: RequestFilter = async (c, next) => { c.authContext = "snapshot"; await next(); };
        const read: RequestFilter = async (c, next) => { seen.push(c.authContext); await next(); };

        await composeFilters([publish, read], async c => { seen.push(c.authContext); })(ctx());

        assert.deepEqual(seen, ["snapshot", "snapshot"]);
    });

    test("a throwing handler propagates out through the filters", async () => {
        const log: string[] = [];
        const run = composeFilters([recording(log, "a")], async () => { throw new Error("boom"); });

        await assert.rejects(() => run(ctx()), /boom/);
        // "<a" is absent: the filter's own tail did not run, which is exactly why the route wrapper — not
        // a filter — owns the catch that funnels to the exception filter.
        assert.deepEqual(log, [">a"]);
    });

    test("holdingFilter keeps its resource open ACROSS the awaited handler", async () => {
        const log: string[] = [];
        const filter = holdingFilter(() => {
            log.push("open");
            return { [Symbol.dispose]: () => log.push("close") };
        });

        await composeFilters([filter], async () => {
            await Promise.resolve();
            log.push("handler");
        })(ctx());

        assert.deepEqual(log, ["open", "handler", "close"]);
    });
});

describe("the default chain", () => {

    test("orders the frames so each one can see what it needs", () => {
        const names = defaultFilters.map(f => f.name);

        assert.ok(names.indexOf("authorizationFilter") > names.indexOf("heavyProfilerFilter"),
            "the gate should be measured");
        assert.ok(names.indexOf("serializationAuthFilter") > names.indexOf("authorizationFilter"),
            "the auth snapshot is taken once the role is settled");
        assert.ok(names.indexOf("cultureFilter") > names.indexOf("authorizationFilter"),
            "Signum lists the culture selector after authentication for the same reason");
    });

    test("does NOT include a user frame — that one is app-level middleware", () => {
        // altea-isolation and altea-rest read the current user from their own `app.use`, which runs
        // before any route, so a route-level user frame would leave them looking at nobody.
        assert.equal(defaultFilters.some(f => /user/i.test(f.name)), false);
    });
});
