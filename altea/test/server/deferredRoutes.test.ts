import { test, describe } from "vitest";
import assert from "node:assert/strict";
import type { Express } from "express";
import { WebBuilder } from "@altea/altea/server/webApi";
import type { RequestFilter } from "@altea/altea/server/filters/requestFilter";

// `WebBuilder.deferRoutes` — the seam that lets a module which must START early still own its own HTTP
// surface.
//
// The invariant the whole thing rests on: a route folds the filter chain AS IT STANDS when it is
// registered, so a route registered before the auth module installed its user scope would never see an
// authenticated user, permanently. Deferring the registration is what puts it on the right side of that
// line. If this stops holding, a module's admin routes go unauthenticated and nothing fails loudly — so
// it is tested rather than remembered.

type Registered = { path: string; handler: (req: unknown, res: unknown, next: (e?: unknown) => void) => void };

/**
 * A stand-in for the Express app that just RECORDS what was registered. Express's own route store has
 * moved between majors and this test is not about Express — it is about which filter chain a route was
 * folded with, which is decided before `app.get` is ever called.
 */
function recordingApp(into: Registered[]): Express {
    return {
        get: (path: string, handler: Registered["handler"]) => into.push({ path, handler }),
        post: (path: string, handler: Registered["handler"]) => into.push({ path, handler }),
    } as unknown as Express;
}

/** Drive one recorded route to completion. */
async function invoke(routes: Registered[], path: string): Promise<void> {
    const route = routes.find(r => r.path === path);
    assert.ok(route != null, `no route registered at ${path}`);

    await new Promise<void>((resolve, reject) => {
        const res = { type: () => res, send: () => res, json: () => res, setHeader: () => { } };
        route!.handler({ headers: {}, query: {} }, res, (e?: unknown) => e ? reject(e) : resolve());
        setTimeout(resolve, 10);
    });
}

describe("WebBuilder.deferRoutes", () => {

    test("a DEFERRED route folds in a filter added after it was deferred", async () => {
        const ran: string[] = [];
        const routes: Registered[] = [];
        const ws = new WebBuilder(recordingApp(routes));
        ws.filters = []; // just the one under test, so the assertion is about ordering and nothing else

        // A module that starts EARLY defers its mount…
        ws.deferRoutes(() => ws.get("/api/deferred", { allowAnonymous: true },
            async () => { ran.push("deferred-handler"); }));

        // …then the auth module installs its filter…
        const userScope: RequestFilter = async (_c, next) => { ran.push("user-scope"); await next(); };
        ws.use(userScope);

        // …and only now is the route registered.
        ws.mountDeferredRoutes();

        await invoke(routes, "/api/deferred");
        assert.deepEqual(ran, ["user-scope", "deferred-handler"]);
    });

    test("an IMMEDIATE route registered before that filter does NOT get it — the reason deferral exists", async () => {
        const ran: string[] = [];
        const routes: Registered[] = [];
        const ws = new WebBuilder(recordingApp(routes));
        ws.filters = [];

        ws.get("/api/immediate", { allowAnonymous: true }, async () => { ran.push("immediate-handler"); });

        ws.use(async (_c, next) => { ran.push("user-scope"); await next(); });

        await invoke(routes, "/api/immediate");
        assert.deepEqual(ran, ["immediate-handler"]);
    });

    test("mounting twice runs each deferred mount once", () => {
        let mounts = 0;
        const ws = new WebBuilder(recordingApp([]));
        ws.deferRoutes(() => { mounts++; });

        ws.mountDeferredRoutes();
        ws.mountDeferredRoutes();

        assert.equal(mounts, 1);
    });
});
