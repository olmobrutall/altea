import type { Request, Response } from "express";
import type { HttpMeta } from "../webApi";

// The per-request filter pipeline — altea's answer to Signum's MVC filter chain
// (`options.Filters.Add(...)` in SignumServer.cs, each one an `IAsyncResourceFilter`).
//
// altea has no MVC pipeline to hook, so `WebBuilder.route` used to do all of this inline: resolve and
// scope the culture, open the profiler and time-tracker spans, run the authorization gate, capture the
// serialization-auth snapshot, then call the handler. That worked, but it made every one of those
// concerns non-negotiable and unreachable from a test — a host could not reorder them, drop one, or add
// its own, and the only way to exercise "what happens around a handler" was to stand up a server.
//
// A filter is the same shape ASP.NET uses: it WRAPS `next`, which runs the rest of the chain and finally
// the handler. That is what lets a filter own a scope (`using`, AsyncLocalStorage) across the awaited
// handler rather than merely running before and after it.
//
//   const timing: RequestFilter = async (ctx, next) => {
//       using _ = TimeTracker.start(...);
//       await next();
//   };
//
// ORDER is registration order, outermost first — `ws.use(a); ws.use(b)` runs a( b( handler ) ). Signum's
// list is ordered the same way, and the two orderings that MATTER are the same here: authentication is
// outside culture (so the culture filter can read the user's own preference), and both are outside the
// handler.

/**
 * What a filter is handed. `req`/`res` are Express's own; `meta` is the route's declaration, so a filter
 * can act on `allowAnonymous` or the declared path without re-deriving it from the URL.
 */
export interface RequestFilterContext {
    readonly req: Request;
    readonly res: Response;
    readonly meta: HttpMeta;
    /**
     * The IMMUTABLE serialization-auth snapshot for this request, captured once before the handler and
     * read synchronously by both the request write-gate and the response codec. It lives on the context
     * rather than in a closure because the filter that resolves it and the code that reads it are now in
     * different files — and because a captured snapshot is the point: a rule invalidation mid-request
     * must not change how THIS request serializes.
     */
    authContext?: unknown;
}

/** Wrap the rest of the pipeline. Await `next()` exactly once; whatever you hold stays held across it. */
export type RequestFilter = (ctx: RequestFilterContext, next: () => Promise<void>) => Promise<void>;

/**
 * Fold the filters around `handler`, outermost first.
 *
 * Built once per route at registration rather than per request — the chain is fixed by then, and a route
 * on a hot path should not rebuild its own closures on every call.
 */
export function composeFilters(filters: readonly RequestFilter[], handler: (ctx: RequestFilterContext) => Promise<void>)
    : (ctx: RequestFilterContext) => Promise<void> {
    let run = handler;
    for (let i = filters.length - 1; i >= 0; i--) {
        const filter = filters[i]!;
        const inner = run;
        run = ctx => filter(ctx, () => inner(ctx));
    }
    return run;
}

/**
 * A filter that just holds a resource for the length of the request — Signum's
 * `SignumDisposableResourceFilter`, whose whole body is `using (GetResource(context)) await next();`.
 *
 * Worth a helper because that shape is most of them, and because getting it wrong is silent: open the
 * resource outside the `await` and it closes before the handler has run.
 */
export function holdingFilter(getResource: (ctx: RequestFilterContext) => Disposable | undefined): RequestFilter {
    return async (ctx, next) => {
        using _resource = getResource(ctx);
        await next();
    };
}
