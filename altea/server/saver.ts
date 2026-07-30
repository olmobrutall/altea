import { Entity } from '../entities/entity';
import type { Type, PrimaryKey } from '../entities/entity';
import { cleanModified, forEachField } from '../entities/changes';
import { getTypeInfo } from '../entities/reflection';
import { IntegrityCheckException } from '../entities/validation';
import {
    exploreModifiables,
    propagateModifications,
    saveDependencyGraph,
    fullIntegrityCheck,
} from './graphExplorer';
import { insertEntityRows, updateEntityRow } from './save';
import { deleteRowsByIds } from './Database';
import { FieldEntityArray } from './schema/field';
import { Connector } from './connection/connector';
import { Transaction } from './connection/transaction';

// Port of Signum's Saver (Engine/Saver.cs), adapted to altea's snapshot model.
//
// `entity.save()` saves the whole object graph reachable from the entity, in one
// transaction:
//   1. Integrity-check every reachable modifiable (entities and embeddeds); throw
//      on any error.
//   2. Compute the save set: every reachable *graph-modified* entity — those that
//      are self-modified (a new entity has no snapshot, so it always qualifies) plus
//      the owners/referrers a change propagates up to (so a parent's `ticks` bumps
//      when an owned child changed). Entities reachable only as unchanged references
//      stay untouched — their FK id is already known.
//   3. Wire owned child rows: for each collection (`T[]`) field, point each
//      element's back-reference FK at its owner and number it by @rowOrder. This
//      is what turns the loader's `members: [...]` into rows that carry the band's
//      id — the cascade Signum gets from MList.
//   4. Save in dependency order: an entity is written only once everything it
//      references (within the save set) has an id. INSERT (new) or UPDATE (existing).
//   5. Re-baseline every saved entity (clean snapshot) once the transaction commits.
//
// vs Signum: same SelfModified→propagate→Modified→save-only-modified shape, but
// self-modified is computed from the snapshot rather than tracked by setters, and
// there is no separate InsertMany/UpdateMany batching yet (rows are written one
// statement at a time).

// `entity.save()` is declared and installed in ./logic (with the other entity/lite
// extension methods); it delegates to `Saver.save` below.

export namespace Saver {
    export async function save(roots: Entity[]): Promise<void> {
        const all = exploreModifiables(roots);

        const errors = fullIntegrityCheck(all);
        if (errors.length > 0)
            throw new IntegrityCheckException(errors);

        // Save set = every graph-modified entity: self-modified ones plus the
        // owners/referrers a change rolls up to (so a parent's ticks bumps when an
        // owned child changed).
        const saveSet = propagateModifications(all);
        if (saveSet.size === 0)
            return;

        // Cascade wiring must happen before ordering so each child's back-reference
        // counts as a dependency on its (possibly new) owner.
        for (const owner of saveSet)
            wireOwnedChildren(owner);

        await Transaction.create(async () => {
            // Orphan removal: a child dropped from an existing owner's collection is no longer
            // reachable, so it never enters the save set. Detect it by diffing the owner's
            // snapshot id-list against the current collection and delete the missing rows (with
            // owned-child cascade). Signum gets this from MList's tracked old rows.
            for (const owner of saveSet)
                await deleteCollectionOrphans(owner);

            // Dependency graph over the save set: edge A → B means "A references the new
            // entity B", so B must be inserted before A. Sinks (no out-edges) reference no
            // unsaved entity and can be written now.
            const graph = saveDependencyGraph(saveSet);

            // Break reference cycles (e.g. two new entities that own each other): the
            // feedback edges are inserted with their FK left NULL (Forbidden) and filled by
            // a deferred UPDATE once both ends have an id. Requires the cyclic FK to be a
            // nullable column — as in Signum, at least one edge of every cycle must be.
            const backEdges = graph.feedbackEdgeSet();
            const hasBackEdges = !backEdges.isEmpty;
            if (hasBackEdges)
                graph.removeEdges(backEdges.edges);

            // Topological save, level by level. Each pass takes every current sink (no
            // out-edge → every new entity it references is already written) and processes
            // the whole level, then removes it so its referrers become the next level's
            // sinks. `inv` (fixed) tells removeFullNode which in-edges to drop. New rows are
            // INSERTed grouped by table into one multi-row statement (the batching win for
            // collections); existing rows UPDATE one at a time (updates don't batch cleanly
            // on node-pg — bulk stays bulkInsert/unsafeUpdate).
            const inv = graph.inverse();
            // Entity's cycle-deferral set (empty when there are no back edges → harmless).
            const forbiddenOf = (e: Entity): ReadonlySet<Entity> => backEdges.tryRelatedTo(e);
            while (graph.count > 0) {
                const sinks = [...graph.sinks()];
                if (sinks.length === 0)
                    throw new Error(
                        'Save-time reference cycle survived feedback-edge removal among: ' +
                        [...graph.nodes].map(e => e.constructor.name).join(', '));

                // INSERT new entities grouped by table, one multi-row statement per group.
                // `isNew` (Signum's discriminator) — not `id == null` — so a new entity that
                // already carries a client-assigned key still inserts (insertEntityRows writes
                // its explicit PK); an existing row (isNew == false) updates.
                const insertGroups = new Map<Function, Entity[]>();
                for (const e of sinks)
                    if (e.isNew) {
                        let group = insertGroups.get(e.constructor);
                        if (group == null) { group = []; insertGroups.set(e.constructor, group); }
                        group.push(e);
                    }
                for (const group of insertGroups.values())
                    await insertEntityRows(group, group.map(forbiddenOf));

                // UPDATE existing entities individually.
                for (const e of sinks)
                    if (!e.isNew)
                        await updateEntityRow(e, forbiddenOf(e));

                for (const e of sinks)
                    graph.removeFullNode(e, inv.relatedTo(e));
            }

            // Deferred-FK pass: each back-edge source was written with a NULL cyclic FK;
            // now that its targets have ids, re-UPDATE it to fill the real foreign key.
            if (hasBackEdges) {
                const deferredSources = new Set(backEdges.edges.map(x => x.from));
                for (const e of deferredSources)
                    await updateEntityRow(e);
            }

            // Commit-time re-baseline: every saved row now matches the database.
            for (const e of saveSet)
                cleanModified(e);
        });
    }
}

// Deletes the rows of an existing owner's collections that are no longer present — the
// children a `save()` dropped from a `T[]` field. The owner's snapshot (its clean baseline)
// holds each collection as the ordered id-list that was in the database; anything in that list
// whose id isn't among the current elements is an orphan. The child table + FK come from the
// schema's FieldEntityArray, so an emptied collection (no live element to read a ctor off) is
// handled too. A new owner (no snapshot) has no prior rows, so there is nothing to remove.
async function deleteCollectionOrphans(owner: Entity): Promise<void> {
    const snapshot = owner._snapshot;
    // A real projection is needed to know the prior collection id-lists. The `true`
    // sentinel (fresh / deserialized-modified) and `undefined` (no baseline) both mean
    // there are no known prior rows to orphan — nothing to remove.
    if (snapshot == null || snapshot === true) return;

    const table = Connector.current().schema.table(owner.constructor as Type<Entity>);
    const orphans: { type: Type<Entity>; ids: PrimaryKey[] }[] = [];

    forEachField(owner, (fi, value) => {
        if (!fi.array) return;
        const oldIds = snapshot[fi.name];
        if (!Array.isArray(oldIds) || oldIds.length === 0) return;

        const current = new Set<unknown>(
            (Array.isArray(value) ? value : [])
                .filter((c): c is Entity => c instanceof Entity)
                .map(c => c.id));
        const removed = oldIds.filter((id): id is PrimaryKey => id != null && !current.has(id));
        if (removed.length === 0) return;

        const field = table.fields[fi.name]?.field;
        if (field instanceof FieldEntityArray)
            orphans.push({ type: field.childType, ids: removed });
    });

    for (const { type, ids } of orphans)
        await deleteRowsByIds(type, ids);
}

// Points each owned child row at its owner and assigns its row order. Reads the
// owner's collection (`T[]`) fields — including those contributed by mixins, via
// forEachField — and, on each element, sets the field flagged @backReference to the
// owner and the field flagged @rowOrder to the element's index. The back-reference
// is set to the owner *entity* (not a snapshot lite) so its live id is read at
// INSERT time, after the owner has been written. Shared with the bulk inserter.
export function wireOwnedChildren(owner: Entity): void {
    forEachField(owner, (fi, value) => {
        if (!fi.array || !Array.isArray(value)) return;

        value.forEach((child, index) => {
            if (!(child instanceof Entity)) return;
            const ti = getTypeInfo(child.constructor);
            if (ti == null) return;
            for (const cfi of Object.values(ti.fields)) {
                if (cfi.isBackReference)
                    (child as unknown as Record<string, unknown>)[cfi.name] = owner;
                else if (cfi.isRowOrder)
                    (child as unknown as Record<string, unknown>)[cfi.name] = index;
            }
        });
    });
}

