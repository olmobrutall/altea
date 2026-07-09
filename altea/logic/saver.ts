import { Entity } from '../entities/entity';
import { cleanModified, forEachField } from '../entities/changes';
import { getTypeInfo } from '../entities/reflection';
import { IntegrityCheckException } from '../entities/validation';
import {
    exploreModifiables,
    propagateModifications,
    saveDependencyGraph,
    fullIntegrityCheck,
} from './graphExplorer';
import { insertEntityRow, updateEntityRow } from './save';
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

            // Topological save, sinks first. `inv` (fixed) tells removeFullNode which
            // in-edges to drop as each node is written, freeing its referrers to become
            // sinks — Signum's SaveGraph loop, one row per statement (no InsertMany here;
            // bulk paths are bulkInsert/unsafeUpdate).
            const inv = graph.inverse();
            while (graph.count > 0) {
                const sinks = graph.sinks();
                if (sinks.size === 0)
                    throw new Error(
                        'Save-time reference cycle survived feedback-edge removal among: ' +
                        [...graph.nodes].map(e => e.constructor.name).join(', '));

                for (const e of sinks) {
                    const forbidden = hasBackEdges ? backEdges.tryRelatedTo(e) : undefined;
                    if (e.id == null)
                        await insertEntityRow(e, forbidden);
                    else
                        await updateEntityRow(e, forbidden);
                    graph.removeFullNode(e, inv.relatedTo(e));
                }
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

// Points each owned child row at its owner and assigns its row order. Reads the
// owner's collection (`T[]`) fields — including those contributed by mixins, via
// forEachField — and, on each element, sets the field flagged @backReference to the
// owner and the field flagged @rowOrder to the element's index. The back-reference
// is set to the owner *entity* (not a snapshot lite) so its live id is read at
// INSERT time, after the owner has been written.
function wireOwnedChildren(owner: Entity): void {
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

