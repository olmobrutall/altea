import type { Quoted } from "quote-transformer/quoted";
import { memberPath } from "../data/accessedFields";
import { resolveMemberPathType } from "./linq/expressions";
import {
    installThenTyped, isQueryReadablePromise, markStable, refuseUntypedCache, type StablePromise,
} from "./stablePromise";

// `thenTyped` — project a STABLE promise onto one of its members and keep it stable.
//
// A cache hands out a promise of a whole row (`GlobalsLogic.configurationLazy.value()`), and a module wants
// one member of it. `.then(c => c.email)` is the obvious spelling and the wrong one: `then` mints a NEW
// promise on every call, so it is a different object each time, carries no declared type, and the query
// translator refuses it outright — "it would be a different object every time and could never converge".
//
// `thenTyped` is the same projection with the two things `.$v` needs, and nothing else:
//
//  - the DECLARED TYPE of the member, derived from the source's own `runtimeType` by walking the selector's
//    member path. No value is needed for this, which is the point: a query types `.$v` at FOLD time, long
//    before anything has loaded.
//  - STABILITY, by memoising per (source promise, member path). The source is memoised by its cache, so the
//    same source plus the same path hands back the same derived promise — which is exactly the contract
//    `.$v` checks. A different path off the same source is a different promise, as it should be.
//
// The selector is `Quoted`, so what arrives is a lambda the transformer has stamped with its own AST. That
// is what makes the member path READABLE without running anything; the function itself is still an ordinary
// function, and is called (once) to project a value that has already loaded.
//
// Accordingly the selector must be a plain member READ — `c => c.email`, `c => c.email.urlLeft`. A
// computation has no member path, so there is nothing to type it from.
//
// It is a member of `StablePromise` (installed per instance by `markStable`), not of `Promise.prototype`:
// deriving from a one-off could never converge, so a one-off simply does not offer it — a refusal the
// checker makes instead of the runtime. The body lives here rather than beside the interface because
// `resolveMemberPathType` is a linq thing and linq is built on server/stablePromise.

// Per source promise, the derived promise for each member path. A WeakMap so a cache that resets — and
// hands out a new promise next time — takes its derivations with it.
const derivations = new WeakMap<Promise<unknown>, Map<string, StablePromise<unknown>>>();

export function thenTyped<T, U>(source: StablePromise<T>, selector: Quoted<(value: T) => U>): StablePromise<U> {
    if (!isQueryReadablePromise(source))
        refuseUntypedCache();

    // Exactly one member path off the parameter, which is the whole contract: no path, no type. The
    // underlying reader speaks of index selectors, which is not what the caller wrote.
    let path: string;
    try {
        path = memberPath(selector as Quoted<(value: unknown) => unknown>);
    } catch {
        throw new Error("`thenTyped` takes a selector that reads ONE member path off its parameter"
            + " (`c => c.email`, `c => c.email.urlLeft`). This one reads something else — and a computation"
            + " has no member path, so there would be nothing to derive the type from. Project the member"
            + " here and compute from it where the value is used.");
    }

    let byPath = derivations.get(source);
    if (byPath == undefined)
        derivations.set(source, byPath = new Map());

    const already = byPath.get(path);
    if (already != undefined)
        return already as StablePromise<U>;

    const sourceRuntimeType = source.runtimeType!;
    // Stamp the projected value straight away when the source has already loaded, so the very next fold
    // succeeds instead of waiting a microtask — the same reason `ResetLazy` stamps its own.
    const loaded = source.resolvedValue;
    const derived = markStable(
        source.then(selector),
        () => resolveMemberPathType(sourceRuntimeType(), path),
        loaded == undefined ? undefined : { value: selector(loaded.value) });

    byPath.set(path, derived);
    return derived;
}

// Fills the slot `markStable` calls. Importing this module (server/table.ts does) is what turns the
// member on; nothing else may install it.
installThenTyped(thenTyped);
