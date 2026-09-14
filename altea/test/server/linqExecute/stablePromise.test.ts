import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { table, bindAndOptimize, bindOptimizeSecured } from "@altea/altea/server/table";
import { QueryFormatter } from "@altea/altea/server/linq/queryFormatter";
import { Expression } from "@altea/altea/server/linq/expressions";
import { SchemaBuilder } from "@altea/altea/server/schema";
import { Connector } from "@altea/altea/server/connection/connector";
import { ResetLazy } from "@altea/altea/server/resetLazy";
import { isQueryReadablePromise, isStablePromise, markStable, PromiseNotLoaded, stableValue } from "@altea/altea/server/stablePromise";
import { withPromisesLoaded } from "@altea/altea/server/promiseResolution";
import { ArrayType, LiteralType } from "@altea/altea/server/runtimeTypes";
import type { Quoted } from "quote-transformer/quoted";
import { MusicLogic } from "../MusicLogic";
import { seedTypeCachesForTest } from "../seedTypeCaches";
import { AlbumEntity } from "../../data/music";
import type { PrimaryKey } from "@altea/altea/data/entity";

// `.$v` over a CACHE, resolved on demand — the query half of stable promises (see server/stablePromise.ts).
//
// A query lambda is CONSTANT-FOLDED wherever it is written, and a parameter-free subtree is folded by
// RUNNING it, so `vipCustomers().$v` meets a real Promise during translation. The folder cannot await one
// (a fluent builder call has no async boundary around it), so it types the read from the cache's DECLARED
// runtimeType and leaves a placeholder; the BINDER folds the loaded value in, or throws PromiseNotLoaded
// for the enclosing region to await and bind again.
//
// Everything here runs OFFLINE: binding reads the schema and never executes SQL, so the caches are plain
// `ResetLazy`es over literal values rather than queries. The DB-backed twin of the last group is the
// altea-auth type-condition suite.

// A connector that returns canned rows instead of hitting a database, so binding has a schema context.
class FakeConnector extends Connector {
    constructor(schema: any, public rows: unknown[] = [], isPostgres = false) { super(schema, isPostgres, 128); }
    override executeQuery(): Promise<unknown[]> { return Promise.resolve(this.rows); }
    openConnection(): Promise<any> { throw new Error("not used"); }
    closeConnection(): Promise<void> { return Promise.resolve(); }
    cleanDatabase(): Promise<void> { return Promise.resolve(); }
}

const sb = new SchemaBuilder();
sb.settings.isPostgres = false;
MusicLogic.start(sb);
sb.complete();
seedTypeCachesForTest(sb.schema);
const fake = new FakeConnector(sb.schema, [], false);

function sqlOf(query: { expression: any }): string {
    const proj = Connector.withConnector(fake, () => bindAndOptimize(query.expression, sb.schema, false));
    return QueryFormatter.format(proj.select, false).sql;
}

// A `Quoted<>` parameter is what makes the transformer quote a lambda; this is the smallest thing that has
// one, so a test can hand the binder a quoted predicate the way a type condition does.
function asQuoted<T>(q: Quoted<(e: T) => boolean>): Quoted<(e: T) => boolean> { return q; }

const numberArray = () => new ArrayType(LiteralType.number);

/** A cache of ids, declared query-readable. `settle` resolves it, so a test can hold it COLD. */
function coldCache(values: PrimaryKey[]): { lazy: ResetLazy<PrimaryKey[]>, settle: () => void, loads: () => number } {
    let release!: () => void;
    let loads = 0;
    const gate = new Promise<void>(res => { release = res; });
    const lazy = new ResetLazy<PrimaryKey[]>(async () => { loads++; await gate; return values; }, numberArray);
    return { lazy, settle: release, loads: () => loads };
}

describe("stable promises — the mechanism", () => {

    // The identity contract: while the value is warm, `value()` hands back the SAME promise, carrying the
    // value. A fresh `Promise.resolve` per call would be a different object on every translation, and the
    // value stamped on the last one would never be seen again.
    test("a cache declaring a runtimeType is stable, and the same promise while warm", async () => {
        const lazy = new ResetLazy<number[]>(async () => [1, 2], numberArray);

        const first = lazy.value();
        assert.ok(isStablePromise(first));
        await first;

        assert.equal(lazy.value(), lazy.value(), "the warm promise is memoised");
        assert.deepEqual(stableValue(lazy.value() as any), [1, 2]);

        lazy.reset();
        assert.notEqual(lazy.value(), first, "reset mints a new one — the old value is not handed out again");
    });

    // STABLE and QUERY-READABLE are different. Every ResetLazy is stable — memoised, carrying its value —
    // which is what lets synchronous engine code inside a region demand it. Reading it from inside a QUERY
    // is opt-in on top of that: without a declared runtimeType there is no way to type the read.
    test("a cache with no runtimeType is stable, but not query-readable", async () => {
        const lazy = new ResetLazy<number[]>(async () => [1, 2]);

        const p = lazy.value();
        await p;

        assert.equal(isStablePromise(p), true, "a region may demand it");
        assert.equal(p, lazy.value(), "memoised, so the same instance comes back");
        assert.deepEqual(stableValue(p as any), [1, 2]);
        assert.equal(isQueryReadablePromise(p), false, "but a query cannot type it");
    });

    // …and a query says exactly that, rather than the one-off-promise refusal.
    test("a query over an untyped cache asks for its runtimeType", async () => {
        const lazy = new ResetLazy<PrimaryKey[]>(async () => [1 as unknown as PrimaryKey]);
        const ids = () => lazy.value();
        await lazy.value();

        await assert.rejects(
            async () => withPromisesLoaded(() => sqlOf(table(AlbumEntity).filter(a => ids().$v.includes(a.id)))),
            (e: Error) => /needs the cache's `runtimeType`/.test(e.message));
    });

    // The value lives in a BOX, so a cache that legitimately resolves to `undefined` is loaded rather than
    // looking unloaded forever.
    test("a stable promise resolving to undefined counts as loaded", async () => {
        const p = markStable(Promise.resolve(undefined), () => LiteralType.null);

        assert.equal(await withPromisesLoaded(() => stableValue(p)), undefined);
    });

    // Outside a region the throw is the caller's to see, and it NAMES the promise it needs — that is what
    // lets the region await exactly the one thing that is missing.
    test("an unloaded read outside a region throws PromiseNotLoaded, naming the promise", () => {
        const p = markStable(new Promise<number>(() => { }), () => LiteralType.number);

        let caught: unknown;
        try { stableValue(p); } catch (e) { caught = e; }

        assert.ok(caught instanceof PromiseNotLoaded);
        assert.equal(caught.promise, p);
    });

    // Two unloaded caches in one region: it awaits one per attempt, so the body runs three times. Proves
    // the loop keeps going rather than loading only the first.
    test("several unloaded caches in one region each load", async () => {
        const a = markStable(new Promise<number>(res => setTimeout(() => res(1), 1)), () => LiteralType.number);
        const b = markStable(new Promise<number>(res => setTimeout(() => res(2), 1)), () => LiteralType.number);
        let runs = 0;

        const sum = await withPromisesLoaded(() => {
            runs++;
            return (stableValue(a) as number) + (stableValue(b) as number);
        });

        assert.equal(sum, 3);
        assert.equal(runs, 3);
    });

    // The steady path: once loaded, a cache carries its value for every later region, which then runs once.
    test("an already-loaded cache runs the region once", async () => {
        const p = markStable(Promise.resolve(7), () => LiteralType.number);
        await withPromisesLoaded(() => stableValue(p));
        let runs = 0;

        const value = await withPromisesLoaded(() => { runs++; return stableValue(p); });

        assert.equal(value, 7);
        assert.equal(runs, 1);
    });

    // A load that fails surfaces the FACTORY's own error, not a translation failure: the region awaits the
    // very promise it was told about, so the rejection propagates with its original message.
    test("a failing cache load surfaces its own error", async () => {
        const lazy = new ResetLazy<number[]>(async () => { throw new Error("the table is not there"); }, numberArray);

        await assert.rejects(
            () => withPromisesLoaded(() => stableValue(lazy.value() as any)),
            (e: Error) => /the table is not there/.test(e.message));
    });

    // A cache whose own factory reads it is a real cycle. It must REPORT — without the guard it DEADLOCKS,
    // because the factory ends up awaiting the very load it is running inside.
    test("a cache read by its own factory reports the cycle instead of deadlocking", async () => {
        // eslint-disable-next-line prefer-const
        let lazy: ResetLazy<number[]>;
        lazy = new ResetLazy<number[]>(
            async () => { await withPromisesLoaded(() => stableValue(lazy.value() as any)); return [1]; },
            numberArray);

        await assert.rejects(
            () => withPromisesLoaded(() => stableValue(lazy.value() as any)),
            (e: Error) => /a query issued by its own factory reads it/.test(e.message));
    });

    // `.$v` is query-only, without exception: evaluating it in memory is an error in EVERY context —
    // inside a region included, and for a promise that region has already loaded. Only the query pipeline
    // resolves it, and it does so by NAME, never by touching the accessor.
    test(".$v evaluated in memory always throws, even inside a region", async () => {
        const p = markStable(Promise.resolve(1), () => LiteralType.number);
        const inMemory = (): Error | undefined => { try { (p as any).$v; return undefined; } catch (e) { return e as Error; } };

        assert.match(inMemory()!.message, /query-only marker and cannot be evaluated in memory/);
        await withPromisesLoaded(() => stableValue(p));
        assert.match(inMemory()!.message, /query-only marker and cannot be evaluated in memory/);
    });
});

describe("stable promises — in a query", () => {

    // The headline case, and the proof that a folded cache is EXACTLY a captured constant: same SQL, down
    // to the `IN (…)`. Cold at build time — building must not wait for anything — and folded at bind.
    test("a cold cache in a builder lambda is folded when the query binds", async () => {
        const { lazy, settle, loads } = coldCache([1, 2, 3]);
        const ids = () => lazy.value();

        const query = table(AlbumEntity).filter(a => ids().$v.includes(a.id));
        assert.equal(lazy.isValueCreated, false, "building must not wait for the cache");
        assert.equal(loads(), 1, "though it does start the load");

        let binds = 0;
        settle();
        const sql = await withPromisesLoaded(() => { binds++; return sqlOf(query); });

        assert.equal(binds, 2, "one attempt that found it cold, one that folded it");
        const captured: PrimaryKey[] = [1, 2, 3];
        assert.equal(sql, sqlOf(table(AlbumEntity).filter(a => captured.includes(a.id))));
    });

    // Warm is the same path — the binder still folds, it just never has to ask for a load.
    test("a warm cache binds in a single attempt", async () => {
        const { lazy, settle } = coldCache([1, 2, 3]);
        const ids = () => lazy.value();
        settle();
        await lazy.value();

        let binds = 0;
        const sql = await withPromisesLoaded(() => { binds++; return sqlOf(table(AlbumEntity).filter(a => ids().$v.includes(a.id))); });

        assert.equal(binds, 1);
        const captured: PrimaryKey[] = [1, 2, 3];
        assert.equal(sql, sqlOf(table(AlbumEntity).filter(a => captured.includes(a.id))));
    });

    // What the DECLARED type buys: an EMPTY cache still reads as an array. Typing it from the value would
    // see `[]` and get the element type wrong, and the members called on it dispatch at FOLD time — before
    // any value exists at all.
    test("an empty cache binds as an array, because the type came from the declaration", async () => {
        const { lazy, settle } = coldCache([]);
        const ids = () => lazy.value();
        settle();

        const sql = await withPromisesLoaded(() => sqlOf(table(AlbumEntity).filter(a => ids().$v.includes(a.id))));

        const captured: PrimaryKey[] = [];
        assert.equal(sql, sqlOf(table(AlbumEntity).filter(a => captured.includes(a.id))));
    });

    // The case the mechanism exists for: a ROW FILTER — the shape a type condition registers — whose
    // predicate reads a cache. Its lambda is converted INSIDE the binder (applyQueryFilters, when the table
    // source is discovered), so the placeholder is created deep in the recursion and still resolved by the
    // enclosing region. No pass scheduled before binding could have seen it.
    test("a cache read by a row filter is loaded mid-bind", async () => {
        const { lazy, settle } = coldCache([1, 2]);
        const ids = () => lazy.value();
        const predicate = asQuoted<AlbumEntity>(a => ids().$v.includes(a.id));

        const hooks = sb.schema.entityEvents(AlbumEntity).queryFilter;
        hooks.push(({ elementType }) => Expression.fromQuotedLambda(predicate as never, [elementType]));
        try {
            settle();
            const sql = await withPromisesLoaded(() => sqlOf(table(AlbumEntity)));

            assert.match(sql, /in\s*\(/i, "the cache folded into the filter the binder synthesised");
        } finally {
            hooks.pop();
        }
    });

    // The production entry point opens the region itself: a caller that goes through the LINQ provider
    // needs no region of its own, and nothing has to be warmed before the query runs.
    test("bindOptimizeSecured loads the cache without an explicit region", async () => {
        const { lazy, settle } = coldCache([1, 2, 3]);
        const ids = () => lazy.value();
        const query = table(AlbumEntity).filter(a => ids().$v.includes(a.id));
        settle();

        const proj = await Connector.withConnector(fake, () => bindOptimizeSecured(query.expression, sb.schema, false));

        assert.ok(lazy.isValueCreated, "the bind loaded it on demand");
        assert.match(QueryFormatter.format(proj.select, false).sql, /in\s*\(/i);
    });

    // A one-off promise is REFUSED, not retried: it is a different object on every conversion, so awaiting
    // it could never converge. Said once, where the expression is still in hand, rather than after a run of
    // attempts that could not have helped.
    test("a promise no cache declared is refused, not awaited", async () => {
        const perCall = async (): Promise<PrimaryKey[]> => [1, 2, 3];

        await assert.rejects(
            async () => withPromisesLoaded(() => sqlOf(table(AlbumEntity).filter(a => perCall().$v.includes(a.id)))),
            (e: Error) => /can only unwrap a STABLE promise/.test(e.message));
    });

    // `Promise.resolve(x)` is the DUAL of `.$v` — it wraps T → Promise<T> for the type checker and binds as
    // the identity, which is what lets a `@quoted` twin of an ASYNC method keep the method's signature.
    // Reading `$v` off the non-promise it folds to would silently yield `undefined`.
    test("Promise.resolve(x).$v is the identity", () => {
        const wrapped = sqlOf(table(AlbumEntity).filter(a => Promise.resolve(a.year).$v < 1995));

        assert.equal(wrapped, sqlOf(table(AlbumEntity).filter(a => a.year < 1995)));
    });
});
