// Database-level helpers that operate on already-materialised entities/lites (Signum's
// `Database` static). Distinct from the set-based bulk operations on `Query<T>`
// (executeUpdate/Delete/Insert) — these act per-row on an in-memory list, or fetch rows
// by id. The cache extension point (`./cache`) is consulted first, so a cached type is
// served from memory instead of the database.

import { Entity, PrimaryKey, Type, typeConstructor, typeName } from "../entities/entity";
import { Lite } from "../entities/lite";
import { getCacheController } from "./cache";
import { retrieveEntitiesByIds, table } from "./table";
import "../entities/globals"; // Array.prototype.contains (SQL-mappable in the delete filter)

// Chunk id lists to stay well under the database's max-parameters-per-statement (Signum's
// SchemaSettings.MaxNumberOfParameters). Kept conservative so both SQL Server (~2100) and
// Postgres are safe.
const MAX_IN_PARAMETERS = 1000;

// The runtime constructor behind a type reference (the ctor itself for a plain entity, the
// open class for a closed generic), as the query layer needs it.
function ctorOf<T extends Entity>(type: Type<T>): new () => T {
    return typeConstructor(type) as new () => T;
}

// Signum's Database.RetrieveList<T>(ids): the entities of `type` for `ids`, in the same
// order (duplicate ids repeat the same instance). A cached type is served from its
// controller; otherwise the ids are queried in chunks. Throws if any id is missing.
export async function retrieveList<T extends Entity>(type: Type<T>, ids: PrimaryKey[]): Promise<T[]> {
    if (ids.length === 0)
        return [];

    const distinct = [...new Set(ids)];
    const byId = new Map<PrimaryKey, T>();

    const ctor = ctorOf(type);
    const cc = await getCacheController(ctor);
    if (cc != null) {
        for (const id of distinct) {
            const e = cc.getEntity(id) as T | null;
            if (e != null)
                byId.set(id, e);
        }
    } else {
        for (let i = 0; i < distinct.length; i += MAX_IN_PARAMETERS) {
            const chunk = distinct.slice(i, i + MAX_IN_PARAMETERS);
            for (const e of await retrieveEntitiesByIds(ctor, chunk))
                byId.set(e.id, e);
        }
    }

    return ids.map(id => {
        const e = byId.get(id);
        if (e == null)
            throw new Error(`Entity '${typeName(type)}' with id ${id} not found.`);
        return e;
    });
}

// Signum's Database.Retrieve<T>(id): the single entity of `type` with `id` (from the cache
// controller when enabled, else the database). Throws if not found.
export async function retrieve<T extends Entity>(type: Type<T>, id: PrimaryKey): Promise<T> {
    return (await retrieveList(type, [id]))[0];
}

// Signum's Database.RetrieveFromListOfLite / RetrieveList(IEnumerable<Lite<T>>): materialise
// a list of lites as their entities, preserving order. The list MAY MIX concrete types
// (Lite<T> is covariant), so lites are grouped by type, each group retrieved with
// retrieveList, then reassembled by (type, id) in the original order.
export async function retrieveFromListOfLite<T extends Entity>(lites: Lite<T>[]): Promise<T[]> {
    if (lites.length === 0)
        return [];

    const idsByType = new Map<Type<T>, PrimaryKey[]>();
    for (const lite of lites) {
        const arr = idsByType.get(lite.entityType);
        if (arr != null)
            arr.push(lite.id);
        else
            idsByType.set(lite.entityType, [lite.id]);
    }

    const byType = new Map<Type<T>, Map<PrimaryKey, T>>();
    for (const [type, ids] of idsByType) {
        const list = await retrieveList(type, ids);
        const m = new Map<PrimaryKey, T>();
        for (const e of list)
            m.set(e.id, e);
        byType.set(type, m);
    }

    // Reassemble in the original order (duplicate lites map to the same instance).
    return lites.map(lite => byType.get(lite.entityType)!.get(lite.id)!);
}

// Signum's Database.DeleteList — delete a list of entities/lites one row at a time (as
// opposed to a set-based `Query<T>.executeDelete()`). Not implemented yet; defined here
// so the call shape is locked and callers compile.
export async function deleteList<T extends Entity>(list: (Lite<T> | T)[]): Promise<void> {
    if (list.length === 0)
        return;

    // Group by entity type, then delete each type's rows set-based (`id IN (…)`, chunked).
    // executeDelete emits any owned-child deletes before the parent. Mirrors Signum's
    // Database.DeleteList (which likewise batches by type rather than one round-trip per row).
    const idsByType = new Map<Type<T>, PrimaryKey[]>();
    for (const item of list) {
        const type = item instanceof Entity ? (item.constructor as Type<T>) : (item as Lite<T>).entityType;
        const id = item.id;
        if (id == null)
            throw new Error(`Cannot delete a ${typeName(type)} with no Id`);
        const arr = idsByType.get(type);
        if (arr != null) arr.push(id); else idsByType.set(type, [id]);
    }

    for (const [type, ids] of idsByType)
        await deleteRowsByIds(type, ids);
}

// Deletes the rows of ONE entity type by id, set-based and chunked (id IN (…), under the
// max-parameters cap). executeDelete cascades owned-child rows before the parent. Used by
// deleteList and by the Saver to remove collection orphans (children dropped from a collection).
export async function deleteRowsByIds<T extends Entity>(type: Type<T>, ids: PrimaryKey[]): Promise<void> {
    const ctor = ctorOf(type);
    for (let i = 0; i < ids.length; i += MAX_IN_PARAMETERS) {
        const chunk = ids.slice(i, i + MAX_IN_PARAMETERS);
        await table(ctor).filter(e => chunk.contains(e.id)).executeDelete();
    }
}
