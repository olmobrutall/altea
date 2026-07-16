
// JSON serialization of the entity graph — the wire format between an altea server and
// an altea React client. Isomorphic and reflection-driven (like ./changes.ts): reads only
// reflection metadata + runtime types, imports nothing from the logic/ (DB) layer, and
// rebuilds real class instances on either end via the type registry.
//
// Modular design: one `Serializer` per kind (ValueSerializer, TemporalSerializer,
// DecimalSerializer, DateSerializer, EnumSerializer, LiteSerializer, ArraySerializer,
// PartCollectionSerializer, EmbeddedSerializer, EntitySerializer, PolyReferenceSerializer,
// DynamicSerializer). A `SerializerFactory` resolves the serializer for each field once and
// caches a per-entity-type `EntitySerializer` whose field plan is PRECOMPUTED from
// reflection — so serialize/deserialize never re-walk metadata per call.
//
// Wire shapes (clean type names as the `$type`/`$lite` discriminators):
//   entity    { "$type": "Album", "id": 1, "ticks": 3, "toStr": "…", "modified": true, …fields }
//   embedded  { "$type": "SongEmbedded", …fields }                       (no id/ticks/toStr)
//   lite      { "$lite": "Artist", "id": 7, "toStr": "…", …custom fields, "entity"?: {…} }
//   collection  plain array of part-entity objects (@backReference/@rowOrder recovered on read)
//   enum        member-name string;  Temporal.*/Decimal  string;  number/string/bool  as-is
//
// writeTypes: "Always" writes every discriminator; "Auto" writes them only for roots and
// @implementedBy(All) references (everything else is inferred from the field's serializer).
//
// Field selection: every reflected field is serialized (including @column(false) ones) EXCEPT
// those marked @serialize(false); `id`/`ticks` are handled specially by EntitySerializer.

import { Entity, EmbeddedEntity, typeConstructor } from './entity';
import type { Type, PrimaryKey, BaseEntity } from './entity';
import { Lite, LiteImp } from './lite';
import { isModifiedSelf, project, snapshotEqual } from './changes';
import { fieldType, fieldEnum, getTypeInfo } from './reflection';
import type { FieldInfo } from './reflection';
import { resolveCleanType, cleanTypeName } from './registration';
import { MixinDeclarations } from './mixinDeclarations';
import { Temporal, Decimal, toInt } from './basics';

// ---- Options & contexts ----------------------------------------------------

export type WriteTypes = 'Always' | 'Auto';

export interface SerializeOptions {
    /** Discriminator verbosity; defaults to "Auto". */
    writeTypes?: WriteTypes;
}

export interface DeserializeOptions {
    /**
     * Supplies the authoritative "original" for an existing entity (id present) so the codec
     * applies onto it — overlaying when `modified`, else keeping it and warning on a baseline
     * mismatch. The returned entity is assumed to carry its clean snapshot. Omit for the
     * client-receive path (build fresh + seed the snapshot from the `modified` flag).
     */
    resolve?: (typeName: string, id: PrimaryKey) => Entity | undefined | null;
    /** Overrides the default console.warn for the not-modified consistency tripwire. */
    onWarn?: (message: string) => void;
}

interface SerContext {
    writeTypes: WriteTypes;
    path: Set<BaseEntity>;   // cycle guard for full-entity references
}

interface DesContext {
    idMap: Map<string, Entity>;   // intra-payload identity, keyed "TypeName|id"
    resolve?: DeserializeOptions['resolve'];
    onWarn?: DeserializeOptions['onWarn'];
}

// The containing entity for a value being deserialized. `index != null` marks a part-entity
// collection element (so its @backReference/@rowOrder get recovered from the owner + index).
interface Slot {
    owner?: Entity;
    index?: number;
}

interface Serializer {
    toJson(value: unknown, sc: SerContext, writeType: boolean, parented?: boolean): unknown;
    fromJson(json: unknown, dc: DesContext, existing: unknown, slot?: Slot): unknown;
}

// ---- Custom lite registry --------------------------------------------------

// A custom lite carries display fields directly on the lite instance (altea has no separate
// "model"). Multiple may be registered per entity type; on read the first whose
// isCompatible(json) returns true is chosen, else a plain LiteImp.
export interface CustomLiteClass {
    isCompatible(json: Record<string, unknown>): boolean;
    fromJson(json: Record<string, unknown>): Lite<Entity>;
}

const customLiteRegistry = new Map<Function, CustomLiteClass[]>();

/** Registers a custom lite class for an entity type (registration order = match order). */
export function registerCustomLite(entityType: Type<Entity>, liteClass: CustomLiteClass): void {
    const ctor = typeConstructor(entityType);
    const arr = customLiteRegistry.get(ctor) ?? [];
    arr.push(liteClass);
    customLiteRegistry.set(ctor, arr);
}

// ---- Shared helpers --------------------------------------------------------

function ctorIsEntity(ctor: Function): boolean {
    return ctor === Entity || ctor.prototype instanceof Entity;
}

function ctorIsEmbedded(ctor: Function): boolean {
    return ctor === EmbeddedEntity || ctor.prototype instanceof EmbeddedEntity;
}

const TEMPORAL_TYPE_NAMES: ReadonlySet<string> = new Set([
    'PlainDate', 'PlainDateTime', 'PlainTime', 'Duration',
    'Instant', 'ZonedDateTime', 'PlainYearMonth', 'PlainMonthDay',
]);

const TEMPORAL_CTORS = [
    Temporal.PlainDate, Temporal.PlainDateTime, Temporal.PlainTime, Temporal.Duration,
    Temporal.Instant, Temporal.ZonedDateTime, Temporal.PlainYearMonth, Temporal.PlainMonthDay,
];

function isTemporal(v: unknown): boolean {
    return TEMPORAL_CTORS.some(c => v instanceof (c as unknown as Function));
}

function temporalFrom(name: string, s: string): unknown {
    switch (name) {
        case 'PlainDate': return Temporal.PlainDate.from(s);
        case 'PlainDateTime': return Temporal.PlainDateTime.from(s);
        case 'PlainTime': return Temporal.PlainTime.from(s);
        case 'Duration': return Temporal.Duration.from(s);
        case 'Instant': return Temporal.Instant.from(s);
        case 'ZonedDateTime': return Temporal.ZonedDateTime.from(s);
        case 'PlainYearMonth': return Temporal.PlainYearMonth.from(s);
        case 'PlainMonthDay': return Temporal.PlainMonthDay.from(s);
        default: return s;
    }
}

// Enum <-> member name. Works for numeric enums (reverse map built by TS) and string enums.
function enumMemberName(enumObj: Record<string, unknown>, value: unknown): string {
    const reverse = enumObj[value as string];
    if (typeof reverse === 'string') return reverse;   // numeric enum: enumObj[0] === "Male"
    for (const k of Object.keys(enumObj))
        if (enumObj[k] === value) return k;
    return String(value);
}

function enumMemberValue(enumObj: Record<string, unknown>, name: string): unknown {
    return enumObj[name];
}

function safeToString(m: { toString(): string }): string | undefined {
    try { return m.toString(); } catch { return undefined; }
}

// ---- Leaf serializers ------------------------------------------------------

const ValueSerializer: Serializer = {
    toJson: v => v,
    fromJson: j => j,
};

class TemporalSerializer implements Serializer {
    constructor(private readonly kind: string) { }
    toJson(v: unknown): unknown { return (v as { toString(): string }).toString(); }
    fromJson(j: unknown): unknown { return temporalFrom(this.kind, j as string); }
}

const DecimalSerializer: Serializer = {
    toJson: v => (v as Decimal).toString(),
    fromJson: j => new Decimal(j as Decimal.Value),
};

const DateSerializer: Serializer = {
    toJson: v => (v as Date).toISOString(),
    fromJson: j => new Date(j as string),
};

class EnumSerializer implements Serializer {
    constructor(private readonly enumObj: Record<string, unknown>) { }
    toJson(v: unknown): unknown { return enumMemberName(this.enumObj, v); }
    fromJson(j: unknown): unknown { return enumMemberValue(this.enumObj, j as string); }
}

// A plain (non-part) collection: `Lite<T>[]` or a value array. Maps element-wise; no
// identity reconciliation (that is PartCollectionSerializer's job for owned part entities).
class ArraySerializer implements Serializer {
    constructor(private readonly element: Serializer) { }
    toJson(value: unknown, sc: SerContext, writeType: boolean): unknown {
        return (value as unknown[]).map(v => v == null ? null : this.element.toJson(v, sc, writeType));
    }
    fromJson(json: unknown, dc: DesContext): unknown {
        return (json as unknown[]).map(v => v == null ? null : this.element.fromJson(v, dc, undefined));
    }
}

// ---- Lite ------------------------------------------------------------------

const LITE_RESERVED_KEYS = new Set(['id', 'entityType', 'toStr', '_entity']);

// `expectedCtor` is the declared target entity type (undefined for a polymorphic
// `Lite<Entity>` / `@implementedBy` lite — which then always carries `$lite` on the wire).
class LiteSerializer implements Serializer {
    constructor(private readonly expectedCtor: Function | undefined) { }

    toJson(value: unknown, sc: SerContext, writeType: boolean): unknown {
        const lite = value as Lite<Entity>;
        const o: Record<string, unknown> = {};
        if (writeType || sc.writeTypes === 'Always' || this.expectedCtor == null)
            o.$lite = cleanTypeName(typeConstructor(lite.entityType));
        o.id = lite.id ?? null;
        const toStr = safeToString(lite);
        if (toStr != null) o.toStr = toStr;
        for (const key of Object.keys(lite)) {           // custom-lite display fields, flat
            if (LITE_RESERVED_KEYS.has(key)) continue;
            o[key] = factory.dynamic.toJson((lite as unknown as Record<string, unknown>)[key], sc, false);
        }
        const entity = lite.entityOrNull;
        if (entity != null)   // fat lite — the entity's type is the lite's, so Auto omits $type
            o.entity = factory.forEntity(entity.constructor as Function).toJson(entity, sc, sc.writeTypes === 'Always');
        return o;
    }

    fromJson(json: unknown, dc: DesContext, _existing?: unknown, _slot?: Slot): unknown {
        const j = json as Record<string, unknown>;
        const wire = j.$lite as string | undefined;
        const ctor = wire != null ? resolveCleanType(wire) : this.expectedCtor;
        if (ctor == null)
            throw new Error(wire != null
                ? `Cannot deserialize lite: unknown type "${wire}"`
                : 'Cannot deserialize lite: no $lite discriminator and no field context');

        const id = (j.id === undefined ? null : j.id) as PrimaryKey;
        let lite: Lite<Entity> | undefined;
        for (const candidate of customLiteRegistry.get(ctor) ?? [])
            if (candidate.isCompatible(j)) { lite = candidate.fromJson(j); break; }
        lite ??= new LiteImp(id, ctor as Type<Entity>, (j.toStr as string | undefined) ?? '');

        if (j.entity != null)
            lite.setEntity(factory.forEntity(ctor).fromJson(j.entity, dc, undefined) as Entity);
        return lite;
    }
}

// ---- Polymorphic full-entity reference (@implementedBy / @implementedByAll, non-lite) ------

class PolyReferenceSerializer implements Serializer {
    toJson(value: unknown, sc: SerContext): unknown {
        const entity = value as Entity;
        return factory.forEntity(entity.constructor as Function).toJson(entity, sc, /* writeType */ true);
    }
    fromJson(json: unknown, dc: DesContext, existing: unknown, slot?: Slot): unknown {
        const j = json as Record<string, unknown>;
        const ctor = resolveCleanType(j.$type as string);
        if (ctor == null) throw new Error(`Cannot deserialize polymorphic reference: unknown type "${String(j.$type)}"`);
        return factory.forEntity(ctor).fromJson(j, dc, existing, slot);
    }
}

// ---- Modifiable base (shared entity/embedded field-plan machinery) ---------

interface FieldPlan {
    name: string;
    serializer: Serializer;
    isBackReference: boolean;
    isRowOrder: boolean;
}

abstract class ModifiableSerializer implements Serializer {
    plan: FieldPlan[] = [];   // precomputed by the factory (see build)
    constructor(readonly ctor: Function) { }

    abstract toJson(value: unknown, sc: SerContext, writeType: boolean, parented?: boolean): unknown;
    abstract fromJson(json: unknown, dc: DesContext, existing: unknown, slot?: Slot): unknown;

    protected serializeFields(m: BaseEntity, sc: SerContext, o: Record<string, unknown>, parented: boolean): void {
        const fieldWriteType = sc.writeTypes === 'Always';
        for (const entry of this.plan) {
            if (parented && (entry.isBackReference || entry.isRowOrder)) continue;   // recoverable
            const v = (m as unknown as Record<string, unknown>)[entry.name];
            o[entry.name] = v == null ? null : entry.serializer.toJson(v, sc, fieldWriteType);
        }
    }

    protected applyFields(m: BaseEntity, json: Record<string, unknown>, dc: DesContext): void {
        const target = m as unknown as Record<string, unknown>;
        for (const entry of this.plan) {
            if (!Object.prototype.hasOwnProperty.call(json, entry.name)) continue;
            const jv = json[entry.name];
            target[entry.name] = jv == null
                ? null
                : entry.serializer.fromJson(jv, dc, target[entry.name], { owner: m as Entity });
        }
    }
}

// ---- Embedded --------------------------------------------------------------

class EmbeddedSerializer extends ModifiableSerializer {
    toJson(value: unknown, sc: SerContext, writeType: boolean): unknown {
        const em = value as EmbeddedEntity;
        const o: Record<string, unknown> = {};
        if (writeType) o.$type = cleanTypeName(em.constructor);
        if (isModifiedSelf(em)) o.modified = true;
        this.serializeFields(em, sc, o, false);
        return o;
    }
    fromJson(json: unknown, dc: DesContext, existing: unknown): unknown {
        const j = json as Record<string, unknown>;
        const inst = (existing instanceof EmbeddedEntity && existing.constructor === this.ctor)
            ? existing
            : new (this.ctor as new () => EmbeddedEntity)();
        this.applyFields(inst, j, dc);
        inst._snapshot = j.modified === true ? true : undefined;
        return inst;
    }
}

// ---- Entity ----------------------------------------------------------------

class EntitySerializer extends ModifiableSerializer {
    toJson(value: unknown, sc: SerContext, writeType: boolean, parented = false): unknown {
        const entity = value as Entity;
        if (sc.path.has(entity))
            throw new Error(`Cycle detected serializing ${entity.constructor.name} (id=${String(entity.id)}); break entity reference cycles with a Lite<T>.`);
        sc.path.add(entity);
        try {
            const o: Record<string, unknown> = {};
            if (writeType) o.$type = cleanTypeName(entity.constructor);
            o.id = entity.id ?? null;
            if (entity.ticks != null) o.ticks = entity.ticks;
            const toStr = safeToString(entity);
            if (toStr != null) o.toStr = toStr;
            if (isModifiedSelf(entity)) o.modified = true;
            this.serializeFields(entity, sc, o, parented);
            return o;
        } finally {
            sc.path.delete(entity);
        }
    }

    fromJson(json: unknown, dc: DesContext, existing: unknown, slot?: Slot): unknown {
        const j = json as Record<string, unknown>;
        // Concrete-type delegation: an Always-mode or subtype `$type` routes to that serializer.
        const wire = j.$type as string | undefined;
        if (wire != null) {
            const concrete = resolveCleanType(wire);
            if (concrete != null && concrete !== this.ctor)
                return factory.forEntity(concrete).fromJson(j, dc, existing, slot);
        }

        const id = (j.id === undefined ? null : j.id) as PrimaryKey | null;
        const modified = j.modified === true;

        // New entity: build; _snapshot stays `true` (modified), like create()/new.
        if (id == null) {
            const inst = new (this.ctor as new () => Entity)();
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
                this.applyFields(original, j, dc);   // overlay; snapshot untouched ⇒ isModifiedSelf reflects it
                this.recover(original, slot);
            } else {
                this.checkClean(j, original, dc);    // don't apply; trip the wire on mismatch
            }
            return original;
        }

        // No baseline (client-receive path): build fresh with the id, seed the snapshot sentinel.
        const inst = new (this.ctor as new () => Entity)();
        inst.id = id;
        inst.isNew = false;
        if (j.ticks != null) inst.ticks = j.ticks as number;
        dc.idMap.set(key, inst);
        this.applyFields(inst, j, dc);
        this.recover(inst, slot);
        inst._snapshot = modified ? true : undefined;
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
    private checkClean(json: Record<string, unknown>, original: Entity, dc: DesContext): void {
        const snap = original._snapshot;
        if (snap == null || snap === true) return;   // no real baseline to compare against
        const pure = this.fromJson(json, { idMap: new Map() }, undefined) as Entity;
        if (!snapshotEqual(project(pure), snap)) {
            const msg = `deserialize: ${cleanTypeName(this.ctor)} (id=${String(json.id)}) arrived without "modified" but its values differ from the resolved entity; changes were NOT applied.`;
            (dc.onWarn ?? ((m: string) => console.warn(m)))(msg);
        }
    }
}

// ---- Owned part-entity collection (Altea's MList: `Child[]`) ----------------

class PartCollectionSerializer implements Serializer {
    constructor(private readonly element: EntitySerializer) { }

    toJson(value: unknown, sc: SerContext, writeType: boolean): unknown {
        return (value as unknown[]).map(el => el == null ? null : this.element.toJson(el, sc, writeType, /* parented */ true));
    }

    fromJson(json: unknown, dc: DesContext, existing: unknown, slot?: Slot): unknown {
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
            const elCtor = ej.$type != null ? resolveCleanType(ej.$type as string) : this.element.ctor;
            const elId = ej.id;
            const existingEl = (elId != null && elCtor != null) ? byId.get(elCtor.name + '|' + String(elId)) : undefined;
            return this.element.fromJson(ej, dc, existingEl, { owner, index: i });
        });
    }
}

// ---- Dynamic (runtime-dispatched) — top level, dict values, untyped @column(false) fields ---------

class DynamicSerializer implements Serializer {
    toJson(value: unknown, sc: SerContext, _writeType?: boolean, _parented?: boolean): unknown {
        if (value == null) return null;
        if (value instanceof Lite) return LITE_DYNAMIC.toJson(value, sc, true);
        if (value instanceof Entity) return factory.forEntity(value.constructor as Function).toJson(value, sc, true);
        if (value instanceof EmbeddedEntity) return factory.forEmbedded(value.constructor as Function).toJson(value, sc, true);
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

    fromJson(json: unknown, dc: DesContext, existing: unknown): unknown {
        if (json == null) return null;
        if (Array.isArray(json)) return json.map(v => this.fromJson(v, dc, undefined));
        if (typeof json === 'object') {
            const j = json as Record<string, unknown>;
            if ('$lite' in j) return LITE_DYNAMIC.fromJson(j, dc, existing);
            if ('$type' in j) {
                const ctor = resolveCleanType(j.$type as string);
                if (ctor == null) throw new Error(`Cannot deserialize: unknown type "${String(j.$type)}"`);
                return factory.forCtor(ctor).fromJson(j, dc, existing);
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
    private readonly entityCache = new Map<Function, EntitySerializer>();
    private readonly embeddedCache = new Map<Function, EmbeddedSerializer>();
    readonly dynamic = new DynamicSerializer();

    forEntity(ctor: Function): EntitySerializer {
        let s = this.entityCache.get(ctor);
        if (s != null) return s;
        s = new EntitySerializer(ctor);
        this.entityCache.set(ctor, s);   // cache BEFORE building the plan (recursive/cyclic types)
        s.plan = this.buildPlan(ctor);
        return s;
    }

    forEmbedded(ctor: Function): EmbeddedSerializer {
        let s = this.embeddedCache.get(ctor);
        if (s != null) return s;
        s = new EmbeddedSerializer(ctor);
        this.embeddedCache.set(ctor, s);
        s.plan = this.buildPlan(ctor);
        return s;
    }

    forCtor(ctor: Function): ModifiableSerializer {
        return ctorIsEmbedded(ctor) ? this.forEmbedded(ctor) : this.forEntity(ctor);
    }

    // Precompute a modifiable's field plan: every reflected field (own + mixin, including
    // @column(false) ones) except @serialize(false) and the specially-handled id/ticks.
    private buildPlan(ctor: Function): FieldPlan[] {
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
    private serializerFor(fi: FieldInfo): Serializer {
        if (!fi.array) return this.elementSerializer(fi);
        const element = this.elementSerializer(fi);
        // A `Child[]` of owned part entities gets identity reconciliation + back-ref/order
        // recovery; `Lite<T>[]` / value arrays are plain element-wise maps.
        return element instanceof EntitySerializer ? new PartCollectionSerializer(element) : new ArraySerializer(element);
    }

    // The serializer for a single (non-array) value.
    private elementSerializer(fi: FieldInfo): Serializer {
        if (fi.isEnum) {
            const e = fieldEnum(fi) as Record<string, unknown> | undefined;
            if (e == null) throw new Error(`Cannot build serializer: enum field '${fi.name}' is not registered`);
            return new EnumSerializer(e);
        }
        if (fi.lite) return new LiteSerializer(fieldType(fi));         // undefined ctor ⇒ polymorphic lite
        if (fi.implementations != null) return new PolyReferenceSerializer();

        const ctor = fieldType(fi);
        if (ctor != null && ctorIsEntity(ctor)) return this.forEntity(ctor);
        if (ctor != null && ctorIsEmbedded(ctor)) return this.forEmbedded(ctor);

        if (fi.typeName != null && TEMPORAL_TYPE_NAMES.has(fi.typeName)) return new TemporalSerializer(fi.typeName);
        if (fi.typeName === 'Decimal') return DecimalSerializer;
        if (fi.typeName === 'Date') return DateSerializer;
        if (fi.typeName != null) return ValueSerializer;   // Number / String / Boolean
        return this.dynamic;                               // untyped @column(false) field
    }
}

const factory = new SerializerFactory();
const LITE_DYNAMIC = new LiteSerializer(undefined);

// A ctor-based iterator over a modifiable's reflected fields — own + inherited (the reflection
// metadata copies base fields into each subclass) + mixin. No instance needed, so the plan is
// precomputed per type. (Distinct from changes.forEachField, which needs an instance and skips
// @column(false)/reserved fields — the codec serializes @column(false) fields.)
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

// ---- Public API ------------------------------------------------------------

export function serialize(obj: unknown, options?: SerializeOptions): string {
    const sc: SerContext = { writeTypes: options?.writeTypes ?? 'Auto', path: new Set() };
    return JSON.stringify(factory.dynamic.toJson(obj, sc, true));
}

export function deserialize(json: string, options?: DeserializeOptions): unknown {
    const dc: DesContext = { idMap: new Map(), resolve: options?.resolve, onWarn: options?.onWarn };
    return factory.dynamic.fromJson(JSON.parse(json), dc, undefined);
}
