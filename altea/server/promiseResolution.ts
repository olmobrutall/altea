import { AsyncLocalStorage } from "node:async_hooks";
import { PromiseNotLoaded } from "./stablePromise";

// The region that lets a query's translation read a cache nobody loaded yet.
//
// Binding `vipCustomers().$v` reaches a real Promise (see data/stablePromise.ts). If it is stable but not
// loaded, the bind throws `PromiseNotLoaded` naming it; here we await exactly that promise and bind again.
// Nothing is warmed in advance, and nothing is loaded that no `.$v` asked for.

// A pure region reads a bounded number of `.$v`s, so it settles in as many attempts as it has distinct
// caches. The cap is only a liveness net — a cache invalidated between attempts legitimately costs one
// more, but a region that never converges should say so rather than spin.
const MAX_ATTEMPTS = 32;

// The promises being awaited in THIS async scope. A cache factory reads the database, so it re-enters the
// query boundary — and that nested region must still be able to load a DIFFERENT cache. Only a promise
// waiting on ITSELF is a cycle, so this is a set rather than a flag.
//
// It is not optional: without it the cycle DEADLOCKS instead of erroring. A factory whose own query reads
// the cache being loaded awaits the in-flight load from inside that very load, and nothing ever settles.
const awaiting = new AsyncLocalStorage<ReadonlySet<Promise<unknown>>>();

/**
 * Run a PURE synchronous region in which `.$v` may appear, loading on demand whatever it turns out to read.
 *
 * `fn` MUST be re-runnable: it runs once more per cache it reads cold. That holds for the LINQ
 * bind/optimise pipeline (a fresh QueryBinder per call, all of its state instance-local). It does NOT hold
 * for the Retriever's projector, which mutates the entities it materialises — nothing there reads `.$v`.
 */
export async function withPromisesLoaded<T>(fn: () => T): Promise<T> {
    // SHARED with any nested region, not copied: a nested one is always inside a load this region started,
    // so they are one chain. A top-level region inherits nothing and starts its own, which is what keeps
    // concurrent requests apart.
    const pending = awaiting.getStore() as Set<Promise<unknown>> | undefined ?? new Set();
    for (let attempt = 0; ; attempt++) {
        try {
            // `fn` runs INSIDE the scope because that is where a cache factory is started — the bind calls
            // `lazy.value()`, and the factory inherits the async context from there. Opening the scope
            // around the `await` below instead would leave the factory outside it, and a cycle would
            // deadlock rather than report.
            return awaiting.run(pending, fn);
        } catch (e) {
            if (!(e instanceof PromiseNotLoaded))
                throw e;
            if (pending.has(e.promise))
                throw new Error("A cache cannot load: a query issued by its own factory reads it through"
                    + " `.$v`. A row filter avoids this by suppressing itself in ExecutionMode.global,"
                    + " which is where every cache factory runs.");
            if (attempt >= MAX_ATTEMPTS)
                throw new Error(`A \`.$v\` in this query did not load after ${MAX_ATTEMPTS} attempts.`
                    + " Either a cache is being invalidated on every attempt, or its promise is not the same"
                    + " instance across binds (a stable promise must be memoised — see markStable).");
            // Added to the SHARED set before awaiting, so the factory's own nested region — which captured
            // this very set when the bind started it — sees it and reports the cycle. A rejected load
            // surfaces HERE, with the factory's own error, rather than as a translation failure.
            pending.add(e.promise);
            try {
                await e.promise;
            } finally {
                // Dropped once it has settled: a later attempt meeting the same promise again means the
                // cache was invalidated mid-region, which is one more legitimate round, not a cycle.
                pending.delete(e.promise);
            }
        }
    }
}
