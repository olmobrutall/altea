import { HeavyProfiler } from "../profiler/heavyProfiler";
import { TimeTracker } from "../profiler/timeTracker";
import { UserHolder } from "../userHolder";
import type { RequestFilter } from "./requestFilter";

// Signum's `SignumHeavyProfilerFilter` and `SignumTimesTrackerFilter`, which it registers as two separate
// filters — so they are two here as well. An app that wants request timings without the profiler's
// per-span overhead can install one and not the other.

/**
 * Run the request inside a HeavyProfiler SCOPE, with one `Web.API <VERB>` span covering it.
 *
 * The scope has to be opened here, outside the awaited handler, because the ambient `current` span
 * propagates through AsyncLocalStorage: every nested SQL / LINQ / save span hangs under this one only if
 * this one is already open when the handler starts.
 */
export const heavyProfilerFilter: RequestFilter = (ctx, next) =>
    HeavyProfiler.runScope(async () => {
        using _prof = HeavyProfiler.log("Web.API " + ctx.meta.verb.toUpperCase(), () => ctx.req.originalUrl);
        await next();
    });

/**
 * An always-on TimeTracker entry keyed by the route PATTERN, not the URL — Signum's
 * `SignumTimesTrackerFilter`, and the one and only TimeTracker call site.
 *
 * Keyed by pattern so `/api/entity/:type` aggregates instead of producing an entry per id; the URL rides
 * along as the sample's detail.
 */
export const timeTrackerFilter: RequestFilter = async (ctx, next) => {
    using _time = TimeTracker.start(
        ctx.meta.verb.toUpperCase() + " " + ctx.meta.path,
        ctx.req.originalUrl,
        () => UserHolder.currentUserLite()?.toString());
    await next();
};
