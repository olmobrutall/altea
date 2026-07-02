// Cache extension point — the seam a cache module plugs into (Signum's
// `Schema.CacheController<T>()`).
//
// A `CacheController` owns one entity type's rows in memory. When one is registered and
// enabled it's consulted in two places, mirroring Signum:
//   - `Database.retrieve` / `retrieveList` call `getEntity(id)` instead of querying
//     (Signum's `Database.Retrieve` → GetCacheController);
//   - the query provider's `EntityCompleter` treats a cached type as non-expandable
//     (`isCachedType`, Signum's `EntityCompleter.IsCached`): its references stay id-only
//     stubs rather than being joined/expanded in the SQL, since the cache fills them.
//
// altea ships no controller by default, so both paths are inert until a module registers
// one via `registerCacheController`.

import type { Entity, PrimaryKey } from "../entities/entity";

export interface CacheController<T extends Entity = Entity> {
    // Whether the cache is currently serving this type (Signum's CacheController.Enabled).
    readonly enabled: boolean;
    // Ensure the type's rows are loaded into memory (Signum's CacheController.Load).
    load(): Promise<void>;
    // A single loaded entity by id, or null when the id isn't present.
    getEntity(id: PrimaryKey): T | null;
}

const controllers = new Map<new () => Entity, CacheController>();

// Register (or replace) the cache controller for an entity type. The one hook a cache
// module needs; everything else consults the controller through `getCacheController`.
export function registerCacheController<T extends Entity>(ctor: new () => T, controller: CacheController<T>): void {
    controllers.set(ctor, controller as unknown as CacheController);
}

export function unregisterCacheController(ctor: new () => Entity): void {
    controllers.delete(ctor);
}

// Signum's `Database.GetCacheController<T>()`: the enabled, loaded controller for `ctor`,
// or null when none is registered / it's disabled. Loads on demand before returning.
export async function getCacheController(ctor: new () => Entity): Promise<CacheController | null> {
    const cc = controllers.get(ctor);
    if (cc == null || !cc.enabled)
        return null;
    await cc.load();
    return cc;
}

// Signum's `EntityCompleter.IsCached(type)`: whether `ctor` has an enabled cache
// controller, in which case the query provider keeps its references as id-only stubs
// (the cache fills them) rather than expanding/joining them in SQL. Synchronous — the
// binder can't await; a cache module is expected to have loaded the type beforehand.
export function isCachedType(ctor: new () => Entity): boolean {
    const cc = controllers.get(ctor);
    return cc != null && cc.enabled;
}
