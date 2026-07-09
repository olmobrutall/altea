import { Entity } from '../entities/entity';
import type { Type, PrimaryKey } from '../entities/entity';
import { forEachField, cleanModified } from '../entities/changes';
import { collectAssignments } from './save';
import { wireOwnedChildren } from './saver';
import { Connector } from './connection/connector';
import { Transaction } from './connection/transaction';
import { table as queryTable } from './table';

// Port of Signum's BulkInserter (Engine/BulkInserter.cs). The bulk transport is a connector
// primitive (Connector.bulkInsert → SqlBulkCopy on SQL Server, COPY FROM STDIN on Postgres) —
// nothing to do with the graph Saver; BulkInserter only builds the rows and calls it.
//
// A bulk copy does NOT return generated ids (neither SqlBulkCopy nor COPY do), which is why —
// exactly like Signum's BulkInsertQueryIds — inserting a full entity with collections has to
// query the just-inserted rows back and match them to the in-memory entities by a caller-
// supplied UNIQUE KEY, learning the generated ids before the collection rows (which carry the
// owner's id as a back-reference FK) can be inserted.
//
//   - bulkInsertTable(entities): one table only, via the connector. Identity PKs are left to
//     the database (omitted from the copy, not read back); a non-identity PK (uuid/enum) is
//     copied as-is. No collections.
//   - bulkInsert(entities, keySelector): the whole entity. Bulk-copy the main rows, query the
//     new rows back and assign ids by `keySelector` (a plain in-memory function returning a
//     unique scalar or tuple), then wire and bulk-copy each collection (one level, as Signum).

export namespace BulkInserter {
    // Bulk-inserts the rows of a single table (no collections). For an identity table the
    // generated ids are NOT retrieved (use bulkInsert with a key selector when you need them).
    export function bulkInsertTable<T extends Entity>(entities: T[]): Promise<number> {
        return Transaction.create(async () => {
            assertAllNew(entities);
            if (entities.length === 0) return 0;
            await bulkCopyOneTable(entities);
            for (const e of entities) {
                if (e.id != null) e.isNew = false; // known-id (non-identity) rows are now saved
                cleanModified(e);
            }
            return entities.length;
        });
    }

    // Bulk-inserts entities and their collection children. `keySelector` must return a value
    // unique per entity (used to match the queried-back rows to the in-memory entities on an
    // identity table). Ignored for a non-identity table, whose ids are already known.
    export function bulkInsert<T extends Entity>(entities: T[], keySelector: (e: T) => unknown): Promise<number> {
        return Transaction.create(() => bulkInsertGraph(entities, keySelector));
    }
}

async function bulkInsertGraph<T extends Entity>(entities: T[], keySelector: (e: T) => unknown): Promise<number> {
    assertAllNew(entities);
    if (entities.length === 0) return 0;

    const connector = Connector.current();
    const ctor = entities[0].constructor as new () => T;
    const table = connector.schema.table(ctor as unknown as Type<Entity>);

    // "generated" = the database assigns the PK (entities came in id-less). Query-back only
    // makes sense then, and only for a numeric identity PK (id > maxBefore isolates the new
    // rows); a DB-defaulted UUID can't be matched that way, so require its id up front.
    const generated = entities[0].id == null;
    if (generated && !table.primaryKey.column.identity)
        throw new Error(
            `bulkInsert of ${ctor.name}: database-generated non-identity keys (e.g. UUID) are not supported; assign ids before bulk-inserting.`);

    // The largest existing id, so the post-copy query only reads back the rows we just added.
    const maxBefore = generated ? ((await queryTable(ctor).max(a => a.id as number)) ?? 0) : 0;

    await bulkCopyOneTable(entities);

    if (generated)
        await assignIdsByKey(entities, ctor, keySelector, maxBefore);

    for (const e of entities)
        e.isNew = false;

    // Collections: now that the owners carry ids, wire each child (back-reference FK to the
    // owner + row order) and bulk-copy them grouped by child table. One level, like Signum's
    // BulkInsertMLists — a child's own id is never needed, so it is not queried back.
    for (const e of entities)
        wireOwnedChildren(e);

    const childrenByType = new Map<Function, Entity[]>();
    for (const e of entities)
        forEachField(e, (fi, value) => {
            if (!fi.array || !Array.isArray(value)) return;
            for (const child of value)
                if (child instanceof Entity) {
                    let group = childrenByType.get(child.constructor);
                    if (group == null) { group = []; childrenByType.set(child.constructor, group); }
                    group.push(child);
                }
        });

    for (const group of childrenByType.values()) {
        await bulkCopyOneTable(group);
        for (const c of group) {
            c.isNew = false;
            cleanModified(c);
        }
    }

    for (const e of entities)
        cleanModified(e);

    return entities.length;
}

// Queries the rows inserted by this bulk copy (id > maxBefore) and assigns each entity its
// generated id by matching `keySelector`, run in memory on both the queried rows and the
// entities — so the selector needs no query translation, just to be derived from persisted
// columns. Signum's BulkInsertQueryIds.
async function assignIdsByKey<T extends Entity>(
    entities: T[], ctor: new () => T, keySelector: (e: T) => unknown, maxBefore: number,
): Promise<void> {
    const inserted = await queryTable(ctor).filter(a => (a.id as number) > maxBefore).toArray() as T[];

    const byKey = new Map<string, PrimaryKey>();
    for (const row of inserted)
        byKey.set(JSON.stringify(keySelector(row)), row.id);

    for (const e of entities) {
        const key = JSON.stringify(keySelector(e));
        const id = byKey.get(key);
        if (id == null)
            throw new Error(`bulkInsert: no inserted ${ctor.name} row matched the key ${key}. The key selector must be unique.`);
        e.id = id;
    }
}

// Builds the column list + row values for one table and hands them to the connector's bulk
// primitive. Identity PKs are DB-generated (omitted); a non-identity PK is provided by the
// entity. Row values come from collectAssignments (already dialect-normalised).
async function bulkCopyOneTable(entities: Entity[]): Promise<void> {
    if (entities.length === 0) return;
    const connector = Connector.current();
    const table = connector.schema.table(entities[0].constructor as Type<Entity>);
    // Include the PK column only when the entity carries it (a client/UUID key); a DB-generated
    // identity PK is left out so the database assigns it.
    const includePk = entities[0].id != null;

    const assignments = entities.map(e => collectAssignments(table, e));
    const columns = assignments[0].map(a => a.column);
    const rows = assignments.map(assign => assign.map(a => a.value) as unknown[]);
    if (includePk) {
        columns.unshift(table.primaryKey.column);
        entities.forEach((e, i) => rows[i].unshift(e.id));
    }

    await connector.bulkInsert(connector.sqlBuilder.objectName(table.name), columns, rows);
}

function assertAllNew(entities: Entity[]): void {
    for (const e of entities)
        if (!e.isNew)
            throw new Error(
                `bulkInsert requires new entities; ${e.constructor.name} (id ${String(e.id)}) is not new.`);
}
