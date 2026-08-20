// Cache extension point — the seam a cache module plugs into (Signum's `ICacheController<T>` +
// `Schema.CacheController<T>()`).
//
// A `CacheController` owns one entity type's rows in memory. When one is registered and enabled it's
// consulted wherever the engine would otherwise read those rows, mirroring Signum:
//   - `Database.retrieve` / `retrieveList` materialise the entity from the cached row instead of querying
//     (Signum's `Database.Retrieve` → GetCacheController);
//   - the query provider's `EntityCompleter` treats a cached type as non-expandable (`isCachedType`,
//     Signum's `EntityCompleter.IsCached`): its references stay id-only stubs rather than being
//     joined/expanded in the SQL, since the cache fills them;
//   - the `Retriever`, draining those stubs, calls `complete(entity, retriever)` per row instead of issuing
//     the `WHERE id IN (…)` batch (Signum's RealRetriever.Complete).
//
// altea ships no controller by default, so every path is inert until a module registers one via
// `registerCacheController`.
//
// altea divergences from Signum's ICacheController:
//  - `load()` is ASYNC (altea has no synchronous database API), so callers that can await go through
//    `getCacheController`; `isCachedType` / `isLoaded` are the sync probes the binder uses.
//  - no `getLiteModel(id, modelType, retriever)`: altea has no separate lite-model entity — a lite carries
//    its display string (and any custom-lite fields) directly, built from the entity by the registered
//    `fromEntity` lambda — so a cached lite is just "materialise the row, then `toLite()`", and Signum's
//    `ICachedLiteModelConstructor` / `LiteModelExpressionVisitor` / `ToStringExpressionVisitor` machinery
//    has no analogue here.
//  - `requestByBackReference` takes the child's FK field NAME (altea has no MList table: a `@part`
//    collection is child rows in the child's own table, i.e. always Signum's VirtualMList shape).

import type { Entity, PrimaryKey, Type } from "../data/entity";
import type { Lite } from "../data/lite";
import type { Retriever } from "./linq/Retriever";

// The retriever the completion path threads through. `import type` only, so this module — which the
// binder and Database import — stays free of a runtime dependency on the LINQ layer (Retriever.ts
// imports THIS file).
export type CacheRetriever = Retriever;

export interface CacheController<T extends Entity = Entity> {
    // Whether the cache is currently serving this type (Signum's CacheController.Enabled).
    readonly enabled: boolean;
    // Ensure the type's rows are loaded into memory (Signum's CacheController.Load).
    load(): Promise<void>;
    // Whether the rows are already in memory, so the SYNC members below can answer.
    readonly isLoaded: boolean;
    // Fill an ALREADY-CREATED instance (the Retriever's id-only stub, or a fresh instance from
    // Database.retrieve) from the cached row — Signum's `ICacheController.Complete(entity, retriever)`.
    // Nested references are stubbed/lited through the retriever, so the caller must `completeAll()`
    // afterwards. Throws if the id isn't cached.
    complete(entity: T, retriever: CacheRetriever): void;
    // Signum's Exists / GetAllIds.
    exists(id: PrimaryKey): boolean;
    getAllIds(): PrimaryKey[];
    // The cached lite (Signum's GetLiteModel / TryGetLiteModel, collapsed — see the note above): the row
    // materialised and reduced through the type's registered `toLite`. Null when the id isn't cached.
    tryGetLite(id: PrimaryKey, retriever: CacheRetriever): Lite<T> | null;
    // Signum's `RequestByBackReference`: the cached rows whose back-reference column points at `ownerId` —
    // how a `@part` collection is served from memory. `backReferenceField` is the child's FK field NAME.
    requestByBackReference(backReferenceField: string, ownerId: PrimaryKey, retriever: CacheRetriever): T[];
}

const controllers = new Map<Type<Entity>, CacheController>();

// Register (or replace) the cache controller for an entity type. The one hook a cache module needs;
// everything else consults the controller through `getCacheController` / `tryGetController`.
export function registerCacheController<T extends Entity>(ctor: Type<T>, controller: CacheController<T>): void {
    controllers.set(ctor, controller as unknown as CacheController);
}

export function unregisterCacheController(ctor: Type<Entity>): void {
    controllers.delete(ctor);
}

// The registered controller regardless of `enabled` — for a cache module reaching its own siblings.
export function tryGetCacheController(ctor: Type<Entity>): CacheController | undefined {
    return controllers.get(ctor);
}

// Signum's `Database.GetCacheController<T>()`: the enabled, loaded controller for `ctor`, or null when
// none is registered / it's disabled. Loads on demand before returning.
export async function getCacheController(ctor: Type<Entity>): Promise<CacheController | null> {
    const cc = controllers.get(ctor);
    if (cc == null || !cc.enabled)
        return null;
    await cc.load();
    return cc;
}

// Signum's `EntityCompleter.IsCached(type)`: whether `ctor` has an enabled cache controller, in which case
// the query provider keeps its references as id-only stubs (the cache fills them) rather than
// expanding/joining them in SQL. Synchronous — the binder can't await; a cache module is expected to have
// loaded the type beforehand (the Retriever's completion is async and loads on demand anyway).
export function isCachedType(ctor: Type<Entity>): boolean {
    const cc = controllers.get(ctor);
    return cc != null && cc.enabled;
}
