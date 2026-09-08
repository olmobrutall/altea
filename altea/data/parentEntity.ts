// Port of Signum's parent back-pointer (`ModifiableEntity.parentEntity` + `[BindParent]` +
// `GetParentEntity<T>()`): the owner of an embedded, a `@part` row or a collection element, reachable FROM
// the child. What it is for is a rule that lives on the child and depends on the owner — a read-only rule,
// a validation, an `EvalEmbedded` reading the entity that carries it.
//
// It is NOT the same thing as a `@part` row's `@backReference`, which is a `Lite` filled by the SAVE
// cascade: while a graph is being edited or validated that reference is still empty, and the owner may be
// a NEW entity with no id at all. The parent is the full instance, available the moment the graph exists.
//
// ---- Why a WeakMap and not a field ---------------------------------------------------------------------
//
// Signum keeps `parentEntity` as a private field, which it can afford because its converter walks
// properties one by one. An own property here would have to be kept out of the wire, out of the snapshot
// diff (or every entity with a parent reads back dirty), out of ObjectDumper and out of every
// `JSON.stringify` in a test — and it makes the graph cyclic. The WeakMap costs a lookup and has none of
// that; altea-eval already solved this exact problem the same way, and this replaces its private copy.
//
// ---- Why the read VERIFIES -----------------------------------------------------------------------------
//
// Signum stamps the parent from the property setter and clears it from the collection-changed event, and
// `SetParentEntity` throws when a modifiable is already owned by someone else. altea has no setters, so
// the stamp happens at a handful of known points (`bindParents` below, and `Binding.setValue` on the
// client) — which means a child MOVED or REMOVED since could be holding a stale owner. So the slot records
// the member it was bound under and the read checks that the owner still holds this child there: a stale
// entry answers `undefined` instead of the wrong entity. That is strictly better than Signum, where the
// same situation answers confidently and wrongly, and it is why there is no `clearParentEntity`.
//
// The throw is not ported either: re-binding a child that already had a different owner simply wins,
// because throwing in the middle of a load or a deserialization pass would be a landmine and the
// verification above already stops a wrong answer from being given.

import { BaseEntity, EmbeddedEntity, Entity } from './entity';
import type { Type } from './entity';
import { eachFieldInfo } from './reflection';

interface ParentSlot {
    readonly owner: BaseEntity;
    /** The member of `owner` this child was bound under — read back to verify the binding still holds. */
    readonly member: string;
}

const parents = new WeakMap<BaseEntity, ParentSlot>();

/**
 * Signum's `SetParentEntity`. Called by {@link bindParents} and by the client's `Binding.setValue`, which
 * is altea's counterpart of the property setter Signum hooks — see there.
 */
export function setParentEntity(child: BaseEntity, owner: BaseEntity, member: string): void {
    parents.set(child, { owner, member });
}

/**
 * Signum's `TryGetParentEntity<T>()` — the immediate owner of `child`, or undefined when it has none, the
 * binding no longer holds (see the header) or the owner is not of the type asked for.
 *
 * `type` is a RUNTIME argument, not just a type parameter, so the answer is CHECKED. Signum spells the
 * same call `TryGetParentEntity<OrderEntity>()` and resolves it with an unchecked `as`, which hands back
 * whatever is there and fails somewhere else. A mismatch is SILENT here, exactly as that `as` is — which
 * is what lets a rule stand down when it is asked about a graph it does not belong to; use
 * {@link getParentEntity} where the caller means to insist.
 */
export function tryGetParentEntity<T extends BaseEntity>(child: BaseEntity, type: Type<T>): T | undefined {
    const slot = parents.get(child);
    if (slot == null)
        return undefined;

    const current = (slot.owner as unknown as Record<string, unknown>)[slot.member];
    const holds = Array.isArray(current) ? current.includes(child) : current === child;
    if (!holds)
        return undefined;

    return slot.owner instanceof type ? slot.owner as T : undefined;
}

/**
 * Signum's `GetParentEntity<T>()` — as {@link tryGetParentEntity}, but insists. It distinguishes the two
 * mistakes, which is the other reason to pass the type at runtime: a missing `@bindParent` (or a graph
 * that reached no binding point) and an owner of the wrong type.
 */
export function getParentEntity<T extends BaseEntity>(child: BaseEntity, type: Type<T>): T {
    const owner = tryGetParentEntity(child, type);
    if (owner != null)
        return owner;

    const bound = parents.get(child)?.owner;
    if (bound != null && !(bound instanceof type))
        throw new Error(`The parent of '${child.constructor.name}' is a `
            + `'${bound.constructor.name}', not the '${type.name}' asked for.`);

    throw new Error(`The parent of '${child.constructor.name}' is not bound.`
        + " Mark the field that holds it @bindParent, and check the graph reached a binding point"
        + " (deserialization, retrieve, save, or a Binding write).");
}

/**
 * The nearest ancestor of `child` that is an instance of `type` — the parent chain CLIMBED rather than
 * read once. What a rule carried by an embedded almost always wants: an `EvalEmbedded` two levels down
 * still means "the entity I belong to", and Signum reaches the same place by chaining two
 * `GetParentEntity` calls by hand (`SubWorkflowEmbedded` → `WorkflowActivityEntity`).
 *
 * Silent on a miss, like {@link tryGetParentEntity}: a chain that runs out — or one that only ever
 * reaches a MODEL, which is how an eval carried by a ModelEntity stays unbound — answers undefined.
 */
export function tryGetOwnerEntity<T extends BaseEntity>(child: BaseEntity, type: Type<T>): T | undefined {
    for (let c: BaseEntity = child; ;) {
        const owner = tryGetParentEntity(c, BaseEntity as Type<BaseEntity>);
        if (owner == null)
            return undefined;
        if (owner instanceof type)
            return owner as T;
        c = owner;
    }
}

/**
 * Stamp the children held by `owner`'s `@bindParent` fields, and recurse into them so ONE call binds a
 * whole graph. Signum's `BindParent()` does a single level and gets the chain because every child's own
 * constructor calls it; altea has no constructor hook, so the walk is explicit.
 *
 * Only MARKED fields are followed, exactly as in Signum — the marker is what says "this member's value
 * belongs to me". A marked field holding something that is not a modifiable is skipped rather than
 * refused: a load pass is the wrong place to fail on a declaration mistake.
 */
export function bindParents(owner: BaseEntity, visited?: Set<BaseEntity>): void {
    const seen = visited ?? new Set<BaseEntity>();
    if (seen.has(owner))
        return;
    seen.add(owner);

    forEachBoundChild(owner, (child, member) => {
        setParentEntity(child, owner, member);
        bindParents(child, seen);
    });
}

/**
 * The single level: bind what `owner`'s marked fields hold, without recursing. What the JSON codec uses —
 * a nested modifiable is deserialized before its container, so one level per container walks the whole
 * graph bottom-up on its own.
 */
export function bindParentsOwn(owner: BaseEntity): void {
    forEachBoundChild(owner, (child, member) => setParentEntity(child, owner, member));
}

/**
 * Every modifiable held by a `@bindParent` field of `owner` — the field itself, or each element when it is
 * a collection (Signum's two branches in `BindParent`, one for a ModifiableEntity and one for a list).
 *
 * The field list is scanned per call rather than memoized: the scan is a handful of property reads next to
 * a deserialization or a save, and memoizing by constructor would freeze the answer before an app's
 * entity-overrides module had a chance to set `bindParent` imperatively.
 */
function forEachBoundChild(owner: BaseEntity, callback: (child: BaseEntity, member: string) => void): void {
    eachFieldInfo(owner.constructor, fi => {
        if (fi.bindParent !== true)
            return;

        const value = (owner as unknown as Record<string, unknown>)[fi.name];
        if (Array.isArray(value)) {
            for (const element of value)
                if (isModifiable(element))
                    callback(element, fi.name);
        } else if (isModifiable(value)) {
            callback(value, fi.name);
        }
    });
}

function isModifiable(value: unknown): value is BaseEntity {
    return value instanceof Entity || value instanceof EmbeddedEntity;
}
