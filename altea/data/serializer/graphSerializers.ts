// The entity-graph–aware serializers and the factory that wires them. These are mutually
// recursive with the shared `factory` singleton (a serializer resolves nested serializers
// through it), so they live in one module; the factory-free leaves are in ./leafSerializers.
//
// A `SerializerFactory` resolves the serializer for each field once and caches a
// per-entity-type `EntitySerializer` whose field plan is PRECOMPUTED from reflection — so
// stringify/parse never re-walk metadata per call.

import { Entity, EmbeddedEntity, ModelEntity } from '../entity';
import type { Type, PrimaryKey, BaseEntity } from '../entity';
import { Lite, LiteImp, getCustomLites } from '../lite';
import type { CustomLiteClass } from '../lite';
import { isModifiedSelf, getSnapshot, snapshotEqual } from '../changes';
import { getTypeInfo } from '../reflection';
import type { FieldInfo } from '../reflection';
import { MixinDeclarations } from '../mixinDeclarations';
import { resolveCleanType, resolveEnum, cleanTypeName } from '../registration';
import { EnumEntity } from '../enumEntity';
import { toInt, Decimal } from '../basics';
import type {
    JsonSerializer, FieldPlan, Slot,
    SerializationContext, DeserializationContext, SerializeOptions, DeserializeOptions,
} from './types';
import { TEMPORAL_TYPE_NAMES, isTemporal } from './temporalHelpers';
import { PropertyRoute } from '../propertyRoute';

// ---- Property-authorization hook (Signum's AuthServer serialization filters) -------------------
//
// OPEN BY DEFAULT: with no auth installed (`_serAuth == null`) the codec behaves exactly as before — the
// whole property-auth path is skipped. An auth module (altea-auth's AuthServer, when PropertyAuthLogic is
// started) installs a SerializationAuth via setSerializationAuth. `access(route, meta)`:
//   'hidden'   → the property is OMITTED from the wire (server→client) and its line is hidden client-side;
//   'readonly' → the property is written but flagged read-only (propsMeta) so the client greys it, and a
//                changed value is REJECTED on save (onWriteViolation);
//   'writable' → normal.
// `getMetadata(root)` returns opaque per-root metadata (the role's property allowances for that instance),
// threaded to `access` so it is computed once per root entity, not per property.
export type PropertyAccess = 'hidden' | 'readonly' | 'writable';
export interface SerializationAuth {
    getMetadata(root: Entity): unknown;
    // `access` is SYNCHRONOUS. `context` is the IMMUTABLE snapshot resolved up-front by `resolveContext`
    // (SerializeOptions.authContext) — access reads the role's rules from it, never from a live cache, so a
    // concurrent rule invalidation cannot affect an in-flight serialization.
    access(route: PropertyRoute, meta: unknown, context: unknown): PropertyAccess;
    // The role's rules load asynchronously; the (de)serialization boundary (async — the web response
    // wrapper + request deserializer) resolves this ONCE, up-front, into an immutable snapshot that is then
    // passed into the sync `stringify`/`parse`. Absent ⇒ no auth (open).
    resolveContext?(): Promise<unknown>;
}
let _serAuth: SerializationAuth | undefined;
export function setSerializationAuth(auth: SerializationAuth | undefined): void { _serAuth = auth; }
/** True once a SerializationAuth is installed — lets the save path decide whether to run the write-gate overlay. */
export function hasSerializationAuth(): boolean { return _serAuth != null; }
/** Resolve the installed auth's immutable rule snapshot (undefined if none). Called at the async
 *  (de)serialization boundary and then threaded into the sync `stringify`/`parse` as `authContext`, so the
 *  synchronous `access` reads a consistent snapshot immune to concurrent invalidation. */
export function resolveSerializationAuthContext(): Promise<unknown> { return _serAuth?.resolveContext?.() ?? Promise.resolve(undefined); }

// The field route for `name` off `ownerRoute`, or undefined if it can't be built (never gate then).
function fieldRouteOf(ownerRoute: PropertyRoute | undefined, name: string): PropertyRoute | undefined {
    if (ownerRoute == null) return undefined;
    try { return ownerRoute.add(name); } catch { return undefined; }
}

// ---- ctor-kind checks + field iterator (serializer-local; the temporal + enum helpers live in
// ./temporalHelpers and ../enum respectively) ----------------------------------------------------

// True for a persisted Entity ctor (gates the id/ticks/toStr handling in EntitySerializer).
function ctorIsEntity(ctor: Function): boolean {
    return ctor === Entity || ctor.prototype instanceof Entity;
}
// True for an id-less modifiable (EmbeddedEntity OR ModelEntity) — both (de)serialize the same way.
function ctorIsEmbedded(ctor: Function): boolean {
    return ctor === EmbeddedEntity || ctor.prototype instanceof EmbeddedEntity
        || ctor === ModelEntity || ctor.prototype instanceof ModelEntity;
}

// A ctor-based iterator over a modifiable's reflected fields — own + inherited (reflection copies base
// fields into each subclass) + mixin. No instance needed, so the factory precomputes a plan per type.
// (Distinct from changes.forEachField, which needs an instance and skips @column(false)/reserved fields
// — the codec serializes @column(false) fields.)
function eachFieldInfo(ctor: Function, cb: (fi: FieldInfo) => void): void {
    const visit = (owner: Function): void => {
        const ti = getTypeInfo(owner);
        if (ti == null) return;
        for (const fi of Object.values(ti.fields)) cb(fi);
    };
    visit(ctor);
    for (const mixin of MixinDeclarations.getMixins(ctor as Type<BaseEntity>))
        visit(mixin as unknown as Function);
}
import {
    ValueSerializer, TemporalSerializer, DecimalSerializer, DateSerializer, EnumSerializer, ArraySerializer,
} from './leafSerializers';

// Resolve a wire discriminator (`$lite` / `$type`) back to its constructor. Reverse of `cleanTypeName`,
// which also names a closed EnumEntity<E> after its ENUM ("OrderState"): an enum entity has no entry in the
// type registry (enums live in the enum registry, not registerType), so a clean-name miss falls back to the
// enum registry and re-mints the SAME memoized bound ctor via EnumEntity.typeFor. Without this an enum lite
// in an @implementedByAll field (e.g. ColorPalette.specificColors) deserializes to base Entity and the save
// discriminator write (TypeLogic.typeToId) throws "Type 'Entity' is not registered".
function resolveWireType(name: string): Function | undefined {
    const ctor = resolveCleanType(name);
    if (ctor != null)
        return ctor;
    const enumObj = resolveEnum(name);
    return enumObj != null ? (EnumEntity.typeFor(enumObj) as unknown as Function) : undefined;
}

// ---- Lite ------------------------------------------------------------------

const LITE_RESERVED_KEYS = new Set(['id', 'entityType', 'toStr', '_entity']);

// `expectedCtor` is the declared target entity type (undefined for a polymorphic
// `Lite<Entity>` / `@implementedBy` lite — which then always carries `$lite` on the wire).
// `fieldCustomLite` is the field's @customLite override list (Signum's [LiteModel]): a value whose
// resolved type matches an entry's `forEntityType` rebuilds as that class, taking priority over the
// type's globally-registered custom lites.
class LiteSerializer implements JsonSerializer {
    constructor(
        private readonly expectedCtor: Function | undefined,
        private readonly fieldCustomLite?: { liteClass: () => unknown; forEntityType: () => unknown }[],
    ) { }

    toJson(value: unknown, sc: SerializationContext, writeType: boolean): unknown {
        const lite = value as Lite<Entity>;
        const o: Record<string, unknown> = {};
        if (writeType || sc.writeTypes === 'Always' || this.expectedCtor == null)
            o.$lite = cleanTypeName(lite.entityType);
        o.id = lite.id ?? null;
        o.toStr = lite.toString();
        for (const key of Object.keys(lite)) {           // custom-lite display fields, flat
            if (LITE_RESERVED_KEYS.has(key)) continue;
            o[key] = factory.dynamic.toJson((lite as unknown as Record<string, unknown>)[key], sc, false);
        }
        const entity = lite.entityOrNull;
        if (entity != null)   // fat lite — the entity's type is the lite's, so Auto omits $type
            o.entity = factory.forEntity(entity.constructor as Type<BaseEntity>).toJson(entity, sc, sc.writeTypes === 'Always');
        return o;
    }

    fromJson(json: unknown, dc: DeserializationContext, _existing?: unknown, _slot?: Slot): unknown {
        const j = json as Record<string, unknown>;
        const wire = j.$lite as string | undefined;
        const ctor = wire != null ? resolveWireType(wire) : this.expectedCtor;
        if (ctor == null)
            throw new Error(wire != null
                ? `Cannot deserialize lite: unknown type "${wire}"`
                : 'Cannot deserialize lite: no $lite discriminator and no field context');

        const id = (j.id === undefined ? null : j.id) as PrimaryKey;
        let lite: Lite<Entity> | undefined;
        // The field's @customLite override is authoritative for its declared type: a lite of that
        // type on this field IS that model (Signum's [LiteModel] on the property).
        if (this.fieldCustomLite != null) {
            const match = this.fieldCustomLite.find(c => (c.forEntityType() as Type<Entity>) === ctor);
            if (match != null)
                lite = (match.liteClass() as CustomLiteClass).fromJson(j);
        }
        if (lite == null)
            for (const candidate of getCustomLites(ctor))
                if (candidate.isCompatible(j)) { lite = candidate.fromJson(j); break; }
        lite ??= new LiteImp(id, ctor as Type<Entity>, (j.toStr as string | undefined) ?? '');

        if (j.entity != null)
            lite.setEntity(factory.forEntity(ctor as Type<BaseEntity>).fromJson(j.entity, dc, undefined) as Entity);
        return lite;
    }
}

// ---- Polymorphic full-entity reference (@implementedBy / @implementedByAll, non-lite) ------

class PolyReferenceSerializer implements JsonSerializer {
    toJson(value: unknown, sc: SerializationContext): unknown {
        const entity = value as Entity;
        return factory.forEntity(entity.constructor as Type<BaseEntity>).toJson(entity, sc, /* writeType */ true);
    }
    fromJson(json: unknown, dc: DeserializationContext, existing: unknown, slot?: Slot): unknown {
        const j = json as Record<string, unknown>;
        const ctor = resolveWireType(j.$type as string);
        if (ctor == null) throw new Error(`Cannot deserialize polymorphic reference: unknown type "${String(j.$type)}"`);
        return factory.forEntity(ctor as Type<BaseEntity>).fromJson(j, dc, existing, slot);
    }
}

// ---- Modifiable base (shared entity/embedded field-plan machinery) ---------

abstract class ModifiableSerializer implements JsonSerializer {
    plan: FieldPlan[] = [];   // precomputed by the factory (see build)
    constructor(readonly ctor: Function) { }

    abstract toJson(value: unknown, sc: SerializationContext, writeType: boolean, parented?: boolean): unknown;
    abstract fromJson(json: unknown, dc: DeserializationContext, existing: unknown, slot?: Slot): unknown;

    protected serializeFields(m: BaseEntity, sc: SerializationContext, o: Record<string, unknown>, parented: boolean, ownerRoute?: PropertyRoute): void {
        const fieldWriteType = sc.writeTypes === 'Always';
        const gate = _serAuth != null && ownerRoute != null;
        const propsMeta: string[] = [];
        for (const entry of this.plan) {
            if (parented && (entry.isBackReference || entry.isRowOrder)) continue;   // recoverable
            let fieldRoute: PropertyRoute | undefined;
            if (gate) {
                fieldRoute = fieldRouteOf(ownerRoute, entry.name);
                if (fieldRoute != null) {
                    const acc = _serAuth!.access(fieldRoute, sc.authMeta, sc.authContext);
                    // Signum's propsMeta: "!name" ⇒ hidden (also omit the value), "name" ⇒ read-only.
                    if (acc === 'hidden') { propsMeta.push("!" + entry.name); continue; }
                    if (acc === 'readonly') propsMeta.push(entry.name);
                }
            }
            const v = (m as unknown as Record<string, unknown>)[entry.name];
            const prevRoute = sc.route;
            sc.route = fieldRoute;   // so an embedded child knows its own route
            o[entry.name] = v == null ? null : entry.serializer.toJson(v, sc, fieldWriteType);
            sc.route = prevRoute;
        }
        if (propsMeta.length > 0) o.propsMeta = propsMeta;
    }

    protected applyFields(m: BaseEntity, json: Record<string, unknown>, dc: DeserializationContext, ownerRoute?: PropertyRoute): void {
        const target = m as unknown as Record<string, unknown>;
        // Write gate active only when auth is installed AND we know this container's route (the entity
        // OVERLAY path onto a resolved original — see EntitySerializer.fromJson). New entities / the
        // client-receive path pass no ownerRoute, so nothing is gated there.
        const gate = _serAuth != null && ownerRoute != null;
        for (const entry of this.plan) {
            if (!Object.prototype.hasOwnProperty.call(json, entry.name)) continue;
            const fieldRoute = gate ? fieldRouteOf(ownerRoute, entry.name) : undefined;
            // Write gate: a property the role can't WRITE keeps the ORIGINAL value — the incoming value is
            // ignored (write-protected). Silent-keep (not throw) is deliberate: a HIDDEN property's value
            // was omitted from the wire, so the client echoes null; silently keeping the original avoids a
            // false rejection of a legitimate save AND needs no client-side omission logic.
            if (fieldRoute != null && _serAuth!.access(fieldRoute, dc.authMeta, dc.authContext) !== 'writable')
                continue;
            const jv = json[entry.name];
            const prevRoute = dc.route;
            dc.route = fieldRoute;   // so an embedded child gates its own sub-fields
            target[entry.name] = jv == null
                ? null
                : entry.serializer.fromJson(jv, dc, target[entry.name], { owner: m as Entity });
            dc.route = prevRoute;
        }
    }
}

// ---- Embedded --------------------------------------------------------------

class EmbeddedSerializer extends ModifiableSerializer {
    toJson(value: unknown, sc: SerializationContext, writeType: boolean): unknown {
        const em = value as EmbeddedEntity;
        const o: Record<string, unknown> = {};
        if (writeType) o.$type = cleanTypeName(em.constructor);
        if (isModifiedSelf(em)) o.modified = true;
        // An embedded continues the owner's route (set by the parent's serializeFields in sc.route); the
        // root entity's authMeta stays in effect (routes are keyed from the root).
        this.serializeFields(em, sc, o, false, sc.route);
        return o;
    }
    fromJson(json: unknown, dc: DeserializationContext, existing: unknown): unknown {
        const j = json as Record<string, unknown>;
        const inst = (existing instanceof EmbeddedEntity && existing.constructor === this.ctor)
            ? existing
            : new (this.ctor as Type<EmbeddedEntity>)();
        // Continue the owner's route (set by the parent applyFields in dc.route) so the write gate applies
        // to embedded sub-properties too — but only when overlaying an existing embedded (dc.route set).
        this.applyFields(inst, j, dc, dc.route);
        inst._snapshot = j.modified === true ? true : undefined;
        return inst;
    }
}

// ---- Entity ----------------------------------------------------------------

class EntitySerializer extends ModifiableSerializer {
    toJson(value: unknown, sc: SerializationContext, writeType: boolean, parented = false): unknown {
        const entity = value as Entity;
        if (sc.path.has(entity))
            throw new Error(`Cycle detected serializing ${entity.constructor.name} (id=${String(entity.id)}); break entity reference cycles with a Lite<T>.`);
        sc.path.add(entity);
        try {
            const o: Record<string, unknown> = {};
            if (writeType) o.$type = cleanTypeName(entity.constructor);
            o.id = entity.id ?? null;
            if (entity.ticks != null) o.ticks = entity.ticks;
            o.toStr = entity.toString();
            if (isModifiedSelf(entity)) o.modified = true;
            // A (re-rooted) entity computes its OWN property-auth metadata (per Signum's IRootEntity step).
            const prevMeta = sc.authMeta;
            const ownerRoute = _serAuth != null ? PropertyRoute.root(entity.constructor) : undefined;
            if (_serAuth != null) sc.authMeta = _serAuth.getMetadata(entity);
            this.serializeFields(entity, sc, o, parented, ownerRoute);
            sc.authMeta = prevMeta;
            return o;
        } finally {
            sc.path.delete(entity);
        }
    }

    fromJson(json: unknown, dc: DeserializationContext, existing: unknown, slot?: Slot): unknown {
        const j = json as Record<string, unknown>;
        // Concrete-type delegation: an Always-mode or subtype `$type` routes to that serializer.
        const wire = j.$type as string | undefined;
        if (wire != null) {
            const concrete = resolveWireType(wire);
            if (concrete != null && concrete !== this.ctor)
                return factory.forEntity(concrete as Type<BaseEntity>).fromJson(j, dc, existing, slot);
        }

        const id = (j.id === undefined ? null : j.id) as PrimaryKey | null;
        const modified = j.modified === true;

        // New entity: build; _snapshot stays `true` (modified), like create()/new.
        if (id == null) {
            const inst = new (this.ctor as Type<Entity>)();
            this.applyFields(inst, j, dc);
            this.recover(inst, slot);
            return inst;
        }

        const key = this.ctor.name + '|' + String(id);
        const cached = dc.idMap.get(key);
        if (cached != null) return cached;   // intra-payload identity

        // Reuse an original: an existing-graph instance with the same Type+id, else resolve().
        let original: Entity | undefined | null;
        if (existing instanceof Entity && existing.constructor === this.ctor && existing.id === id)
            original = existing;
        else if (dc.resolve != null)
            original = dc.resolve(cleanTypeName(this.ctor), id);

        if (original != null) {
            dc.idMap.set(key, original);
            if (modified) {
                // Overlay onto the DB original → the write gate applies (a changed non-writable property is
                // rejected). Metadata is the ORIGINAL's (its type conditions), computed once per root.
                const prevMeta = dc.authMeta;
                const ownerRoute = _serAuth != null ? PropertyRoute.root(this.ctor) : undefined;
                if (_serAuth != null) dc.authMeta = _serAuth.getMetadata(original);
                this.applyFields(original, j, dc, ownerRoute);   // overlay; snapshot untouched ⇒ isModifiedSelf reflects it
                dc.authMeta = prevMeta;
                this.recover(original, slot);
            } else {
                this.checkClean(j, original, dc);    // don't apply; trip the wire on mismatch
            }
            return original;
        }

        // No baseline (client-receive path): build fresh with the id, then seed the snapshot.
        const inst = new (this.ctor as Type<Entity>)();
        inst.id = id;
        inst.isNew = false;
        if (j.ticks != null) inst.ticks = j.ticks as number;
        dc.idMap.set(key, inst);
        this.applyFields(inst, j, dc);
        this.recover(inst, slot);
        // `modified: true` → the `true` sentinel (unconditionally dirty). Otherwise seed a REAL clean
        // baseline (getSnapshot), NOT the `undefined` "unconditionally clean" sentinel: the client has
        // no change-tracking setters (unlike Signum), so a loaded entity is only diff-trackable if it
        // carries a projection to compare later edits against. With `undefined` an edited field never
        // flips isModifiedSelf, so the client would send no `modified` flag and the save would persist
        // nothing. Equivalent to the server's cleanModified() after a DB retrieve.
        inst._snapshot = modified ? true : getSnapshot(inst);
        return inst;
    }

    // Recover a part-entity element's @backReference (← owner fat lite) and @rowOrder
    // (← array index). Only for collection elements — `slot.index != null` marks them; a
    // plain reference field carries an owner but no index, so nothing is recovered.
    private recover(inst: Entity, slot?: Slot): void {
        if (slot?.owner == null || slot.index == null) return;
        const target = inst as unknown as Record<string, unknown>;
        for (const entry of this.plan) {
            if (entry.isBackReference) target[entry.name] = slot.owner.toLite(true);
            else if (entry.isRowOrder) target[entry.name] = toInt(slot.index);
        }
    }

    // Not-modified consistency tripwire: build the incoming payload in isolation and diff its
    // projection against the resolved original's clean baseline. Never changes data.
    private checkClean(json: Record<string, unknown>, original: Entity, dc: DeserializationContext): void {
        const snap = original._snapshot;
        if (snap == null || snap === true) return;   // no real baseline to compare against
        const pure = this.fromJson(json, { idMap: new Map() }, undefined) as Entity;
        if (!snapshotEqual(getSnapshot(pure), snap)) {
            const msg = `deserialize: ${cleanTypeName(this.ctor)} (id=${String(json.id)}) arrived without "modified" but its values differ from the resolved entity; changes were NOT applied.`;
            (dc.onWarn ?? ((m: string) => console.warn(m)))(msg);
        }
    }
}

// ---- Owned part-entity collection (Altea's MList: `Child[]`) ----------------

class PartCollectionSerializer implements JsonSerializer {
    constructor(private readonly element: EntitySerializer) { }

    toJson(value: unknown, sc: SerializationContext, writeType: boolean): unknown {
        return (value as unknown[]).map(el => el == null ? null : this.element.toJson(el, sc, writeType, /* parented */ true));
    }

    fromJson(json: unknown, dc: DeserializationContext, existing: unknown, slot?: Slot): unknown {
        const owner = slot?.owner;
        // Index existing elements by Type+id so a moved element is reused (not rebuilt),
        // preserving its identity and clean snapshot.
        const byId = new Map<string, Entity>();
        if (Array.isArray(existing))
            for (const el of existing)
                if (el instanceof Entity && el.id != null)
                    byId.set(el.constructor.name + '|' + String(el.id), el);

        return (json as unknown[]).map((elJson, i) => {
            const ej = elJson as Record<string, unknown>;
            const elCtor = ej.$type != null ? resolveWireType(ej.$type as string) : this.element.ctor;
            const elId = ej.id;
            const existingEl = (elId != null && elCtor != null) ? byId.get(elCtor.name + '|' + String(elId)) : undefined;
            return this.element.fromJson(ej, dc, existingEl, { owner, index: i });
        });
    }
}

// ---- Dynamic (runtime-dispatched) — top level, dict values, untyped @column(false) fields ---------

class DynamicSerializer implements JsonSerializer {
    toJson(value: unknown, sc: SerializationContext, _writeType?: boolean, _parented?: boolean): unknown {
        if (value == null) return null;
        if (value instanceof Lite) return LITE_DYNAMIC.toJson(value, sc, true);
        if (value instanceof Entity) return factory.forEntity(value.constructor as Type<BaseEntity>).toJson(value, sc, true);
        // EmbeddedEntity and ModelEntity are both id-less modifiables — serialize both via forEmbedded.
        if (value instanceof EmbeddedEntity || value instanceof ModelEntity) return factory.forEmbedded(value.constructor as Type<BaseEntity>).toJson(value, sc, true);
        if (isTemporal(value)) return (value as { toString(): string }).toString();
        if (value instanceof Decimal) return value.toString();
        if (value instanceof Date) return value.toISOString();
        if (Array.isArray(value)) return value.map(v => this.toJson(v, sc));
        if (typeof value === 'object') {
            const o: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) o[k] = this.toJson(v, sc);
            return o;
        }
        return value;
    }

    fromJson(json: unknown, dc: DeserializationContext, existing: unknown): unknown {
        if (json == null) return null;
        if (Array.isArray(json)) return json.map(v => this.fromJson(v, dc, undefined));
        if (typeof json === 'object') {
            const j = json as Record<string, unknown>;
            if ('$lite' in j) return LITE_DYNAMIC.fromJson(j, dc, existing);
            if ('$type' in j) {
                const ctor = resolveWireType(j.$type as string);
                if (ctor == null) throw new Error(`Cannot deserialize: unknown type "${String(j.$type)}"`);
                return factory.forCtor(ctor as Type<BaseEntity>).fromJson(j, dc, existing);
            }
            const o: Record<string, unknown> = {};   // plain dictionary of roots
            for (const [k, v] of Object.entries(j)) o[k] = this.fromJson(v, dc, undefined);
            return o;
        }
        return json;
    }
}

// ---- Factory ---------------------------------------------------------------

const EXCLUDED_FIELD_NAMES = new Set(['id', 'ticks']);   // serialized specially by EntitySerializer

class SerializerFactory {
    private readonly entityCache = new Map<Type<BaseEntity>, EntitySerializer>();
    private readonly embeddedCache = new Map<Type<BaseEntity>, EmbeddedSerializer>();
    readonly dynamic = new DynamicSerializer();

    forEntity(ctor: Type<BaseEntity>): EntitySerializer {
        let s = this.entityCache.get(ctor);
        if (s != null) return s;
        s = new EntitySerializer(ctor);
        this.entityCache.set(ctor, s);   // cache BEFORE building the plan (recursive/cyclic types)
        s.plan = this.buildPlan(ctor);
        return s;
    }

    forEmbedded(ctor: Type<BaseEntity>): EmbeddedSerializer {
        let s = this.embeddedCache.get(ctor);
        if (s != null) return s;
        s = new EmbeddedSerializer(ctor);
        this.embeddedCache.set(ctor, s);
        s.plan = this.buildPlan(ctor);
        return s;
    }

    forCtor(ctor: Type<BaseEntity>): ModifiableSerializer {
        return ctorIsEmbedded(ctor) ? this.forEmbedded(ctor) : this.forEntity(ctor);
    }

    // Precompute a modifiable's field plan: every reflected field (own + mixin, including
    // @column(false) ones) except @serialize(false) and the specially-handled id/ticks.
    private buildPlan(ctor: Type<BaseEntity>): FieldPlan[] {
        const plan: FieldPlan[] = [];
        eachFieldInfo(ctor, fi => {
            if (fi.noSerialize || EXCLUDED_FIELD_NAMES.has(fi.name)) return;
            plan.push({
                name: fi.name,
                serializer: this.serializerFor(fi),
                isBackReference: fi.isBackReference === true,
                isRowOrder: fi.isRowOrder === true,
            });
        });
        return plan;
    }

    // The serializer for a field's value, including the array wrapper.
    private serializerFor(fi: FieldInfo): JsonSerializer {
        if (!fi.array) return this.elementSerializer(fi);
        const element = this.elementSerializer(fi);
        // A `Child[]` of owned part entities gets identity reconciliation + back-ref/order
        // recovery; `Lite<T>[]` / value arrays are plain element-wise maps.
        return element instanceof EntitySerializer ? new PartCollectionSerializer(element) : new ArraySerializer(element);
    }

    // The serializer for a single (non-array) value.
    private elementSerializer(fi: FieldInfo): JsonSerializer {
        if (fi.isEnum) {
            const e = fi.getEnum() as Record<string, string | number> | undefined;
            if (e == null) throw new Error(`Cannot build serializer: enum field '${fi.name}' is not registered`);
            return new EnumSerializer(e);
        }
        if (fi.lite) {
            // A polymorphic lite (@implementedByAll / @implementedBy) has no single concrete type, so its
            // serializer must be polymorphic (expectedCtor undefined) — otherwise it takes the DECLARED base
            // (`Lite<Entity>` ⇒ Entity) as the expected type and never emits the `$lite` discriminator, so the
            // reader can't recover the target type (Entity isn't a persistable type: TypeLogic.typeToId throws).
            const ctor = fi.implementations != null ? undefined : fi.getFunction();
            return new LiteSerializer(ctor, fi.customLite);   // undefined ctor ⇒ polymorphic lite
        }
        if (fi.implementations != null) return new PolyReferenceSerializer();

        const ctor = fi.getFunction();
        if (ctor != null && ctorIsEntity(ctor)) return this.forEntity(ctor as Type<BaseEntity>);
        if (ctor != null && ctorIsEmbedded(ctor)) return this.forEmbedded(ctor as Type<BaseEntity>);

        if (fi.typeName != null && TEMPORAL_TYPE_NAMES.has(fi.typeName)) return new TemporalSerializer(fi.typeName);
        if (fi.typeName === 'Decimal') return DecimalSerializer;
        if (fi.typeName === 'Date') return DateSerializer;
        if (fi.typeName != null) return ValueSerializer;   // Number / String / Boolean
        return this.dynamic;                               // untyped @column(false) field
    }
}

const factory = new SerializerFactory();
const LITE_DYNAMIC = new LiteSerializer(undefined);

// ---- Public API ------------------------------------------------------------

// The entity-graph JSON codec. Named to mirror the built-in `JSON` object — `stringify` / `parse`
// — and kept distinct from the `@serialize(false)` field decorator (which only toggles whether a
// field is included here).
export const Serializer = {
    /**
     * Serialize an entity graph, a `Lite<T>`, an array, or a plain object of such values to a
     * JSON string. Discriminators follow `options.writeTypes` (default "Auto").
     */
    stringify(obj: unknown, options?: SerializeOptions): string {
        const sc: SerializationContext = { writeTypes: options?.writeTypes ?? 'Auto', path: new Set(), authContext: options?.authContext };
        return JSON.stringify(factory.dynamic.toJson(obj, sc, true));
    },

    /**
     * Parse a JSON string produced by {@link stringify} back into real entity / lite / value
     * instances. Pass `options.resolve` for the retrieve-and-apply (server) path.
     */
    parse(json: string, options?: DeserializeOptions): unknown {
        const dc: DeserializationContext = { idMap: new Map(), resolve: options?.resolve, onWarn: options?.onWarn, authContext: options?.authContext };
        return factory.dynamic.fromJson(JSON.parse(json), dc, undefined);
    },
};
