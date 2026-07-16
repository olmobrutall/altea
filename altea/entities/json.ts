
// JSON serialization of the entity graph — the wire format between an altea server and
// an altea React client. Isomorphic and reflection-driven (like ./changes.ts): it reads
// only FieldInfo metadata + runtime types, imports nothing from the logic/ (DB) layer,
// and rebuilds real class instances on either end via the type registry (resolveType).
//
// Wire shapes (fresh format, self-describing):
//   entity    { "$type": "AlbumEntity", "id": 1, "ticks": 3, "toStr": "…", "modified": true, …fields }
//   embedded  { "$type": "SongEmbedded", …fields }                       (no id/ticks/toStr)
//   lite      { "$lite": "ArtistEntity", "id": 7, "toStr": "…", …custom-lite fields, "entity"?: {…} }
//   collection  plain array of part-entity objects
//   enum        member-name string;  Temporal.*/Decimal  ISO/decimal string;  number/string/bool  as-is
//
// writeTypes:
//   "Always" — every entity/embedded writes $type, every lite $lite (fully explicit).
//   "Auto"   — $type/$lite only for ROOTS (values whose type isn't fixed by an enclosing
//              entity field) and @implementedBy(All) fields; everything else is inferred
//              from the field's FieldInfo on read.
//
// A part-entity serialized inside its owner's collection omits its @backReference and
// @rowOrder (recoverable from context) in BOTH modes; the deserializer recovers them
// (back-ref ← owner's fat lite, order ← array index).
//
// The `modified` flag rides the wire (emitted when isModifiedSelf) and round-trips through
// the snapshot (see ./changes): on read, `modified: true` ⇒ _snapshot = true (dirty),
// absent ⇒ _snapshot = undefined (clean). With a `resolve` callback the deserializer applies
// onto the resolved original instead: it overlays when `modified`, and otherwise keeps the
// original untouched — warning the developer if the incoming values differ from its baseline.

import { Entity, EmbeddedEntity, typeConstructor } from './entity';
import type { Type, PrimaryKey, BaseEntity } from './entity';
import { Lite, LiteImp } from './lite';
import { forEachField, isModifiedSelf, project, snapshotEqual } from './changes';
import { fieldType, fieldEnum } from './reflection';
import { resolveCleanType, cleanTypeName } from './registration';
import type { FieldInfo } from './reflection';
import { Temporal, Decimal, toInt } from './basics';

// ---- Options ---------------------------------------------------------------

export type WriteTypes = 'Always' | 'Auto';

export interface SerializeOptions {
    /** Discriminator verbosity; defaults to "Auto". */
    writeTypes?: WriteTypes;
}

export interface DeserializeOptions {
    /**
     * Supplies the authoritative "original" for an existing entity (id present) so the
     * codec can apply onto it (overlay when `modified`) instead of building fresh. The
     * returned entity is assumed to carry its clean baseline snapshot (i.e. it was
     * retrieved and cleanModified). Omit for the client-receive path (build + seed
     * snapshot from the `modified` flag).
     */
    resolve?: (typeName: string, id: PrimaryKey) => Entity | undefined | null;
    /** Overrides the default console.warn for the not-modified consistency tripwire. */
    onWarn?: (message: string) => void;
}

// ---- Custom lite registry --------------------------------------------------

// A custom lite carries display fields directly on the lite instance (altea has no
// separate "model" object). More than one custom lite may be registered per entity type;
// on deserialize the first whose isCompatible(json) returns true is chosen, else LiteImp.
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

const TEMPORAL_CTORS = [
    Temporal.PlainDate, Temporal.PlainDateTime, Temporal.PlainTime, Temporal.Duration,
    Temporal.Instant, Temporal.ZonedDateTime, Temporal.PlainYearMonth, Temporal.PlainMonthDay,
];

function isTemporal(v: unknown): boolean {
    return TEMPORAL_CTORS.some(c => v instanceof (c as unknown as Function));
}

const TEMPORAL_TYPE_NAMES = new Set([
    'PlainDate', 'PlainDateTime', 'PlainTime', 'Duration',
    'Instant', 'ZonedDateTime', 'PlainYearMonth', 'PlainMonthDay',
]);

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

// Enum <-> member-name. Works for numeric enums (reverse map is built by TS) and string
// enums (scanned). resolveEnum maps the field's typeName back to the runtime enum object.
function enumName(enumObj: Record<string, unknown>, value: unknown): string {
    const reverse = enumObj[value as string];
    if (typeof reverse === 'string') return reverse;   // numeric enum: enumObj[0] === "Male"
    for (const k of Object.keys(enumObj))
        if (enumObj[k] === value) return k;
    return String(value);
}

function enumValue(enumObj: Record<string, unknown>, name: string): unknown {
    return enumObj[name];
}

// A monomorphic Entity[] collection whose elements are owned part-entities (they carry
// @backReference / @rowOrder). Lite<T>[] and value arrays are not "parented".
function isPartCollectionField(fi: FieldInfo): boolean {
    if (fi.lite) return false;
    const ctor = fieldType(fi);
    return (ctor != null && ctorIsEntity(ctor)) || fi.implementations != null;
}

function safeToString(m: { toString(): string }): string | undefined {
    try { return m.toString(); } catch { return undefined; }
}

// ---- Serialize -------------------------------------------------------------

interface SerCtx {
    writeTypes: WriteTypes;
    path: Set<BaseEntity>;   // cycle guard for full-entity references
}

interface Slot {
    fi?: FieldInfo;
    root: boolean;
    parented: boolean;
}

function writeTypeFor(slot: Slot, ctx: SerCtx): boolean {
    if (ctx.writeTypes === 'Always') return true;
    if (slot.root) return true;
    return slot.fi?.implementations != null;   // @implementedBy / @implementedByAll
}

export function serialize(obj: unknown, options?: SerializeOptions): string {
    const ctx: SerCtx = { writeTypes: options?.writeTypes ?? 'Auto', path: new Set() };
    return JSON.stringify(toJson(obj, { root: true, parented: false }, ctx));
}

function toJson(value: unknown, slot: Slot, ctx: SerCtx): unknown {
    if (value == null) return null;
    if (value instanceof Lite) return serializeLite(value, writeTypeFor(slot, ctx), ctx);
    if (value instanceof Entity) return serializeEntity(value, writeTypeFor(slot, ctx), slot.parented, ctx);
    if (value instanceof EmbeddedEntity) return serializeEmbedded(value, writeTypeFor(slot, ctx), ctx);
    if (isTemporal(value)) return (value as { toString(): string }).toString();
    if (value instanceof Decimal) return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(el => toJson(el, { root: slot.root, parented: false }, ctx));
    if (typeof value === 'object') {   // plain dictionary — each value is a root
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) o[k] = toJson(v, { root: true, parented: false }, ctx);
        return o;
    }
    return value;   // string / number / boolean
}

// Enums are not runtime-distinguishable from plain numbers, so field values are serialized
// here (fi-aware) rather than through toJson's runtime dispatch.
function serializeFieldValue(fi: FieldInfo, value: unknown, ctx: SerCtx): unknown {
    if (value == null) return null;
    if (fi.isEnum) {
        const e = fieldEnum(fi) as Record<string, unknown> | undefined;
        if (e == null) throw new Error(`Cannot serialize enum field '${fi.name}': enum is not registered`);
        return fi.array ? (value as unknown[]).map(v => enumName(e, v)) : enumName(e, value);
    }
    if (fi.array) {
        const parented = isPartCollectionField(fi);
        return (value as unknown[]).map(el => toJson(el, { fi, root: false, parented }, ctx));
    }
    return toJson(value, { fi, root: false, parented: false }, ctx);
}

function serializeEntity(entity: Entity, writeType: boolean, parented: boolean, ctx: SerCtx): Record<string, unknown> {
    if (ctx.path.has(entity))
        throw new Error(`Cycle detected serializing ${entity.constructor.name} (id=${String(entity.id)}); break entity reference cycles with a Lite<T>.`);
    ctx.path.add(entity);
    try {
        const o: Record<string, unknown> = {};
        if (writeType) o.$type = cleanTypeName(entity.constructor);
        o.id = entity.id ?? null;
        if (entity.ticks != null) o.ticks = entity.ticks;
        const toStr = safeToString(entity);
        if (toStr != null) o.toStr = toStr;
        if (isModifiedSelf(entity)) o.modified = true;
        forEachField(entity, (fi, value) => {
            if (parented && (fi.isBackReference || fi.isRowOrder)) return;   // recoverable from context
            o[fi.name] = serializeFieldValue(fi, value, ctx);
        });
        return o;
    } finally {
        ctx.path.delete(entity);
    }
}

function serializeEmbedded(em: EmbeddedEntity, writeType: boolean, ctx: SerCtx): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    if (writeType) o.$type = cleanTypeName(em.constructor);
    if (isModifiedSelf(em)) o.modified = true;
    forEachField(em, (fi, value) => { o[fi.name] = serializeFieldValue(fi, value, ctx); });
    return o;
}

const LITE_RESERVED_KEYS = new Set(['id', 'entityType', 'toStr', '_entity']);

function serializeLite(lite: Lite<Entity>, writeType: boolean, ctx: SerCtx): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    if (writeType) o.$lite = cleanTypeName(typeConstructor(lite.entityType));
    o.id = lite.id ?? null;
    const toStr = safeToString(lite);
    if (toStr != null) o.toStr = toStr;
    // Custom-lite display fields live directly on the instance (not under a "model").
    for (const key of Object.keys(lite)) {
        if (LITE_RESERVED_KEYS.has(key)) continue;
        o[key] = toJson((lite as unknown as Record<string, unknown>)[key], { root: false, parented: false }, ctx);
    }
    const entity = lite.entityOrNull;
    if (entity != null)   // fat lite: the type is known from the lite, so Auto omits $type
        o.entity = serializeEntity(entity, ctx.writeTypes === 'Always', false, ctx);
    return o;
}

// ---- Deserialize -----------------------------------------------------------

interface DesCtx {
    // The expected entity/embedded constructor from field context (via fieldType), used
    // when the value carries no $type/$lite discriminator (Auto mode, monomorphic).
    expectedType?: Function;
    parented?: boolean;
    owner?: Entity;
    index?: number;
}

export function deserialize(json: string, options?: DeserializeOptions): unknown {
    return new Deserializer(options ?? {}).value(JSON.parse(json), {});
}

class Deserializer {
    // Identity map keyed by "TypeName|id": the first occurrence of an entity builds it,
    // later occurrences (shared refs, cycles) reuse the same instance.
    private readonly idMap = new Map<string, Entity>();

    constructor(private readonly opts: DeserializeOptions) { }

    // Dynamic top-level / root dispatch: entities and lites at a root always carry their
    // discriminator (see writeTypes), so type is read from $type/$lite here.
    value(json: unknown, ctx: DesCtx): unknown {
        if (json == null) return null;
        if (Array.isArray(json)) return json.map(el => this.value(el, {}));
        if (typeof json === 'object') {
            const j = json as Record<string, unknown>;
            if ('$lite' in j) return this.lite(j, ctx);
            if ('$type' in j || ctx.expectedType != null) return this.modifiable(j, ctx, undefined);
            const o: Record<string, unknown> = {};   // plain dictionary of roots
            for (const [k, v] of Object.entries(j)) o[k] = this.value(v, {});
            return o;
        }
        return json;
    }

    private modifiable(json: Record<string, unknown>, ctx: DesCtx, existing: unknown): BaseEntity {
        // The wire discriminator is a clean name ("Album"), resolved through the registry;
        // otherwise the constructor comes straight from field context (fieldType).
        const wire = json.$type as string | undefined;
        const ctor = wire != null ? resolveCleanType(wire) : ctx.expectedType;
        if (ctor == null)
            throw new Error(wire != null
                ? `Cannot deserialize: unknown type "${wire}"`
                : 'Cannot deserialize object: no $type discriminator and no field context');

        if (ctorIsEmbedded(ctor))
            return this.embedded(json, ctor as new () => EmbeddedEntity, existing);
        return this.entity(json, ctor as new () => Entity, ctx, existing);
    }

    private embedded(json: Record<string, unknown>, ctor: new () => EmbeddedEntity, existing: unknown): EmbeddedEntity {
        const inst = (existing instanceof EmbeddedEntity && existing.constructor === ctor)
            ? existing
            : new ctor();
        this.applyFields(inst, json, false, undefined, undefined);
        inst._snapshot = json.modified === true ? true : undefined;
        return inst;
    }

    private entity(json: Record<string, unknown>, ctor: new () => Entity, ctx: DesCtx, existing: unknown): Entity {
        const id = (json.id === undefined ? null : json.id) as PrimaryKey | null;
        const modified = json.modified === true;

        // New entity: just build; _snapshot stays `true` (modified), like create()/new.
        if (id == null) {
            const inst = new ctor();
            this.applyFields(inst, json, ctx.parented === true, ctx.owner, ctx.index);
            return inst;
        }

        // Identity keyed by the resolved constructor (stable), not the wire name.
        const key = ctor.name + '|' + String(id);
        const cached = this.idMap.get(key);
        if (cached != null) return cached;   // intra-payload identity

        // Reuse an original: an existing-graph instance with the same Type+id, else resolve()
        // (which is handed the canonical clean name).
        let original: Entity | undefined | null;
        if (existing instanceof Entity && existing.constructor === ctor && existing.id === id)
            original = existing;
        else if (this.opts.resolve != null)
            original = this.opts.resolve(cleanTypeName(ctor), id);

        if (original != null) {
            this.idMap.set(key, original);
            if (modified) {
                // Overlay onto the original (reusing its children by Type+id). Its clean
                // projection snapshot is left in place, so isModifiedSelf reflects the overlay.
                this.applyFields(original, json, ctx.parented === true, ctx.owner, ctx.index);
            } else {
                // Not marked modified ⇒ do NOT apply. Trip the wire if the client nonetheless
                // sent values that differ from the resolved baseline.
                this.checkClean(json, ctor, original);
            }
            return original;
        }

        // No baseline available (client-receive path): build fresh with the id, seed the
        // snapshot sentinel from the `modified` flag.
        const inst = new ctor();
        inst.id = id;
        inst.isNew = false;
        if (json.ticks != null) inst.ticks = json.ticks as number;
        this.idMap.set(key, inst);
        this.applyFields(inst, json, ctx.parented === true, ctx.owner, ctx.index);
        inst._snapshot = modified ? true : undefined;
        return inst;
    }

    private applyFields(inst: BaseEntity, json: Record<string, unknown>, parented: boolean, owner: Entity | undefined, index: number | undefined): void {
        forEachField(inst, fi => {
            if (Object.prototype.hasOwnProperty.call(json, fi.name))
                this.applyField(inst, fi, json[fi.name]);
        });
        // @backReference / @rowOrder are omitted for parented part-entities — recover them
        // from context. Position is authoritative (a moved row's order changes → self-modified).
        if (parented && owner != null)
            forEachField(inst, fi => {
                if (fi.isBackReference) (inst as unknown as Record<string, unknown>)[fi.name] = owner.toLite(true);
                else if (fi.isRowOrder) (inst as unknown as Record<string, unknown>)[fi.name] = toInt(index ?? 0);
            });
    }

    private applyField(inst: BaseEntity, fi: FieldInfo, jv: unknown): void {
        const target = inst as unknown as Record<string, unknown>;
        if (jv == null) { target[fi.name] = null; return; }
        if (fi.isEnum) {
            const e = fieldEnum(fi) as Record<string, unknown> | undefined;
            if (e == null) throw new Error(`Cannot deserialize enum field '${fi.name}': enum is not registered`);
            target[fi.name] = fi.array ? (jv as unknown[]).map(n => enumValue(e, n as string)) : enumValue(e, jv as string);
            return;
        }
        if (fi.array) { target[fi.name] = this.array(fi, jv as unknown[], target[fi.name], inst as Entity); return; }
        target[fi.name] = this.single(fi, jv, target[fi.name]);
    }

    private single(fi: FieldInfo, jv: unknown, existing: unknown): unknown {
        if (fi.lite)
            return this.lite(jv as Record<string, unknown>, { expectedType: fieldType(fi) });

        const ctor = fieldType(fi);
        if (ctor != null && (ctorIsEntity(ctor) || ctorIsEmbedded(ctor)))
            return this.modifiable(jv as Record<string, unknown>, { expectedType: ctor }, existing);

        // Polymorphic reference whose declared type is an interface not in the registry:
        // the concrete type rides on the value's own discriminator.
        if (fi.implementations != null) {
            const j = jv as Record<string, unknown>;
            if (typeof j === 'object' && '$lite' in j) return this.lite(j, {});
            return this.modifiable(j, {}, existing);
        }

        if (TEMPORAL_TYPE_NAMES.has(fi.typeName)) return temporalFrom(fi.typeName, jv as string);
        if (fi.typeName === 'Decimal') return new Decimal(jv as Decimal.Value);
        if (fi.typeName === 'Date') return new Date(jv as string);
        return jv;   // Number / String / Boolean
    }

    private array(fi: FieldInfo, jsonArr: unknown[], existingArr: unknown, owner: Entity): unknown[] {
        if (isPartCollectionField(fi)) {
            // Reconcile by Type+id across positions: reuse the matching existing element
            // (preserving its identity + clean snapshot), create the rest.
            const byId = new Map<string, Entity>();
            if (Array.isArray(existingArr))
                for (const el of existingArr)
                    if (el instanceof Entity && el.id != null)
                        byId.set(el.constructor.name + '|' + String(el.id), el);

            return jsonArr.map((elJson, i) => {
                const ej = elJson as Record<string, unknown>;
                const elCtor = ej.$type != null ? resolveCleanType(ej.$type as string) : fieldType(fi);
                const elId = ej.id;
                const existingEl = (elId != null && elCtor != null) ? byId.get(elCtor.name + '|' + String(elId)) : undefined;
                return this.modifiable(ej, { expectedType: elCtor, parented: true, owner, index: i }, existingEl);
            });
        }

        if (fi.lite)
            return jsonArr.map(v => this.lite(v as Record<string, unknown>, { expectedType: fieldType(fi) }));
        if (TEMPORAL_TYPE_NAMES.has(fi.typeName)) return jsonArr.map(v => temporalFrom(fi.typeName, v as string));
        if (fi.typeName === 'Decimal') return jsonArr.map(v => new Decimal(v as Decimal.Value));
        return jsonArr.slice();   // Number / String / Boolean
    }

    private lite(json: Record<string, unknown>, ctx: DesCtx): Lite<Entity> {
        const wire = json.$lite as string | undefined;
        const ctor = wire != null ? resolveCleanType(wire) : ctx.expectedType;
        if (ctor == null)
            throw new Error(wire != null
                ? `Cannot deserialize lite: unknown type "${wire}"`
                : 'Cannot deserialize lite: no $lite discriminator and no field context');

        const id = (json.id === undefined ? null : json.id) as PrimaryKey;
        let lite: Lite<Entity> | undefined;
        for (const candidate of customLiteRegistry.get(ctor) ?? []) {
            if (candidate.isCompatible(json)) { lite = candidate.fromJson(json); break; }
        }
        lite ??= new LiteImp(id, ctor as Type<Entity>, (json.toStr as string | undefined) ?? '');

        if (json.entity != null)
            lite.setEntity(this.modifiable(json.entity as Record<string, unknown>, { expectedType: ctor }, undefined) as Entity);
        return lite;
    }

    // Not-modified consistency tripwire: build the incoming payload in isolation and diff
    // its projection against the resolved original's clean baseline. Never changes data.
    private checkClean(json: Record<string, unknown>, ctor: new () => Entity, original: Entity): void {
        const snap = original._snapshot;
        if (snap == null || snap === true) return;   // no real baseline to compare against
        const pure = new Deserializer({}).modifiable(json, { expectedType: ctor }, undefined);
        if (!snapshotEqual(project(pure), snap)) {
            const msg = `deserialize: ${cleanTypeName(ctor)} (id=${String(json.id)}) arrived without "modified" but its values differ from the resolved entity; changes were NOT applied.`;
            (this.opts.onWarn ?? ((m: string) => console.warn(m)))(msg);
        }
    }
}
