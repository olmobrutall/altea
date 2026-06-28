import type { BaseEntity } from '../entities/entity';
import { Entity, EmbeddedEntity } from '../entities/entity';
import { Lite } from '../entities/lite';
import { forEachField, collectChildren, isModifiedSelf } from '../entities/changes';
import { entityIntegrityCheck } from '../entities/validation';
import type { IntegrityCheck } from '../entities/validation';

// Port of Signum's GraphExplorer (Entities/Reflection/GraphExplorer.cs).
//
//   - exploreModifiables: every reachable modifiable (entities AND embeddeds), so
//     the integrity check validates embeddeds too;
//   - propagateModifications: roll a child's change up to its owners — the save set
//     is every *graph-modified* entity (self-modified, or owning/referencing
//     something that changed), so a parent's row is re-saved and its `ticks` bumped
//     when an owned child changes (aggregate-level optimistic concurrency);
//   - forwardReferences / collectionChildren: classify an entity's outgoing links
//     into "points at (must be saved first)" vs "owned rows (saved after me)",
//     which the Saver uses to order INSERTs;
//   - fullIntegrityCheck: validate the whole graph at once.
//
// What the column-image snapshot (./changes) *does* let us drop is Signum's
// SelfModified vs Modified enum bookkeeping: `isModifiedSelf` is computed on demand,
// and propagation is a one-shot reachability pass here rather than mutable per-node
// state. A single embedded's change already shows up in its owner's image (embeddeds
// are inlined) and a collection's add/remove/reorder shows up in the owner's id-list,
// so propagation only has to carry *child content edits* up to the owner.

// ---- Reachability ----------------------------------------------------------

/**
 * Every modifiable reachable from `roots` — entities and embeddeds alike. Embeddeds
 * are included (unlike the change-tracking walk, which inlines them) so that the
 * integrity check validates their fields. References are followed through full
 * entities and through loaded/fat {@link Lite}s; collection elements are followed
 * element by element.
 */
export function exploreModifiables(roots: Iterable<BaseEntity>): Set<BaseEntity> {
    const seen = new Set<BaseEntity>();
    const stack: BaseEntity[] = [];

    const push = (value: unknown): void => {
        if (value == null) return;
        if (Array.isArray(value)) {
            for (const el of value) push(el);
            return;
        }
        if (value instanceof Lite) {
            const e = value.entityOrNull;
            if (e != null) push(e);
            return;
        }
        if (value instanceof Entity || value instanceof EmbeddedEntity) {
            if (!seen.has(value)) {
                seen.add(value);
                stack.push(value);
            }
        }
    };

    for (const r of roots) push(r);
    while (stack.length > 0) {
        const m = stack.pop()!;
        forEachField(m, (_fi, value) => push(value));
    }
    return seen;
}

// ---- Modification propagation ----------------------------------------------

/**
 * The set of entities that must be saved: every entity that is self-modified, plus
 * every entity that owns or references (directly or transitively) a self-modified
 * one. Port of Signum's `PropagateModifications` — rolling a child's change up to
 * its parents so the parent's row is re-saved and its `ticks` bumped. This is the
 * aggregate concurrency boundary: editing an owned child (a collection row's fields,
 * an embedded — though embeddeds are already folded into the owner's image) marks
 * the owning entity modified even though its own scalar columns are unchanged.
 *
 * The graph edges are the same ones {@link exploreModifiables} follows (full entity
 * references and fat lites included, thin lites excluded), so a reference to another
 * aggregate held by a thin `Lite` is naturally a boundary that does not propagate.
 */
export function propagateModifications(reachable: Set<BaseEntity>): Set<Entity> {
    const entities = [...reachable].filter((m): m is Entity => m instanceof Entity);

    // Inverse edges: for each entity, who points at it (its owners/referrers).
    const parents = new Map<Entity, Entity[]>();
    const ensure = (k: Entity): Entity[] => {
        let list = parents.get(k);
        if (list == null) { list = []; parents.set(k, list); }
        return list;
    };
    for (const e of entities) {
        const children = new Set<BaseEntity>();
        collectChildren(e, children);
        for (const c of children)
            if (c instanceof Entity && reachable.has(c))
                ensure(c).push(e);
    }

    // Seed with the self-modified entities, then flood up the inverse edges.
    const modified = new Set<Entity>();
    const stack: Entity[] = [];
    for (const e of entities)
        if (isModifiedSelf(e)) { modified.add(e); stack.push(e); }

    while (stack.length > 0) {
        const child = stack.pop()!;
        for (const parent of parents.get(child) ?? [])
            if (!modified.has(parent)) {
                modified.add(parent);
                stack.push(parent);
            }
    }
    return modified;
}

// ---- Reference classification (for save ordering) --------------------------

/**
 * The entities this entity points AT through reference fields — directly or via an
 * inlined embedded — and which therefore must already exist (have an id) before
 * this entity's row can carry their foreign key. Collection (`T[]`) fields are
 * excluded: their elements point back at this entity, so they are saved *after* it
 * (see {@link collectionChildren}).
 */
export function forwardReferences(entity: Entity): Entity[] {
    const out: Entity[] = [];

    const visit = (m: BaseEntity): void => {
        forEachField(m, (fi, value) => {
            if (fi.array) return; // collections are owned children, not dependencies
            if (value == null) return;
            if (value instanceof Lite) {
                const e = value.entityOrNull;
                if (e != null) out.push(e);
            } else if (value instanceof EmbeddedEntity) {
                visit(value); // an embedded's references are the owner's dependencies
            } else if (value instanceof Entity) {
                out.push(value);
            }
        });
    };

    visit(entity);
    return out;
}

/**
 * The owned rows hanging off this entity's collection (`T[]`) fields — the part
 * entities that carry a back-reference FK to it. They are saved *after* this entity
 * so the back-reference can be filled with its id.
 */
export function collectionChildren(entity: Entity): Entity[] {
    const out: Entity[] = [];
    forEachField(entity, (fi, value) => {
        if (!fi.array || !Array.isArray(value)) return;
        for (const el of value)
            if (el instanceof Entity) out.push(el);
    });
    return out;
}

// ---- Integrity -------------------------------------------------------------

/**
 * Validates every modifiable in the graph, returning one {@link IntegrityCheck} per
 * failing modifiable (empty when the whole graph is valid) — the port of
 * GraphExplorer.FullIntegrityCheck.
 */
export function fullIntegrityCheck(modifiables: Iterable<BaseEntity>): IntegrityCheck[] {
    const result: IntegrityCheck[] = [];
    for (const m of modifiables) {
        const check = entityIntegrityCheck(m);
        if (check != null) result.push(check);
    }
    return result;
}
