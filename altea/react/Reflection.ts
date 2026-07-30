// React-layer shim for the CLIENT type helpers of Signum.React/Reflection.ts.
//
// altea owns the reflection DATA MODEL natively (entities/reflection TypeInfo/FieldInfo,
// entities/propertyRoute PropertyRoute, entities/registration clean names). This module adds the
// client-only PseudoType / getTypeName / New helpers over altea's REAL classes. The `Binding`
// system was extracted to ./binding.

import { Entity, BaseEntity, EmbeddedEntity, ModelEntity } from '../entities/entity';
import type { Type, PrimaryKey } from '../entities/entity';
import { Lite, LiteImp } from '../entities/lite';
import { TypeInfo, tryGetTypeInfo as alteaTryGetTypeInfo } from '../entities/reflection';
import type { FieldInfo } from '../entities/reflection';
import { cleanTypeName, resolveType, resolveCleanType } from '../entities/registration';

// The reflection DATA MODEL (PropertyRoute / TypeInfo / TypeReference / FieldInfo / Type) lives in
// entities/* — import it from there directly. This react shim no longer re-exports it (Signum
// centralised those in Reflection.ts; altea keeps them at their real home). What remains below is the
// genuinely client-only surface: getTypeName / pseudoCtor / EnumType / QueryKey / newLite.

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

// Resolve any PseudoType / instance to its constructor (for the TypeInfo lookups below).
function pseudoCtor(type: PseudoType | Lite<Entity> | BaseEntity | undefined | null): Function | undefined {
  if (type == null) return undefined;
  if (type instanceof Lite) return type.entityType;
  if (type instanceof BaseEntity) return type.constructor as Function;
  if (typeof type === 'string') return resolveCleanType(type) ?? resolveType(type);
  if (typeof type === 'function') return type;
  return undefined;
}

// Signum's getTypeInfo/tryGetTypeInfo take a PseudoType; altea's take a ctor/instance — bridge.
export function tryGetTypeInfo(type: PseudoType | Lite<Entity> | BaseEntity | undefined | null): TypeInfo | undefined {
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

// ---- Query-layer type metadata (Signum's is*Type / QueryKey / QueryTokenString) ----------------

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

// Signum's client enum wrapper, keyed by the enum's type name. The member metadata (values +
// nice names) comes from the type's TypeInfo — in altea that is the enum's bound EnumEntity
// TypeInfo (or, in future, the reflection translation blob for raw enums).
export class EnumType<T extends string> {
  constructor(public typeName: string) { }

  typeInfo(): TypeInfo {
    return getTypeInfo(this.typeName);
  }

  #values: T[] | undefined;
  values(): T[] {
    return (this.#values ??= Object.keys(this.typeInfo().members) as T[]);
  }

  #notIgnoredValues: T[] | undefined;
  notIgnoredValues(): T[] {
    return (this.#notIgnoredValues ??= Object.values(this.typeInfo().members)
      .filter(a => !(a as { isIgnoredEnum?: boolean }).isIgnoredEnum)
      .map(a => a.name) as T[]);
  }

  isDefined(val: any): val is T {
    return typeof val === "string" && this.typeInfo().members[val] != null;
  }

  assertDefined(val: any): T {
    if (this.isDefined(val))
      return val;
    throw new Error(`'${val}' is not a valid ${this.typeName}`);
  }

  value(val: T): T { return val; }

  index(val: T): number { return this.values().indexOf(val); }

  min(a: T, b: T): T { return this.index(a) < this.index(b) ? a : b; }
  max(a: T, b: T): T { return this.index(a) > this.index(b) ? a : b; }

  niceTypeName(): string | undefined { return this.typeInfo().getNiceName(); }

  niceToString(value: T): string {
    return getMemberInfo(this.typeInfo(), value as string).niceToString();
  }
}

// A query column's key: its owning type + member name (Signum's QueryKey).
export class QueryKey {
  constructor(
    public type: string,
    public name: string) { }

  memberInfo(): MemberInfo {
    return getMemberInfo(getTypeInfo(this.type), this.name);
  }

  niceName(): string {
    return this.memberInfo().niceToString();
  }
}

// Signum's getQueryKey / isQueryDefined. A query is named by an entity Type (ctor), a QueryKey, or a
// clean-name string. altea has no separate client query-name registry yet, so a type resolving to a
// TypeInfo is taken as "query defined".
export function getQueryKey(queryName: PseudoType | QueryKey): string {
  if (queryName instanceof QueryKey)
    return queryName.name;
  return getTypeName(queryName);
}

export function isQueryDefined(queryName: PseudoType | QueryKey): boolean {
  if (queryName instanceof QueryKey)
    return true;
  return tryGetTypeInfo(queryName) != null; // TODO(port): a real query-defined registry (Signum's TypeInfo.queryDefined).
}

// QueryTokenString<T> lives in ./QueryTokenString (extracted from this file).

// NOTE: Signum's free `New(type, props)` is gone — construct via the class factory `Entity.create`
// (or `resolveType(name).create(...)` when only a runtime type name is known).
