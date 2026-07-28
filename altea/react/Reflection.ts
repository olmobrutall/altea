// React-layer shim for the CLIENT type helpers of Signum.React/Reflection.ts.
//
// altea owns the reflection DATA MODEL natively (entities/reflection TypeInfo/FieldInfo,
// entities/propertyRoute PropertyRoute, entities/registration clean names). This module adds the
// client-only PseudoType / getTypeName / New helpers over altea's REAL classes. The `Binding`
// system was extracted to ./binding.

import { Entity, BaseEntity, ModelEntity, typeConstructor } from '../entities/entity';
import type { Type, PrimaryKey } from '../entities/entity';
import { Lite, LiteImp } from '../entities/lite';
import { PropertyRoute, PropertyRouteType } from '../entities/propertyRoute';
import { TypeInfo, tryGetTypeInfo as alteaTryGetTypeInfo } from '../entities/reflection';
import type { FieldInfo } from '../entities/reflection';
import { cleanTypeName, resolveType, resolveCleanType, resolveEnum } from '../entities/registration';

// ---- Re-exports of altea's native reflection ---------------------------------------------------
export { PropertyRoute, PropertyRouteType, TypeInfo };
export type { Type, FieldInfo };

// Signum's per-member metadata is altea's FieldInfo (route.fieldInfo). Downstream `member.niceName`
// is swept to `fieldInfo.niceToString()`.
export type MemberInfo = FieldInfo;

// A type reference: altea's `Type<T>` is the constructor (or a closed GenericType), not a
// { typeName } object.
export type IType = Type<BaseEntity>;
export type PseudoType = IType | string;

export function isType(obj: unknown): obj is IType {
  // Distinguish an entity/mixin CONSTRUCTOR from a plain lambda (both are `function` in altea):
  // a ctor's prototype is a BaseEntity, a lambda's is not.
  return typeof obj === 'function' && (obj as Function).prototype instanceof BaseEntity;
}

export function getTypeName(pseudoType: PseudoType | Lite<Entity> | BaseEntity): string {
  if (pseudoType instanceof Lite)
    return cleanTypeName(typeConstructor(pseudoType.entityType));
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
  if (type instanceof Lite) return typeConstructor(type.entityType);
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

// Signum's getTypeInfos(TypeReference | string): the @implementedBy name is a ", "-separated list
// of clean names; split + resolve each. "[ALL]" (IsByAll) and "" resolve to no concrete types.
export function getTypeInfos(typeReference: TypeReference | string): TypeInfo[] {
  const name = typeof typeReference === 'string' ? typeReference : typeReference.name;
  if (name === IsByAll || name === "") return [];
  return name.split(", ").map(n => getTypeInfo(n));
}

export function tryGetTypeInfos(typeReference: TypeReference | string): (TypeInfo | undefined)[] {
  const name = typeof typeReference === 'string' ? typeReference : typeReference.name;
  if (name === IsByAll || name === "") return [];
  return name.split(", ").map(n => tryGetTypeInfo(n));
}

// ---- Query-layer type metadata (Signum's TypeReference / is*Type / QueryKey / QueryTokenString) --

// A query-column / property type reference, as it crosses the wire from the server query layer.
// Signum's TypeReference; altea keeps the same shape (the query DTOs are server-defined).
export interface TypeReference {
  name: string;
  typeNiceName?: string;
  isCollection?: boolean;
  isLite?: boolean;
  isNotNullable?: boolean;
  isEmbedded?: boolean;
}

// The @implementedByAll discriminator (a column typed as "any entity"): its name resolves to no
// concrete TypeInfo, so getTypeInfos/tryGetTypeInfos return [] for it.
export const IsByAll = "[ALL]";

// Number / decimal type-name tests. TODO: reconcile the vocabulary with altea's query TypeReference
// names once QueryToken is wired to the altea query layer — altea's value types are "Number" /
// "String" / "Boolean" (capitalized), whereas Signum used the C# names int / double / decimal / …
const numberTypeNames = new Set(["byte", "sbyte", "short", "ushort", "int", "uint", "long", "ulong", "float", "double", "decimal", "Number"]);
export function isNumberType(name: string): boolean {
  return numberTypeNames.has(name);
}

// altea type-kind tests. Signum read the TypeInfo blob's kind/entityKind; altea derives the answer
// from the resolved constructor (an entity/model IS its class), and from the enum registry for
// enums (raw enums have no constructor to test).
export function isTypeEntity(type: PseudoType | Lite<Entity> | BaseEntity): boolean {
  const c = pseudoCtor(type);
  return c != null && (c === Entity || c.prototype instanceof Entity);
}
export function isTypeModel(type: PseudoType | Lite<Entity> | BaseEntity): boolean {
  const c = pseudoCtor(type);
  return c != null && (c === ModelEntity || c.prototype instanceof ModelEntity);
}
export function isTypeEnum(type: PseudoType): boolean {
  return typeof type === 'string' && resolveEnum(type) != null;
}

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
