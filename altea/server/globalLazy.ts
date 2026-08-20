import type { Entity, Type } from "../data/entity";
import { ResetLazy } from "../data/resetLazy";
import { ExecutionMode } from "./executionMode";
import { Transaction } from "./connection/transaction";
import type { Schema } from "./schema/schema";
import type { SchemaBuilder } from "./schema/schemaBuilder";

// Port of Signum's `Signum.Engine/GlobalLazy.cs` (InvalidateWith + the GlobalLazy registry) and the
// `GlobalLazyManager` that lives at the bottom of SchemaBuilder.cs. Split out of schemaBuilder.ts so a
// module can swap the invalidation STRATEGY without importing the builder's world: altea-cache installs a
// manager that invalidates a global lazy from the cache's own invalidation events (which a broadcast from
// another process can also raise) instead of from this process's save/DML events.
//
// altea divergences:
//  - the lazy's factory is ASYNC (see ResetLazy), so `loadAll` returns a promise;
//  - the base manager's invalidation is EAGER (it resets as the write happens) where Signum defers to
//    `Transaction.PostRealCommit`. That is a deliberate, pre-existing altea choice: the factory reloads
//    from COMMITTED state (`Transaction.forceNew`), so a rolled-back write only costs a harmless extra
//    reload — and an eager reset can never leave a stale value behind if the commit hook is missed;
//  - Signum's `InvalidateWith.UseBaseImplementation` is ported (altea-cache honours it the same way).

// Signum's `InvalidateWith` struct: the entity types whose changes invalidate a global lazy.
export interface InvalidateWith {
    readonly invalidateWith: Type<Entity>[];
    // Force the BASE (event-driven) invalidation even when a cache manager is installed — Signum's
    // `InvalidateWith.UseBaseImplementation`, for a lazy that must not require its types to be cached.
    readonly useBaseImplementation?: boolean;
}

// Signum's GlobalLazyManager: the swappable invalidation strategy. `attachInvalidations` wires the reset
// to whatever signals the strategy trusts; `onLoad` runs inside the factory, BEFORE it reads (Signum's
// hook where the cache manager makes sure every dependency is loaded).
export class GlobalLazyManager {
    private used = false;

    // Signum's AsserNotUsed: once a lazy has been attached through this manager, swapping it out would
    // leave that lazy wired to the old strategy — so the swap must happen before any registration.
    assertNotUsed(): void {
        if (this.used)
            throw new Error("GlobalLazyManager has already been used: switchGlobalLazyManager must run before any globalLazy is registered.");
    }

    attachInvalidations(sb: SchemaBuilder, invalidateWith: InvalidateWith, invalidate: () => void): void {
        this.used = true;

        // Mirror Signum's SchemaBuilder.AttachInvalidations<T>: reset on save AND on every set-based DML
        // path — DELETE (Query.executeDelete → onPreUnsafeDelete), UPDATE, INSERT, and bulk-insert. Without
        // the delete hook, deleting a row via the operation/`Database.deleteList` path (which routes through
        // `executeDelete`, firing `preUnsafeDelete` only — never `saved`) would leave the cache stale until
        // the process restarts. altea divergences from Signum: (1) we hook `saved` (post-write, in-txn)
        // rather than Signum's graph-modified `Saving`; (2) the reset is EAGER (see the note above); (3) the
        // dependent-table fan-out (Signum's AttachInvalidationsDependant over `DependentTables()`) is not
        // ported — a cache that navigates to related types must list those types in `invalidateWith`.
        for (const t of invalidateWith.invalidateWith) {
            const ee = sb.schema.entityEvents(t);
            ee.saved.push(invalidate);
            ee.preUnsafeDelete.push(invalidate);
            ee.preUnsafeUpdate.push(invalidate);
            ee.preUnsafeInsert.push(invalidate);
            ee.preBulkInsert.push(invalidate);
        }
    }

    // Signum's GlobalLazyManager.OnLoad — a no-op in the base implementation.
    onLoad(_sb: SchemaBuilder, _invalidateWith: InvalidateWith): void | Promise<void> {
    }
}

// Signum's static `GlobalLazy` class: the registry of every global lazy, so the whole set can be reset
// (CacheLogic.invalidateAll) or reported on (the cache statistics panel).
export namespace GlobalLazy {
    const registered = new Set<ResetLazy<unknown>>();

    // Signum's GlobalLazy.WithoutInvalidations: a registered lazy whose factory runs in global execution
    // mode (authorization suppressed — a cache load reads the whole table) and in an INDEPENDENT
    // transaction, so the value always reflects committed state. NO invalidation is attached; the caller
    // (SchemaBuilder.globalLazy) does that through the manager.
    export function withoutInvalidations<T>(factory: () => Promise<T>, options?: { name?: string, schema?: Schema }): ResetLazy<T> {
        const lazy = new ResetLazy<T>(() => ExecutionMode.global(() =>
            // TEST-ONLY: `globalLazyReadUncommitted` nests the reload in the ambient (rolled-back)
            // transaction so a test sees its own uncommitted writes — Signum's `Transaction.InTestTransaction
            // ? null : Transaction.ForceNew()`.
            (options?.schema?.globalLazyReadUncommitted ? Transaction.create : Transaction.forceNew)(factory)));
        lazy.name = options?.name;
        registered.add(lazy as ResetLazy<unknown>);
        return lazy;
    }

    export function registeredLazies(): ResetLazy<unknown>[] {
        return [...registered];
    }

    // Signum's GlobalLazy.Statistics(), ordered by load time descending.
    export function statistics(): ResetLazy<unknown>[] {
        return [...registered].sort((a, b) => b.sumLoadTime - a.sumLoadTime);
    }

    // Signum's `GlobalLazy.OnResetAll` — CacheLogic subscribes so a "reset everything" also drops the
    // cached tables. `systemLog` mirrors Signum's flag (whether the reset is worth a SystemEventLog row).
    export const onResetAll: ((systemLog: boolean) => void)[] = [];

    export function resetAll(systemLog = true): void {
        for (const h of onResetAll)
            h(systemLog);
        for (const lazy of registered)
            lazy.reset();
    }

    export async function loadAll(): Promise<void> {
        for (const lazy of registered)
            await lazy.load();
    }
}
