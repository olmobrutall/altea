// React-layer shim for the CLIENT type helpers of Signum.React/Reflection.ts.
//
// altea owns the reflection DATA MODEL natively (entities/reflection TypeInfo/FieldInfo,
// entities/propertyRoute PropertyRoute, entities/registration clean names). This module adds the
// client-only PseudoType / getTypeName / New helpers over altea's REAL classes. The `Binding`
// system was extracted to ./binding.

import { Entity, BaseEntity, EmbeddedEntity, ModelEntity } from '../data/entity';
import type { Type, PrimaryKey } from '../data/entity';
import { forEachField } from '../data/changes';
import { Lite, LiteImp } from '../data/lite';
import { TypeInfo, tryGetTypeInfo as alteaTryGetTypeInfo } from '../data/reflection';
import type { FieldInfo, OperationType } from '../data/reflection';
import { Metadata } from '../data/metadata';
import { Localization } from '../data/utils/localization';
import type { TypeMetadata, OperationMetadata, KindOfType } from '../data/metadata';
import type { ModelState } from '../data/validation';
export type { OperationMetadata, OperationType, TypeMetadata, KindOfType };
export { TypeInfo };
import { cleanTypeName, resolveType, resolveCleanType } from '../data/registration';

// The reflection DATA MODEL (PropertyRoute / TypeInfo / TypeReference / FieldInfo / Type) lives in
// entities/* — import it from there directly. This react shim no longer re-exports it (Signum
// centralised those in Reflection.ts; altea keeps them at their real home). What remains below is the
// genuinely client-only surface: getTypeName / pseudoCtor / EnumType / newLite.

// Signum's per-member metadata is altea's FieldInfo (route.fieldInfo). Downstream `member.niceName`
// is swept to `fieldInfo.niceToString()`.
export type MemberInfo = FieldInfo;

// A type reference: altea's `Type<T>` is the constructor (or a closed GenericType), not a
// { typeName } object.
export type IType = Type<BaseEntity>;
export type PseudoType = IType | string;

export function getTypeName(pseudoType: PseudoType | Lite<Entity> | BaseEntity): string {
  if (pseudoType instanceof Lite)
    return cleanTypeName(pseudoType.entityType);
  if (pseudoType instanceof BaseEntity)
    return cleanTypeName(pseudoType.constructor as Function);
  if (typeof pseudoType === 'string')
    return pseudoType;
  if (typeof pseudoType === 'function')
    return cleanTypeName(pseudoType);
  throw new Error("Unexpected pseudoType " + pseudoType);
}

// Anything that can name a type: a PseudoType, an instance, a lite — or a bare `Function`, which is what
// `TypeInfo.ctor` and the LINQ layer hand around (a ctor is a Type<T> at runtime but not to the checker).
export type AnyTypeRef = PseudoType | Lite<Entity> | BaseEntity | Function | undefined | null;

// Resolve any PseudoType / instance to its constructor (for the TypeInfo lookups below).
function pseudoCtor(type: AnyTypeRef): Function | undefined {
  if (type == null) return undefined;
  if (type instanceof Lite) return type.entityType;
  if (type instanceof BaseEntity) return type.constructor as Function;
  if (typeof type === 'string') return resolveCleanType(type) ?? resolveType(type);
  if (typeof type === 'function') return type;
  return undefined;
}

// Signum's getTypeInfo/tryGetTypeInfo take a PseudoType; altea's take a ctor/instance — bridge.
export function tryGetTypeInfo(type: AnyTypeRef): TypeInfo | undefined {
  const ctor = pseudoCtor(type);
  return ctor ? alteaTryGetTypeInfo(ctor) : undefined;
}

export function getTypeInfo(type: PseudoType | Lite<Entity> | BaseEntity): TypeInfo {
  const ti = tryGetTypeInfo(type);
  if (ti == null)
    throw new Error(`No TypeInfo for '${getTypeName(type)}'`);
  return ti;
}

// (Signum's client `getTypeInfos(name)` / `tryGetTypeInfos(name)` — split a ", "-joined clean-name
// list + resolve each — are gone: altea holds the target ctor(s) structurally on the TypeReference, so
// callers read `tr.typeInfos()` (entities/reflection) directly. That also fixes name-only @implementedBy
// references, whose `getTypeName()` is the unresolvable interface name.)

// ---- Query-layer type metadata (Signum's is*Type / QueryTokenString) ---------------------------

// A query column's type is a `TypeReference` now (QueryToken.type / PropertyRoute.type), same as a
// field's — so the client reads type facts directly off it: `.getTypeName()`, `.array`, `.lite`,
// `.is(EmbeddedEntity)`. The old RuntimeType-based runtimeTypeName / isRuntime* helpers are gone.

// A field's category is now expressed with `TypeReference` methods: fi.is(Entity) / fi.is(EmbeddedEntity)
// / fi.is(ModelEntity) and fi.isByAll(). No free-function forms.

// The @implementedByAll clean-name sentinel (a column typed as "any entity"): still used as a wire /
// query-name marker (e.g. Navigator.defaultFindOptions). `TypeReference.typeInfos()` returns [] for it.
export const IsByAll = "[ALL]";

// (Number formatting + numeric-type helpers moved to ./numberFormat — they are formatting, not
// reflection; import them from there.)

// (Signum's PseudoType kind-tests isType/isTypeEntity/isTypeModel/isTypeEnum are gone — altea uses
// `x instanceof Entity/ModelEntity/EmbeddedEntity` or `TypeReference.is(...)` directly.)

// Builds a thin (unloaded) lite from a type + id (Signum's free `newLite`); the optional third
// argument is the display string (Signum's model). Fat lites come from `Entity.toLite()`.
export function newLite(type: PseudoType, id: number | string, toStr?: string): Lite<Entity> {
  const ctor = pseudoCtor(type);
  if (ctor == null)
    throw new Error(`newLite: cannot resolve type '${getTypeName(type)}'`);
  return new LiteImp(id as PrimaryKey, ctor as unknown as Type<Entity>, toStr ?? "");
}

// A member (enum value / message) lookup by name, throwing when absent (Signum's getMemberInfo).
function getMemberInfo(ti: TypeInfo, memberName: string): MemberInfo {
  const member = ti.members[memberName];
  if (member == null)
    throw new Error(`Member ${memberName} not found on type ${ti.ctor?.name}`);
  return member;
}

// (Signum's client `EnumType<T>` wrapper is gone — altea uses the entity-level `Enum` helper
// (entities/enum) over the numeric enum objects: `Enum.values(SexEnum)` / `Enum.niceName(SexEnum, x)`.)

// Signum's getQueryKey / isQueryDefined. A query is named by a TYPE — an entity or the model a manual
// query projects to — so its key is that type's clean name. altea has no separate client query-name
// registry yet, so a type resolving to a TypeInfo is taken as "query defined".
//
// Signum also allows a `QueryKey` (an owning type + member name, its queries being enum MEMBERS like
// `AlbumQuery.Recent`) and altea used to carry that union member. Nothing ever CONSTRUCTED one — every
// altea query is named by its type, because a manual query's name IS its row model — so the class was
// only ever widening a dozen signatures with a branch that could not be reached.
export function getQueryKey(queryName: PseudoType): string {
  return getTypeName(queryName);
}

// The keys of the queries the server declared (Signum's TypeInfo.queryDefined), populated at boot from
// /api/reflection/metadata (ReflectionClient.loadReflectionMetadata). Before metadata arrives it is
// empty and isQueryDefined falls back to the "resolves to a TypeInfo" heuristic.
const definedQueries = new Set<string>();

export function setDefinedQueries(keys: Iterable<string>): void {
  definedQueries.clear();
  for (const k of keys) definedQueries.add(k);
}

/** The keys of the currently-defined queries (the role-filtered set after login). */
export function getDefinedQueries(): string[] {
  return [...definedQueries];
}

export function isQueryDefined(queryName: PseudoType): boolean {
  if (definedQueries.size > 0)
    return definedQueries.has(getQueryKey(queryName));
  return tryGetTypeInfo(queryName) != null; // pre-metadata fallback
}

// Signum's getQueryNiceName: the human label for a query — its type's PLURAL nice name, which is why a
// query row MODEL carries a plural where Signum gives an embedded none (see altea-translations'
// descriptionOptionsOf).
//
// A key with no CLIENT class still gets a proper label: an entity registered only on the server (a
// migration log, say) has no ctor here, but the metadata blob carries an entry for it — so fall through to
// resolving the bare NAME, which is one of the two documented cases for reaching into Localization.Internal
// (there is no fluent surface for a type with no constructor). Only a name nothing knows falls back to
// itself.
export function getQueryNiceName(queryName: PseudoType): string {
  const ti = tryGetTypeInfo(queryName);
  if (ti != null)
    return ti.getNicePluralName();
  const key = getQueryKey(queryName);
  return Metadata.tryType(key) != null ? Localization.Internal.typeNicePluralName(key) : key;
}

// ---- Per-culture / per-role metadata (data/metadata) -------------------------------------------
// Deliberately NOT on TypeInfo: nice names, operations and authorization allowances vary by culture and
// by role, while a TypeInfo is the one compile-time descriptor shared by every user. `MetadataBlob.types`
// is keyed by the REGISTERED name ("OrderEntity"), so a PseudoType is resolved through its ctor first.

export function tryGetTypeMetadata(type: AnyTypeRef): TypeMetadata | undefined {
  const ctor = pseudoCtor(type);
  if (ctor != null)
    return Metadata.tryType(ctor.name);
  // A name that resolves to no CLASS can still be a metadata type: an enum or a container has no
  // constructor to hang a TypeInfo on, but it does have a TypeMetadata entry (keyed by its registered
  // name). This is what makes the "Enum" kind reachable on the client at all.
  if (typeof type === "string")
    return Metadata.tryType(type) ?? Metadata.tryType(type + "Entity");
  return undefined;
}

/**
 * The kind of a type NAME (Signum's TypeInfo.kind). Unlike `TypeInfo.kind`, which can only see reflected
 * classes ("Entity" / "Model"), this reads the metadata blob and so also answers "Enum" and "Container".
 */
export function getKindOfType(type: AnyTypeRef): KindOfType | undefined {
  return tryGetTypeMetadata(type)?.kind ?? tryGetTypeInfo(type)?.kind;
}

/** Every operation registered on a type and visible to the current role (Signum's TypeInfo.operations). */
export function getOperationInfos(type: AnyTypeRef): OperationMetadata[] {
  const operations = tryGetTypeMetadata(type)?.operations;
  return operations == null ? [] : Object.values(operations);
}

/** Whether the type has ANY operation visible to the current role (Signum's `ti.operations != null`). */
export function hasOperations(type: AnyTypeRef): boolean {
  return getOperationInfos(type).length > 0;
}

/** Whether any visible operation CONSTRUCTS the type (Signum's TypeInfo.hasConstructorOperation). */
export function hasConstructorOperation(type: AnyTypeRef): boolean {
  return getOperationInfos(type).some(oi => oi.operationType == "Constructor");
}

// Signum's getOperationInfo: the OperationMetadata for a key on a type. Throws when it is absent — which
// now means "not registered on this type, or not allowed for this role"; before this refactor it also
// meant "the symbol-key-splitting heuristic failed to attach it", which was the common cause.
export function getOperationInfo(operation: string | { key: string }, type: PseudoType | Lite<Entity> | BaseEntity): OperationMetadata {
  const operationKey = typeof operation == "string" ? operation : operation.key;
  const oi = tryGetOperationInfo(operationKey, type);
  if (oi == null)
    throw new Error(`Operation '${operationKey}' is not available on '${getTypeName(type)}'`);
  return oi;
}

/** As {@link getOperationInfo}, undefined instead of throwing. */
export function tryGetOperationInfo(operation: string | { key: string }, type: AnyTypeRef): OperationMetadata | undefined {
  const operationKey = typeof operation == "string" ? operation : operation.key;
  return tryGetTypeMetadata(type)?.operations?.[operationKey];
}

// Signum's GraphExplorer walked the entity graph to (a) set `modified` flags before a save and (b)
// distribute / collect server ModelState onto each modifiable's `.error`. altea tracks modified in the
// serializer / entities/changes layer, and altea entities carry no `.error` field, so:
//   - propagateAll is a no-op shim (modified handled elsewhere),
//   - set/collectModelState store the flat ModelState keyed by the root entity in a WeakMap (enough
//     for ValidationErrors, which reads the root entity + a prefix).
const modelStates = new WeakMap<object, ModelState>();
export namespace GraphExplorer {
  export function propagateAll(..._args: unknown[]): void { }

  // Store server (or client-computed) ModelState on the root entity, re-keying each entry by its FULL
  // path so it lines up with the field contexts' `ctx.prefix` and the ValidationErrors summary. The
  // server returns keys relative to the posted entity (e.g. "firstName", "address.city"); `initialPrefix`
  // is the frame's root prefix ("framePage" / a modal prefix), so a stored key becomes "framePage.firstName".
  export function setModelState(entity: object, modelState: ModelState | undefined, initialPrefix?: string): void {
    if (modelState == null) {
      modelStates.delete(entity);
      return;
    }
    const prefixed: ModelState = {};
    for (const key of Object.keys(modelState)) {
      const full = initialPrefix ? (key ? initialPrefix + "." + key : initialPrefix) : key;
      prefixed[full] = modelState[key];
    }
    modelStates.set(entity, prefixed);
  }

  export function collectModelState(entity: object, prefix: string): ModelState {
    const ms = modelStates.get(entity);
    const result: ModelState = {};
    if (ms)
      for (const key of Object.keys(ms))
        if (!prefix || key == prefix || key.startsWith(prefix + "."))
          result[key] = ms[key];
    return result;
  }

  // The stored (full-path-keyed) ModelState for a root entity, or undefined. Read by TypeContext.error
  // so a server-reported error reddens the exact field even when the client's live validators pass
  // (e.g. a server-only validator disabled on the "Client" phase).
  export function peekModelState(entity: object): ModelState | undefined {
    return modelStates.get(entity);
  }

  // Phase 1: validate the owned graph (root entity + its embeddeds + owned collection rows) in the
  // "Client" environment, BEFORE sending. Returns a ModelState keyed by the path RELATIVE to the root
  // (e.g. "firstName", "address.city", "territories[0].territory") — the same path scheme the frame's
  // field contexts use (binding suffixes: ".field" for members, "[i]" for collection rows), so once the
  // frame prefix is prepended (setModelState) each key lines up with a `ctx.prefix` for red fields + a
  // clickable summary. Referenced OTHER aggregates (Lites) are NOT followed — they are saved separately.
  export function clientModelState(root: BaseEntity): ModelState {
    const ms: ModelState = {};
    const walk = (m: BaseEntity, path: string): void => {
      forEachField(m, (fi, value) => {
        const key = path ? path + "." + fi.name : fi.name;
        const error = fi.validate(m, "Client");
        if (error != null)
          ms[key] = error;
        if (value instanceof EmbeddedEntity)
          walk(value, key);
        else if (fi.array && Array.isArray(value))
          value.forEach((el, i) => {
            if (el instanceof Entity || el instanceof EmbeddedEntity)
              walk(el, key + "[" + i + "]");
          });
      });
    };
    walk(root, "");
    return ms;
  }
}

// Signum's `entityInfo(e)` — the `data-main-entity` marker string ("TypeName;id;N|O"). Used by the
// frame to tag the rendered entity's root DOM node.
export function entityInfo(entity: BaseEntity): string {
  const e = entity as BaseEntity & { id?: unknown; isNew?: boolean };
  return getTypeName(entity) + ";" + (e.id ?? "") + ";" + (e.isNew ? "N" : "O");
}

// Signum's `parseId(ti, id)` — coerce a route id string to the type's PK JS form. Delegates to the
// shared, tier-agnostic Entity.parseId on the type's ctor (reads the PK kind from reflection: a
// uuid/string PK stays a string; an int/long PK parses a numeric-looking id to a number), so client and
// server agree — including for an all-digit uuid id, which the old numeric-only heuristic mis-coerced.
export function parseId(ti: TypeInfo, id: string): number | string {
  return (ti.ctor as unknown as typeof Entity).parseId(id);
}

// QueryTokenString<T> lives in ./QueryTokenString (extracted from this file).

// NOTE: Signum's free `New(type, props)` is gone — construct via the class factory `Entity.create`
// (or `resolveType(name).create(...)` when only a runtime type name is known).
