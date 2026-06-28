import { Entity } from '../entities/entity';
import { cleanModified, forEachField } from '../entities/changes';
import { getTypeInfo } from '../entities/reflection';
import { IntegrityCheckException } from '../entities/validation';
import {
    exploreModifiables,
    propagateModifications,
    forwardReferences,
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

declare module '../entities/entity' {
    interface Entity {
        // Saves this entity and its graph, returning the entity so calls chain
        // inline, mirroring Signum's `new XEntity { ... }.Execute(XOperation.Save)`:
        // `const band = await BandEntity.create({ ... }).save();`.
        save(): Promise<this>;
    }
}

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
            const saved = new Set<Entity>();
            const pending = new Set(saveSet);

            while (pending.size > 0) {
                // Ready = every in-saveSet reference it points at has been written
                // (so its FK id is available). Existing/clean references are always
                // satisfied — their id predates this save.
                const ready = [...pending].filter(e =>
                    forwardReferences(e).every(r => !saveSet.has(r) || saved.has(r)));

                if (ready.length === 0)
                    throw new Error(
                        'Save-time reference cycle detected among: ' +
                        [...pending].map(e => e.constructor.name).join(', ') +
                        '. Deferred-FK cycle handling is not yet implemented.');

                for (const e of ready) {
                    if (e.id == null)
                        await insertEntityRow(e);
                    else
                        await updateEntityRow(e);
                    saved.add(e);
                    pending.delete(e);
                }
            }

            // Commit-time re-baseline: every saved row now matches the database.
            for (const e of saved)
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

Entity.prototype.save = async function (this: Entity): Promise<Entity> {
    await Saver.save([this]);
    return this;
};
