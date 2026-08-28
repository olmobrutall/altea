// Port of Signum's `MultiSetter` (API/Controllers/OperationController.cs): apply the client's
// PROPERTY SETTERS to one retrieved entity before a `*Multiple` route runs the operation on it. This is
// the server half of client/Operations/MultiPropertySetter — the "bulk modifications" dialog.
//
// One setter is (property path · operation · value), and three of the eight operations recurse: a
// collection's elements are matched by a nested PREDICATE and rewritten by nested SETTERS; a reference
// or an embedded is built / modified by nested setters rooted at it.
//
// Divergences from Signum:
//   - `Expression`/`Activator`/`PropertyInfo.SetValue` are gone: a route is walked as plain member reads
//     (`resolveContainer`) and the predicate is EVALUATED, not compiled (`compareInMemory` below —
//     Signum reuses `QueryUtils.GetCompareExpression(..., inMemory: true)`, which altea has no
//     counterpart for since its filters only ever lower to SQL).
//   - MList is gone, so a collection is `@part` child ROWS: the element of a settable collection is an
//     ENTITY with its own table, hence `PropertyRoute.root(elementCtor)` for the nested block and no
//     "embedded element" branch. `RemoveElementsWhere` / `RemoveElement` splice IN PLACE, so the saver's
//     snapshot diff sees the removal (and orphans the rows) exactly as for a UI edit.
//   - A setter's property path never crosses an entity reference (altea's `PropertyRoute.add` re-roots
//     there, so the prefix could not be written down) — the client only ever produces embedded-only
//     paths; see the client file's header. A path that does cross one is rejected here, not guessed.
//   - `AssertCanWrite` becomes `propertyWriteAccess` (data/serializer): the same gate the codec applies,
//     asked directly because these writes bypass the codec. THROWS on a non-writable property, where the
//     codec silently keeps the original — "changed 500 rows" must not be a lie.
//   - a value arrives as untyped JSON (the setter list is not an entity graph), so it is coerced against
//     the target route's type, the way queryServer's `deserializeFilterValue` coerces a filter value.

import { BaseEntity, Entity, EmbeddedEntity, type Type } from "../data/entity";
import { Lite } from "../data/lite";
import { Decimal, Temporal } from "../data/basics";
import { PropertyRoute, PropertyRouteType } from "../data/propertyRoute";
import type { TypeReference } from "../data/reflection";
import { resolveCleanType } from "../data/registration";
import { Enum } from "../data/enum";
import { tryGetFilterType } from "../data/dynamicQuery/queryUtils";
import type { PropertyOperation } from "../data/operations";
import type { FilterOperation } from "../data/dynamicQueries";
import { propertyWriteAccess, serializationAuthMetadata, resolveSerializationAuthContext } from "../data/serializer";
import { UnauthorizedAccessException } from "./exceptions";

/** Signum's `OperationController.PropertySetter`. Mirrors client `Operations.API.PropertySetter`. */
export interface PropertySetter {
    property: string;
    operation?: PropertyOperation;
    filterOperation?: FilterOperation;
    value?: unknown;
    entityType?: string;
    predicate?: PropertySetter[];
    setters?: PropertySetter[];
}

export namespace MultiSetter {

    /**
     * The immutable per-request property-auth snapshot every `setSetters` call of that request shares
     * (Signum threads `SerializationMetadata`; the snapshot itself is altea's `authContext`, resolved
     * once at the async boundary as the codec does). Call ONCE per route, before the per-lite loop.
     */
    export function resolveContext(): Promise<unknown> {
        return resolveSerializationAuthContext();
    }

    /**
     * Apply `setters` to `entity`, whose own route is `route` (a Root route for an entity, the embedded's
     * own route for an embedded block). Port of Signum's `SetSetters`.
     */
    export function setSetters(entity: BaseEntity, setters: PropertySetter[], route: PropertyRoute, authContext: unknown, meta?: unknown): void {

        // Signum: `if (entity is IRootEntity root) metadata = GetSerializationMetadata(root)`. A `@part`
        // row is an Entity here too, so a nested block over one recomputes against its own root.
        if (entity instanceof Entity)
            meta = serializationAuthMetadata(entity);

        for (const setter of setters) {
            const pr = addRoute(route, setter.property);

            if (propertyWriteAccess(pr, meta, authContext) !== "writable")
                throw new UnauthorizedAccessException(`Property '${pr}' is not writable`);

            if (pr.type.array) {
                setCollection(entity, setter, pr, route, authContext, meta);
            } else if (setter.operation === "CreateNewEntity") {
                // An embedded is created in place (its block continues on the same route); an entity
                // reference is created as the chosen concrete type, rooted at it.
                const isEmbedded = pr.type.is(EmbeddedEntity);
                const ctor = isEmbedded ? embeddedCtorOf(pr) : entityTypeOf(setter, pr);
                const subPr = isEmbedded ? pr : PropertyRoute.root(ctor);
                const item = createInstance(ctor);
                MultiSetter.setSetters(item, setter.setters ?? [], subPr, authContext, meta);
                setValue(entity, pr, route, item);
            } else if (setter.operation === "ModifyEntity") {
                const item = getValue(entity, pr, route);
                if (!(item instanceof BaseEntity))
                    throw new Error(`Unable to change entity in ${pr}: ${item instanceof Lite ? "a Lite is not retrieved" : String(item)}`);

                // For an EMBEDDED the block continues on the same route; for an entity reference it
                // re-roots at the referenced instance's own type (altea's routes re-root there).
                const subPr = item instanceof Entity ? PropertyRoute.root(item.constructor as Function) : pr;
                MultiSetter.setSetters(item, setter.setters ?? [], subPr, authContext, meta);
                setValue(entity, pr, route, item);
            } else if (setter.operation === "Set") {
                setValue(entity, pr, route, convertValue(setter.value, pr.type));
            } else {
                throw new Error(`Unexpected PropertyOperation '${String(setter.operation)}' on ${pr}`);
            }
        }
    }
}

// ---- collections -----------------------------------------------------------------------------

function setCollection(entity: BaseEntity, setter: PropertySetter, pr: PropertyRoute, route: PropertyRoute, authContext: unknown, meta: unknown): void {

    const elementPr = pr.add("Item");
    const list = getValue(entity, pr, route) as unknown[] | null | undefined;
    if (list == null)
        throw new Error(`Collection ${pr} is not loaded`);

    switch (setter.operation) {
        case "AddElement":
            list.push(convertValue(setter.value, elementPr.type));
            break;

        case "AddNewElement": {
            const item = createInstance(elementCtor(elementPr));
            MultiSetter.setSetters(item, setter.setters ?? [], normalizedElementRoute(elementPr), authContext, meta);
            list.push(item);
            break;
        }

        case "ChangeElements": {
            const predicate = buildPredicate(setter.predicate ?? [], elementPr);
            const normalized = normalizedElementRoute(elementPr);
            for (const item of list.filter(predicate)) {
                if (!(item instanceof BaseEntity))
                    throw new Error(`Unable to change element of ${pr}: ${String(item)}`);
                MultiSetter.setSetters(item, setter.setters ?? [], normalized, authContext, meta);
            }
            break;
        }

        case "RemoveElementsWhere": {
            const predicate = buildPredicate(setter.predicate ?? [], elementPr);
            removeInPlace(list, item => predicate(item));
            break;
        }

        case "RemoveElement": {
            const value = convertValue(setter.value, elementPr.type);
            removeInPlace(list, item => sameValue(item, value), /*onlyFirst*/ true);
            break;
        }

        default:
            throw new Error(`Unexpected PropertyOperation '${String(setter.operation)}' on the collection ${pr}`);
    }
}

// Signum's `normalizedPr`: a collection of ENTITIES re-roots for the nested block; a collection of
// embeddeds keeps the element route. (altea only has the first case for a settable collection, but a
// `Lite<T>[]` / value array never reaches here — those offer AddElement / RemoveElement only.)
function normalizedElementRoute(elementPr: PropertyRoute): PropertyRoute {
    const ctor = elementPr.type.getFunction();
    return ctor != null && ctor.prototype instanceof Entity ? PropertyRoute.root(ctor) : elementPr;
}

function elementCtor(elementPr: PropertyRoute): Function {
    const ctor = elementPr.type.getFunction();
    if (ctor == null)
        throw new Error(`${elementPr} has no single element type to create`);
    return ctor;
}

// Remove every (or the first) matching element IN PLACE, so the field keeps its array identity and the
// saver's snapshot diff reports the removal.
function removeInPlace(list: unknown[], match: (item: unknown) => boolean, onlyFirst = false): void {
    for (let i = list.length - 1; i >= 0; i--) {
        if (match(list[i])) {
            list.splice(i, 1);
            if (onlyFirst)
                return;
        }
    }
}

// ---- predicate -------------------------------------------------------------------------------

// Signum builds an `Expression<Func<object,bool>>` and compiles it; altea evaluates directly. An EMPTY
// predicate is `true`, and several conditions are AND-ed — both as in Signum.
function buildPredicate(predicate: PropertySetter[], elementPr: PropertyRoute): (item: unknown) => boolean {
    if (predicate.length === 0)
        return () => true;

    const root = normalizedElementRoute(elementPr);
    const conditions = predicate.map(p => {
        const pr = addRoute(root, p.property);
        const value = convertValue(p.value, pr.type);
        const operation = p.filterOperation;
        if (operation == null)
            throw new Error(`The condition on ${pr} has no filter operation`);
        return (item: BaseEntity) => compareInMemory(getValue(item, pr, root), operation, value);
    });

    return item => item instanceof BaseEntity && conditions.every(c => c(item));
}

// The in-memory counterpart of `QueryUtils.GetCompareExpression(..., inMemory: true)`, covering the
// operations `FindOptions.filterOperations` actually offers per FilterType. The full-text and
// Complex/Smart ones are SQL-only by construction, so they are refused rather than approximated.
function compareInMemory(left: unknown, operation: FilterOperation, right: unknown): boolean {
    switch (operation) {
        case "EqualTo": return sameValue(left, right);
        case "DistinctTo": return !sameValue(left, right);
        case "GreaterThan": return compareOrdered(left, right) > 0;
        case "GreaterThanOrEqual": return compareOrdered(left, right) >= 0;
        case "LessThan": return compareOrdered(left, right) < 0;
        case "LessThanOrEqual": return compareOrdered(left, right) <= 0;
        case "Contains": return text(left).includes(text(right));
        case "NotContains": return !text(left).includes(text(right));
        case "StartsWith": return text(left).startsWith(text(right));
        case "NotStartsWith": return !text(left).startsWith(text(right));
        case "EndsWith": return text(left).endsWith(text(right));
        case "NotEndsWith": return !text(left).endsWith(text(right));
        case "Like": return likeRegex(text(right)).test(text(left));
        case "NotLike": return !likeRegex(text(right)).test(text(left));
        case "IsIn": return asArray(right).some(v => sameValue(left, v));
        case "IsNotIn": return !asArray(right).some(v => sameValue(left, v));
        default: throw new Error(`FilterOperation '${operation}' cannot be evaluated in memory`);
    }
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
    return value == null ? "" : String(value);
}

// SQL LIKE: `%` = any run, `_` = one character.
function likeRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$", "i");
}

function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a instanceof Lite) return a.is(b as Lite<Entity> | Entity);
    if (b instanceof Lite) return b.is(a as Lite<Entity> | Entity);
    if (a instanceof Entity && b instanceof Entity) return a.constructor === b.constructor && a.id != null && a.id === b.id;
    if (a instanceof Decimal || b instanceof Decimal) return new Decimal(a as Decimal.Value).eq(b as Decimal.Value);
    if (isTemporalValue(a) && isTemporalValue(b)) return String(a) === String(b);
    return false;
}

function compareOrdered(a: unknown, b: unknown): number {
    if (a == null || b == null) return a == b ? 0 : a == null ? -1 : 1;
    if (a instanceof Decimal || b instanceof Decimal) return new Decimal(a as Decimal.Value).cmp(b as Decimal.Value);
    if (isTemporalValue(a) && isTemporalValue(b)) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function isTemporalValue(v: unknown): boolean {
    return v instanceof Temporal.PlainDate || v instanceof Temporal.PlainDateTime
        || v instanceof Temporal.PlainTime || v instanceof Temporal.Duration || v instanceof Temporal.Instant;
}

// ---- value coercion --------------------------------------------------------------------------

// Signum's `ConvertObject`. A setter's `value` is NOT part of an entity graph, so the request
// deserializer only revived what carried a discriminator (a Lite / an entity / an embedded); a date, a
// decimal and an enum arrive as their wire scalar and are coerced here against the target's own type.
function convertValue(raw: unknown, type: TypeReference): unknown {
    if (raw == null)
        return null;

    const enumObj = type.getEnum();
    if (enumObj != null)   // the client binds the ORDINAL (see EnumLine); a member NAME is accepted too
        return typeof raw === "number" ? raw : Enum.toValue(enumObj as never, raw as never);

    switch (tryGetFilterType(type)) {
        case "Integer": return typeof raw === "number" ? Math.trunc(raw) : Math.trunc(Number(raw));
        case "Decimal": return raw instanceof Decimal ? raw : new Decimal(raw as Decimal.Value);
        case "Boolean": return typeof raw === "boolean" ? raw : raw === "true";
        case "String":
        case "Guid": return String(raw);
        case "DateTime":
        case "Time": return coerceTemporal(raw, type);
        default: return raw;   // Lite / entity / embedded / model — already revived by the Serializer
    }
}

function coerceTemporal(raw: unknown, type: TypeReference): unknown {
    if (typeof raw !== "string")
        return raw;
    switch (type.typeName) {
        case "PlainDate": return Temporal.PlainDate.from(raw);
        case "PlainDateTime": return Temporal.PlainDateTime.from(raw);
        case "PlainTime": return Temporal.PlainTime.from(raw);
        case "Duration": return Temporal.Duration.from(raw);
        default: return raw;
    }
}

// ---- route navigation ------------------------------------------------------------------------

// `route.addMany(path)` splits on "." only; a "/" (a collection step) is expanded to "Item" the way
// `PropertyRoute.parse` does, so any route string the client can produce round-trips.
function addRoute(route: PropertyRoute, path: string): PropertyRoute {
    if (path == null || path.length === 0)
        throw new Error(`A setter on ${route} has no property`);

    let r = route;
    for (const dotPart of path.split(".")) {
        const segs = dotPart.split("/");
        segs.forEach((seg, i) => {
            if (seg.length > 0)
                r = r.add(seg);
            if (i < segs.length - 1)
                r = r.add("Item");
        });
    }
    if (r.rootType !== route.rootType)
        throw new Error(`The setter path '${path}' crosses an entity reference — use ModifyEntity / CreateNewEntity instead`);
    return r;
}

// The object that actually OWNS `pr`'s member: `entity` itself when `pr` hangs directly off
// `parentRoute`, else the embedded reached by walking the intermediate steps (Signum compiles a lambda
// for the same walk). A mixin step carries no member — altea inlines mixin fields onto the entity.
//
// A missing EMBEDDED along the way is CREATED, which Signum needs no counterpart for: it initializes a
// non-nullable embedded in the field declaration, so its walk never meets a null. altea deliberately
// declares no such initializers, and the dialog offers the dotted path, so "set shipAddress.city" over a
// row whose address happens to be unset would otherwise fail for that row alone. Only embeddeds are
// created — an entity reference can never appear here (addRoute refuses a path that crosses one).
function resolveContainer(entity: BaseEntity, pr: PropertyRoute, parentRoute: PropertyRoute): Record<string, unknown> {
    const steps: PropertyRoute[] = [];
    for (let r = pr.parent; r != undefined && !r.equals(parentRoute); r = r.parent) {
        if (r.propertyRouteType === PropertyRouteType.FieldOrProperty)
            steps.unshift(r);
        else if (r.propertyRouteType !== PropertyRouteType.Mixin)
            throw new Error(`Cannot navigate ${pr} from ${parentRoute}: unexpected step ${r}`);
    }

    let obj = entity as unknown as Record<string, unknown>;
    for (const step of steps) {
        let next = obj[step.member];
        if (next == null) {
            if (!step.type.is(EmbeddedEntity))
                throw new Error(`Cannot navigate ${pr}: '${step.member}' is null`);
            next = createInstance(embeddedCtorOf(step));
            obj[step.member] = next;
        }
        obj = next as Record<string, unknown>;
    }
    return obj;
}

function setValue(entity: BaseEntity, pr: PropertyRoute, parentRoute: PropertyRoute, value: unknown): void {
    resolveContainer(entity, pr, parentRoute)[pr.member] = value;
}

function getValue(entity: BaseEntity, pr: PropertyRoute, parentRoute: PropertyRoute): unknown {
    return resolveContainer(entity, pr, parentRoute)[pr.member];
}

function embeddedCtorOf(pr: PropertyRoute): Function {
    const ctor = pr.type.getFunction();
    if (ctor == null)
        throw new Error(`${pr} has no single embedded type to create`);
    return ctor;
}

// The concrete type a CreateNewEntity builds: what the dialog chose (`entityType`, a clean name), else
// the reference's own single implementation.
function entityTypeOf(setter: PropertySetter, pr: PropertyRoute): Function {
    if (setter.entityType != null) {
        const ctor = resolveCleanType(setter.entityType);
        if (ctor == undefined)
            throw new Error(`Type '${setter.entityType}' is not recognized`);
        return ctor;
    }
    const ctor = pr.type.getFunction();
    if (ctor == null)
        throw new Error(`${pr} is polymorphic: the setter must name an entityType`);
    return ctor;
}

// `create({})` rather than `new` — a mixin's field initializers only run in the create FACTORY.
function createInstance(ctor: Function): BaseEntity {
    return (ctor as unknown as Type<BaseEntity> & { create(values: object): BaseEntity }).create({});
}


