
import type { BaseEntity, EntitySnapshot, PrimaryKey, Type } from './entity';
import { Entity, EmbeddedEntity } from './entity';
import { Lite } from './lite';
import { getTypeInfo } from './reflection';
import type { FieldInfo } from './reflection';
import { MixinDeclarations } from './mixinDeclarations';

// Change tracking, reflection-driven (no setters, no Proxy, no INotifyPropertyChanged).
//
// Instead of flagging `modified = true` inside every setter (Signum's C# approach,
// which rides on INotifyPropertyChanged), altea keeps a *snapshot* of each
// modifiable's persistent state taken at load / after save, and recomputes
// "is this modified?" by diffing the live values against that snapshot — the same
// strategy Hibernate uses. Plain class fields stay plain; dirtiness is derived,
// not maintained.
//
// The snapshot is a normalized, shallow projection:
//   - value/enum fields  → the primitive (Date → epoch ms, Temporal/Decimal → string);
//   - references         → the target's `[type, id]` (a Lite or full Entity both
//                          collapse to it — pointing at a *different* instance with the
//                          *same* type+id is not a row change, since the FK column(s)
//                          are unchanged; saving that target is the graph's job). The
//                          *type* is part of the key because a scalar reference can be
//                          ImplementedBy / ImplementedByAll — repointing it at another
//                          concrete type changes the FK even when the id coincides;
//   - single embeddeds   → recursed inline (an embedded has no table identity of its
//                          own; its fields belong to the owner's row), so an embedded
//                          field change shows up directly in the owner's image;
//   - collections (`T[]`)→ the ordered list of element ids. Elements collapse to their
//                          id alone (not the `[type, id]` of a scalar reference): an
//                          owned MList — or a `Lite` list — has a single element type,
//                          so there is no ImplementedBy polymorphism to track and the id
//                          identifies the row. A collection is *owned*
//                          by its entity (Signum's MList semantics), so adding,
//                          removing or reordering elements makes the OWNER
//                          self-modified — its row is then re-saved and its `ticks`
//                          bumped, so a concurrent edit to the same entity's
//                          collection is caught by optimistic concurrency. (New
//                          elements have a null id; the list is re-baselined with
//                          real ids after save, so this only ever flags genuine
//                          structural change once persisted.)
//
// Because it reads only reflection metadata (available on both client and server),
// `isDirty()` works in the browser too — unlike a projection built from the
// server-only schema. Note this is change *detection*; the columns actually written
// are computed separately by collectAssignments (save.ts), so listing collection
// ids here does not affect the generated SQL.

// Base/infrastructure fields that are not user data and must never participate in
// the diff (id/ticks are server-assigned; isNew/_snapshot are bookkeeping).
const RESERVED_FIELDS = new Set(['id', 'ticks', 'isNew', '_snapshot']);

// Visits every persistent field of a modifiable — its own reflected fields plus,
// for entities, the fields contributed by each registered mixin (mixin fields are
// stored on the same instance, since `.mixin<M>()` is a cast). Skips @column(false) and
// reserved infrastructure fields.
export function forEachField(
    m: BaseEntity,
    callback: (fieldInfo: FieldInfo, value: unknown) => void,
): void {
    const ctor = m.constructor as Type<BaseEntity>;

    const visit = (owner: Type<BaseEntity>): void => {
        const ti = getTypeInfo(owner);
        if (ti == null) return;
        for (const fi of Object.values(ti.fields)) {
            if (fi.notMapped || RESERVED_FIELDS.has(fi.name)) continue;
            callback(fi, (m as unknown as Record<string, unknown>)[fi.name]);
        }
    };

    visit(ctor);
    for (const mixinClass of MixinDeclarations.getMixins(ctor as any))
        visit(mixinClass);
}

// The shallow normalized projection of a modifiable (see file header). Exported so
// the JSON codec (entities/serializer) can compare an incoming payload against a
// resolved entity's clean baseline for its not-modified consistency check.
export function getSnapshot(m: BaseEntity): EntitySnapshot {
    const snapshot: EntitySnapshot = {};
    forEachField(m, (fi, value) => {
        snapshot[fi.name] = valueSnapshot(value);
    });
    return snapshot;
}

function valueSnapshot(value: unknown): unknown {
    if (value == null) return null;
    // A collection projects to the ordered list of element ids: membership and
    // order changes thus make the owner self-modified (owned-collection semantics).
    if (Array.isArray(value)) return value.map(elementSnapshot);
    if (value instanceof Lite || value instanceof Entity) return referenceKey(value);
    if (value instanceof EmbeddedEntity) return getSnapshot(value); // inline, no identity
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'object') return String(value); // Temporal.* / Decimal / etc.
    return value; // primitives, including enum numbers
}

// The projection of a *collection element*. Unlike a scalar reference (which keeps its
// `[type, id]` to catch an ImplementedBy/ImplementedByAll type change), a collection has
// a single element type, so a referenced element collapses to its id alone — the shape the
// saver's orphan-deletion reads back as a plain id-list. Embeddeds still recurse inline.
function elementSnapshot(value: unknown): unknown {
    if (value == null) return null;
    if (value instanceof Lite || value instanceof Entity) return referenceKey(value)?.[1] ?? null;
    if (value instanceof EmbeddedEntity) return getSnapshot(value); // inline, no identity
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'object') return String(value); // Temporal.* / Decimal / etc.
    return value; // primitives, including enum numbers
}

/**
 * The primary-key id behind a reference — a full {@link Entity} or a {@link Lite}.
 * For a *fat* lite of a still-new entity the lite captured `id = null` at creation
 * and never updates, so the live entity's id (once saved) is authoritative; fall
 * back to the lite's own id for a thin lite. Shared by the snapshot projection and
 * the save path so both agree on what a reference column holds.
 */
export function referenceKey(value: Lite<Entity> | Entity | null | undefined): [Type<Entity>, PrimaryKey | null] | null {
    if (value == null) return null;
    if (value instanceof Lite)
        return [value.entityType, value.entityOrNull?.id ?? value.id ?? null];
    return [value.getType(), value.id ?? null];
}

// Deep equality over two projections. Leaves are primitives/strings; nested objects
// are inlined embedded projections (records) or collection id-lists (arrays) — both
// compare element-by-element with a length check (Object.keys covers array indices).
// Exported for the JSON codec's not-modified consistency check.
export function snapshotEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    if (ak.length !== Object.keys(bo).length) return false;
    for (const k of ak)
        if (!snapshotEqual(ao[k], bo[k])) return false;
    return true;
}

// ---- Public API ------------------------------------------------------------

/**
 * Records the current state as the clean baseline. Called after a successful save
 * and after retrieving an entity from the database — the snapshot/clean equivalent
 * of Signum's `SetCleanModified` / `CleanModifications`.
 */
export function cleanModified(m: BaseEntity): void {
    m._snapshot = getSnapshot(m);
}

/**
 * True when this modifiable's *own* fields differ from its snapshot (Signum's
 * `SelfModified`). The snapshot has three states (see {@link BaseEntity._snapshot}):
 * the `true` sentinel is unconditionally modified (freshly created, or deserialized
 * with `modified: true`); the `undefined` sentinel is unconditionally clean
 * (deserialized without the flag); a real projection is diffed against the live values.
 */
export function isModifiedSelf(m: BaseEntity): boolean {
    const s = m._snapshot;
    if (s === true) return true;         // sentinel: known-modified, no baseline
    if (s === undefined) return false;   // sentinel: known-clean, no baseline
    return !snapshotEqual(s, getSnapshot(m));
}

// Collects the modifiable graph children of `m`: referenced entities (full or via a
// loaded/fat Lite), collection elements, and the references found by recursing into
// inlined embeddeds. Embeddeds are not nodes themselves — their fields belong to the
// owner's row image — but the entities they point at must still be reachable.
export function collectChildren(m: BaseEntity, out: Set<BaseEntity>): void {
    forEachField(m, (_fi, value) => addChildren(value, out));
}

function addChildren(value: unknown, out: Set<BaseEntity>): void {
    if (value == null) return;
    if (Array.isArray(value)) {
        for (const el of value) addChildren(el, out);
        return;
    }
    if (value instanceof Lite) {
        const e = value.entityOrNull;
        if (e != null) out.add(e);
        return;
    }
    if (value instanceof EmbeddedEntity) {
        forEachField(value, (_fi, v) => addChildren(v, out));
        return;
    }
    if (value instanceof Entity) {
        out.add(value);
        return;
    }
}

/**
 * True if this modifiable or any modifiable reachable from it is self-modified —
 * Signum's graph-`Modified` / `HasChanges`. This is what `isDirty()` reports: a
 * form is dirty if anything in its object graph changed.
 */
export function isGraphModified(root: BaseEntity): boolean {
    const seen = new Set<BaseEntity>([root]);
    const stack: BaseEntity[] = [root];
    while (stack.length > 0) {
        const m = stack.pop()!;
        if (isModifiedSelf(m)) return true;
        const children = new Set<BaseEntity>();
        collectChildren(m, children);
        for (const c of children)
            if (!seen.has(c)) {
                seen.add(c);
                stack.push(c);
            }
    }
    return false;
}
