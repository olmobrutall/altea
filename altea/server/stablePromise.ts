import type { RuntimeType } from "./runtimeTypes";

// STABLE promises — the only promises `.$v` may unwrap inside a query.
//
// A query lambda is CONSTANT-FOLDED wherever it is written, and a parameter-free subtree is folded by
// RUNNING it, so `vipCustomers().$v` reaches a real Promise during translation. A promise is readable there
// only if it CARRIES the two things the translator needs, at the two moments it needs them:
//
//  - `runtimeType`, the DECLARED type of the value, read at FOLD time so `.$v` types itself — and so the
//    members and methods called on it dispatch — WITHOUT awaiting anything. Folding happens wherever a
//    lambda is converted, a fluent builder call included, where there is no async boundary to await in.
//  - `resolvedValue`, stamped once the promise settles and read at BIND time, where the value becomes a
//    constant in the query. Missing then, the bind throws PromiseNotLoaded and the region around it awaits
//    this promise and binds again.
//
// Declaring a `runtimeType` IS the declaration that this promise may be read inside a query: one without
// it is refused rather than awaited, because a one-off promise (a fetch, an `async` call, a `.then` chain)
// is a different object on every fold and could never converge.
//
// `ResetLazy` is the only producer today (it stamps the promise it memoises while warm), but nothing here
// knows that: the LINQ provider reads these two fields and nothing else, so any other cache can offer the
// same contract — provided it hands back the SAME promise instance on the next fold, or the value stamped
// on the last one is never seen again.
//
// `.$v` itself stays strictly query-only: the accessor on Promise.prototype (see server/table.ts) always
// throws, and the query pipeline reads the fields below BY NAME without ever touching it.

/** The value's declared type, as a thunk: a `RuntimeType` graph names entity constructors, and a cache is
 *  declared at module level, so building it eagerly would invite import cycles. Called at most once per
 *  promise (memoised by `markStable`). */
export type RuntimeTypeThunk = () => RuntimeType;

export interface StablePromise<T> extends Promise<T> {
    /** Set by {@link markStable}: the declared type of the value, and the mark that says this promise is
     *  meant to be read by `.$v` inside a query. */
    readonly runtimeType?: RuntimeTypeThunk;
    /** The settled value, in a BOX so a legitimately-`undefined` value still counts as loaded. */
    readonly resolvedValue?: { readonly value: T };
}

/** Raised by the query pipeline when a `.$v` names a stable promise that has not settled yet. Carries the
 *  promise, so the enclosing region knows exactly what to await before binding again (see
 *  server/promiseResolution.ts). */
export class PromiseNotLoaded extends Error {
    constructor(readonly promise: Promise<unknown>) {
        super("A `.$v` in this query names a stable promise that has not loaded yet."
            + " It should have been awaited by the enclosing `withPromisesLoaded` region and bound again.");
        this.name = "PromiseNotLoaded";
    }
}

/**
 * Declare `promise` readable by `.$v` inside a query, typed by `runtimeType`, and stamp its value onto it
 * once it settles. Returns the same instance — the stamp is what makes it stable, not a wrapper.
 *
 * `resolved` may be passed when the value is already in hand, so the very next fold succeeds instead of
 * waiting a microtask for the `then` below.
 */
export function markStable<T>(promise: Promise<T>, runtimeType: RuntimeTypeThunk, resolved?: { value: T }): StablePromise<T> {
    const p = promise as { runtimeType?: RuntimeTypeThunk; resolvedValue?: { value: T } };
    if (resolved != null)
        p.resolvedValue = resolved;
    if (p.runtimeType != null)
        return promise as StablePromise<T>;
    // Memoised: the thunk builds a RuntimeType graph, and the binder asks for it on every fold.
    let type: { value: RuntimeType } | undefined;
    p.runtimeType = () => (type ??= { value: runtimeType() }).value;
    // A rejection leaves it unresolved: the region awaits the promise itself and surfaces the real error.
    // The handler is attached only to observe the value — it must not turn a rejection into an unhandled one.
    void promise.then(value => { p.resolvedValue = { value }; }, () => { });
    return promise as StablePromise<T>;
}

/** Whether `value` is a promise declared readable inside a query. */
export function isStablePromise(value: unknown): value is StablePromise<unknown> {
    return value instanceof Promise && (value as StablePromise<unknown>).runtimeType != null;
}

/** The declared type of a stable promise's value — what `.$v` types to before (and after) it loads. */
export function stableRuntimeType(promise: StablePromise<unknown>): RuntimeType {
    return promise.runtimeType!();
}

/**
 * The value a `.$v` folds to. Two outcomes:
 *  • loaded      → the value, which the binder folds into the query as a constant;
 *  • not loaded  → {@link PromiseNotLoaded}, for the enclosing region to await and bind again.
 *
 * A promise that is not stable never reaches here — {@link refuseUnstablePromise} refuses it at fold time,
 * where the offending expression is still in hand.
 */
export function stableValue(promise: StablePromise<unknown>): unknown {
    if (promise.resolvedValue == null)
        throw new PromiseNotLoaded(promise);
    return promise.resolvedValue.value;
}

/** The error for a `.$v` over a promise nobody declared query-readable. Its own function because both the
 *  folder and the binder can meet one, depending on where the promise was captured. */
export function refuseUnstablePromise(): never {
    throw new Error("`.$v` inside a query can only unwrap a STABLE promise — one whose cache declares a"
        + " `runtimeType` (a `ResetLazy`/`globalLazy` option). This promise declares none, so the query"
        + " could neither type it nor fold it to a constant. Declare the runtimeType, or await the value"
        + " before building the query.");
}

/**
 * Whether a `@quoted` body reads `.$v` anywhere. Because `.$v` only ever means something to the query
 * translator, a lambda that uses it CANNOT double as an in-memory predicate — so a registration that would
 * call it in memory (TypeConditionLogic.registerCompile) rejects it up front, at start-up, rather than
 * letting it throw later on whichever code path first evaluates it per entity.
 */
export function quotedReadsPromiseMarker(quoted: Function): boolean {
    const ex = (quoted as { __quoted?: () => unknown }).__quoted?.();
    return ex != null && readsMarker(ex);
}

// A QuotedEx node is an array whose first element tags the operator; a member access is
// `["." | "?.", <object>, "<name>"]`. Every other node's children are nested arrays, so a generic walk
// finds a `.$v` wherever it sits.
function readsMarker(node: unknown): boolean {
    if (!Array.isArray(node))
        return false;
    if ((node[0] === "." || node[0] === "?.") && node[2] === "$v")
        return true;
    return node.some(readsMarker);
}
