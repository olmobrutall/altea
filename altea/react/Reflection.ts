// React-layer shim for the CLIENT type helpers of Signum.React/Reflection.ts.
//
// altea owns the reflection DATA MODEL natively (entities/reflection TypeInfo/FieldInfo,
// entities/propertyRoute PropertyRoute, entities/registration clean names). This module adds the
// client-only PseudoType / getTypeName / New helpers over altea's REAL classes. The `Binding`
// system was extracted to ./binding.

import { Entity, BaseEntity, typeConstructor, isGenericType, typeName } from '../entities/entity';
import type { Type } from '../entities/entity';
import { Lite } from '../entities/lite';
import { PropertyRoute, PropertyRouteType } from '../entities/propertyRoute';
import { TypeInfo, tryGetTypeInfo as alteaTryGetTypeInfo } from '../entities/reflection';
import type { FieldInfo } from '../entities/reflection';
import { cleanTypeName, resolveType, resolveCleanType } from '../entities/registration';

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
  return isGenericType(obj) || (typeof obj === 'function' && (obj as Function).prototype instanceof BaseEntity);
}

export function getTypeName(pseudoType: PseudoType | Lite<Entity> | BaseEntity): string {
  if (pseudoType instanceof Lite)
    return cleanTypeName(typeConstructor(pseudoType.entityType));
  if (pseudoType instanceof BaseEntity)
    return cleanTypeName(pseudoType.constructor as Function);
  if (typeof pseudoType === 'string')
    return pseudoType;
  if (isGenericType(pseudoType))
    return typeName(pseudoType as Type<BaseEntity>);
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
  if (isGenericType(type)) return typeConstructor(type as Type<BaseEntity>);
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

export function getTypeInfos(input: PseudoType | PseudoType[]): TypeInfo[] {
  const arr = Array.isArray(input) ? input : [input];
  return arr.map(t => tryGetTypeInfo(t)).filter((t): t is TypeInfo => t != null);
}

// NOTE: Signum's free `New(type, props)` is gone — construct via the class factory `Entity.create`
// (or `resolveType(name).create(...)` when only a runtime type name is known).
