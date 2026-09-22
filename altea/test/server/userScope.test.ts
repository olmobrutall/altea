import { test, describe } from "vitest";
import assert from "node:assert/strict";
import type { Express } from "express";
import { WebBuilder } from "@altea/altea/server/webApi";
import { setAuthenticateRequest } from "@altea/altea/server/filters/userScope";
import { UserHolder } from "@altea/altea/server/userHolder";
import type { UserWithClaims } from "@altea/altea/data/security";

// The user scope is mounted by the WebBuilder CONSTRUCTOR, and who the request is arrives later through
// `setAuthenticateRequest`.
//
// That split is the whole point: Express runs middleware in REGISTRATION order, so a scope mounted by
// whichever module happened to want it first would leave every route registered before it permanently
// without a user — and nothing would fail loudly, an admin surface would just be unauthenticated. With
// the scope up front, a module's start position stops being security-relevant, which is what let
// `deferRoutes` go. If this stops holding, it stops silently, so it is tested rather than remembered.

type Middleware = (req: unknown, res: unknown, next: (e?: unknown) => void) => void;

/**
 * A stand-in for the Express app that RECORDS what was mounted. Express's own stores have moved between
 * majors and this test is not about Express — it is about the ORDER in which altea registers.
 */
function recordingApp(mounted: Middleware[], routes: string[]): Express {
    return {
        use: (handler: Middleware) => mounted.push(handler),
        get: (path: string) => routes.push(path),
        post: (path: string) => routes.push(path),
    } as unknown as Express;
}

/** Run the scope middleware to its `next()`, and report what the user was inside it. */
function userSeenBy(middleware: Middleware): Promise<UserWithClaims | undefined> {
    return new Promise((resolve, reject) => {
        middleware({ header: () => undefined, query: {} }, { setHeader: () => { } },
            e => e ? reject(e) : resolve(UserHolder.current()));
    });
}

describe("the per-request user scope", () => {

    test("is mounted before anything a module can register", () => {
        const mounted: Middleware[] = [];
        const routes: string[] = [];
        const ws = new WebBuilder(recordingApp(mounted, routes));

        ws.get("/api/early", { allowAnonymous: true }, async () => { });

        assert.equal(mounted.length, 1, "the constructor mounts exactly one middleware");
        assert.deepEqual(routes, ["/api/early"]);
    });

    test("an authenticator installed AFTER a route still names the user for it", async () => {
        const mounted: Middleware[] = [];
        const ws = new WebBuilder(recordingApp(mounted, []));

        // A module that must start early mounts its admin surface here and now…
        ws.get("/api/cache/state", { allowAnonymous: true }, async () => { });

        // …and only afterwards does the auth module fill the seam. The user is a stand-in: the scope only
        // ever stores what the authenticator hands back.
        const someone = { userName: "System", claims: {} } as unknown as UserWithClaims;
        setAuthenticateRequest(async () => someone);

        assert.equal(await userSeenBy(mounted[0]), someone);
    });

    test("with no authenticator the request proceeds with no user", async () => {
        const mounted: Middleware[] = [];
        // eslint-disable-next-line no-new
        new WebBuilder(recordingApp(mounted, []));

        setAuthenticateRequest(async () => undefined);

        assert.equal(await userSeenBy(mounted[0]), undefined);
    });
});
