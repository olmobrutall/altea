// Database-level helpers that operate on already-materialised entities/lites (Signum's
// `Database` static). Distinct from the set-based bulk operations on `Query<T>`
// (executeUpdate/Delete/Insert) — these act per-row on an in-memory list, or fetch rows
// by id. The cache extension point (`./cache`) is consulted first, so a cached type is
// served from memory instead of the database.

import { Entity, type PrimaryKey, type Type } from "../data/entity";
import { Lite, LiteImp } from "../data/lite";
import { getCacheController } from "./cache";
import { EntityNotFoundException } from "./exceptions";
import { retrieveEntitiesByIds, retrieveEntitiesFromCache, table } from "./table";
import { HeavyProfiler } from "./profiler/heavyProfiler";
import "../data/globals"; // Array.prototype.contains (SQL-mappable in the delete filter)

// Chunk id lists to stay well under the database's max-parameters-per-statement (Signum's
// SchemaSettings.MaxNumberOfParameters). Kept conservative so both SQL Server (~2100) and
// Postgres are safe.
const MAX_IN_PARAMETERS = 1000;

// Signum's Database.RetrieveList<T>(ids): the entities of `type` for `ids`, in the same
// order (duplicate ids repeat the same instance). A cached type is served from its
// controller; otherwise the ids are queried in chunks. Throws if any id is missing.
export async function retrieveList<T extends Entity>(type: Type<T>, ids: PrimaryKey[]): Promise<T[]> {
    if (ids.length === 0)
        return [];

    // Profiler span (Signum's Database.cs "DBRetrieve"); the "DBQuery"/"SQL" spans hang under it.
    using _prof = HeavyProfiler.log("DBRetrieve", () => type.name);

    const distinct = [...new Set(ids)];
    const byId = new Map<PrimaryKey, T>();

    const cc = await getCacheController(type);
    if (cc != null) {
        // Served from memory (Signum's Database.Retrieve under a cache controller). The materialisation
        // itself lives in table.ts — see retrieveEntitiesFromCache for what it guarantees and why it is there.
        for (const e of await retrieveEntitiesFromCache(type, distinct, cc))
            byId.set(e.id, e);
    } else {
        for (let i = 0; i < distinct.length; i += MAX_IN_PARAMETERS) {
            const chunk = distinct.slice(i, i + MAX_IN_PARAMETERS);
            for (const e of await retrieveEntitiesByIds(type, chunk))
                byId.set(e.id, e);
        }
    }

    return ids.map(id => {
        const e = byId.get(id);
        if (e == null)
            throw new EntityNotFoundException(type as Type<Entity>, [id]);
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

/**
 * "May the current user read this TYPE at all?" — the flat, conditionless half of the type-READ rule,
 * as a gate that THROWS to deny (the idiom `postRetrieveGates` already uses). The authorization module
 * fills it; with none installed — a terminal, a test — everything is readable, as everywhere else in core.
 *
 * It exists because a PROJECTION is gated by neither of the two mechanisms that cover everything else:
 * row-level conditions ride on every query through EntityEvents.queryFilter, and the retrieve path has
 * `Retriever.postRetrieveGates`, but `map(e => e.toLite())` reads a row without materialising an entity,
 * so it passes neither. That is FINE inside a query the caller was already allowed to run — which is what
 * the retriever's own nameless-lite completion is — and it is NOT fine at an entry point that names
 * whatever lites the caller hands it.
 */
export const readTypeGates: ((type: Type<Entity>) => void | Promise<void>)[] = [];

async function isReadable<T extends Entity>(type: Type<T>): Promise<boolean> {
    for (const gate of readTypeGates) {
        try {
            await gate(type as unknown as Type<Entity>);
        } catch {
            return false;
        }
    }
    return true;
}

// The lookup, BY INDEX: null for a lite nothing named. Separate from the fill below because a caller
// that has to REPORT the outcome — the route, answering a client that asked about lites it cannot see —
// wants the answer itself, not a mutation to compare against.
export async function toStrings<T extends Entity>(lites: Lite<T>[]): Promise<(string | null)[]> {
    if (lites.length === 0)
        return [];

    const byType = new Map<Type<T>, Lite<T>[]>();
    for (const lite of lites) {
        const arr = byType.get(lite.entityType);
        if (arr != null)
            arr.push(lite);
        else
            byType.set(lite.entityType, [lite]);
    }

    const names = new Map<Lite<T>, string>();

    for (const [type, group] of byType) {
        // A type this user may not read yields nothing, and its lites keep their "<NiceName> <id>"
        // fallback — the same answer as a row that is gone. Deliberately not an error: this endpoint is
        // asked about lites the caller merely HAS (a url it was sent, a list it pasted), so a type it
        // cannot read is an ordinary outcome, and one shared answer tells an attacker nothing.
        if (!await isReadable(type))
            continue;

        // A captured const, not an expression: the ids reach the SQL as a parameter list.
        const ids = group.map(l => l.id).distinctBy(id => String(id));
        const named = await table(type).filter(e => ids.includes(e.id)).map(e => e.toLite()).toArray();

        const byId = new Map(named.map(n => [String(n.id), n.toString()]));
        for (const lite of group) {
            const toStr = byId.get(String(lite.id));
            if (toStr != null)
                names.set(lite, toStr);
        }
    }

    return lites.map(l => names.get(l) ?? null);
}

// Signum's Database.FillLiteModels: stamp each lite's DISPLAY STRING, one query per type. A lite that
// reached the server or the client from OUTSIDE a query — parsed from a url filter, read out of a stored
// user asset, pasted as a key — carries an id and a type and nothing else, so it renders as LiteImp's
// last-resort "<NiceName> <id>" until something names it.
//
// Deliberately a lite PROJECTION, never a retrieve: `map(e => e.toLite())` selects the row's `to_str`
// (or its lowered @quoted toString()) alone — the same query the retriever's nameless-lite completion
// runs (Retriever.liteListImpl) — so no Retrieved handler fires and no unasked-for reference is dragged
// in.
//
// Lites are mutated IN PLACE (Signum's `FillLiteModels` does the same), so a caller holding the filter
// value or the pasted list sees the names appear without rebuilding anything.
export async function fillToStrings<T extends Entity>(lites: Lite<T>[]): Promise<void> {
    const names = await toStrings(lites);
    lites.forEach((lite, i) => {
        const toStr = names[i];
        if (toStr != null && lite instanceof LiteImp)
            lite.setToStr(toStr);
    });
}

// Signum's Database.DeleteList — delete a list of entities/lites one row at a time (as
// opposed to a set-based `Query<T>.executeDelete()`). Not implemented yet; defined here
// so the call shape is locked and callers compile.
export async function deleteList<T extends Entity>(list: (Lite<T> | T)[]): Promise<void> {
    if (list.length === 0)
        return;

    using _prof = HeavyProfiler.log("DBDelete", () => (list[0] instanceof Entity ? list[0].constructor.name : (list[0] as Lite<T>).entityType.name));

    // Group by entity type, then delete each type's rows set-based (`id IN (…)`, chunked).
    // executeDelete emits any owned-child deletes before the parent. Mirrors Signum's
    // Database.DeleteList (which likewise batches by type rather than one round-trip per row).
    const idsByType = new Map<Type<T>, PrimaryKey[]>();
    for (const item of list) {
        const type = item instanceof Entity ? (item.constructor as Type<T>) : (item as Lite<T>).entityType;
        const id = item.id;
        if (id == null)
            throw new Error(`Cannot delete a ${type.name} with no Id`);
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
    for (let i = 0; i < ids.length; i += MAX_IN_PARAMETERS) {
        const chunk = ids.slice(i, i + MAX_IN_PARAMETERS);
        await table(type).filter(e => chunk.includes(e.id)).executeDelete();
    }
}
