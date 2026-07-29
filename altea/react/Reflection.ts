// React-layer shim for the CLIENT type helpers of Signum.React/Reflection.ts.
//
// altea owns the reflection DATA MODEL natively (entities/reflection TypeInfo/FieldInfo,
// entities/propertyRoute PropertyRoute, entities/registration clean names). This module adds the
// client-only PseudoType / getTypeName / New helpers over altea's REAL classes. The `Binding`
// system was extracted to ./binding.

import { Entity, BaseEntity, EmbeddedEntity, ModelEntity, typeConstructor } from '../entities/entity';
import type { Type, PrimaryKey } from '../entities/entity';
import { Lite, LiteImp } from '../entities/lite';
import { PropertyRoute, PropertyRouteType } from '../entities/propertyRoute';
import { RuntimeType, ArrayType, LiteType, ClassType, EnumType as RuntimeEnumType, LiteralType, TemporalType } from '../entities/runtimeTypes';
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

// Signum's getTypeInfos(name): the @implementedBy name is a ", "-separated list of clean names;
// split + resolve each. "[ALL]" (IsByAll) and "" resolve to no concrete types. (altea takes the
// name string directly — TypeReference is gone; callers pass runtimeTypeName(rt) for a query column.)
export function getTypeInfos(typeName: string): TypeInfo[] {
  if (typeName === IsByAll || typeName === "") return [];
  return typeName.split(", ").map(n => getTypeInfo(n));
}

export function tryGetTypeInfos(typeName: string): (TypeInfo | undefined)[] {
  if (typeName === IsByAll || typeName === "") return [];
  return typeName.split(", ").map(n => tryGetTypeInfo(n));
}

// ---- Query-layer type metadata (Signum's TypeReference / is*Type / QueryKey / QueryTokenString) --

// altea has NO TypeReference (Signum's { name, isCollection, isLite, … } wire shape). A query
// column's type is a RuntimeType (QueryToken.type); a field's is a FieldInfo. These helpers give the
// query-column side the few facts Signum read off TypeReference, straight from the RuntimeType.

// The clean type name of a RuntimeType (unwrapping Lite/collection); "" for unknown.
export function runtimeTypeName(rt: RuntimeType): string {
  if (rt instanceof ArrayType) return rt.elementType ? runtimeTypeName(rt.elementType) : "";
  if (rt instanceof LiteType) return runtimeTypeName(rt.entityType);
  if (rt instanceof RuntimeEnumType) return rt.enumName;
  if (rt instanceof LiteralType) return rt.typeName;
  if (rt instanceof TemporalType) return rt.kind == "date" ? "PlainDate" : rt.kind == "duration" ? "Duration" : "PlainDateTime";
  if (rt instanceof ClassType) return cleanTypeName(rt.constructorFunction);
  return "";
}

export function isRuntimeCollection(rt: RuntimeType): boolean { return rt instanceof ArrayType; }
export function isRuntimeLite(rt: RuntimeType): boolean { return rt instanceof LiteType; }
export function isRuntimeEmbedded(rt: RuntimeType): boolean {
  return rt instanceof ClassType && (rt.constructorFunction === EmbeddedEntity || rt.constructorFunction.prototype instanceof EmbeddedEntity);
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

// Ported from Signum Reflection.ts — number formatting helpers used by the Lines value editors.
// Divergence: Signum reads a configurable NumberFormatSettings.Options.defaultNumberFormatLocale;
// altea defaults to the browser locale (undefined) until a settings layer lands.
export function toNumberFormat(format: string | undefined, locale?: string): Intl.NumberFormat {
  let loc = locale;
  if (loc?.startsWith("es-")) {
    loc = "de-DE"; //fix problem for Intl formatting "es" numbers for 4 digits over decimal point
  }
  return new Intl.NumberFormat(loc, toNumberFormatOptions(format));
}

export function toNumberFormatOptions(format: string | undefined): Intl.NumberFormatOptions | undefined {

  if (format == undefined)
    return undefined;

  const f = format.toUpperCase();

  function parseIntDefault(str: string, defaultValue: number) {
    var result = parseInt(str);
    if (isNaN(result))
      return defaultValue;

    return result;
  }

  if (f.startsWith("C")) //unit comes separated
    return { style: "decimal", minimumFractionDigits: parseIntDefault(f.after("C"), 2), maximumFractionDigits: parseIntDefault(f.after("C"), 2), useGrouping: true };

  if (f.startsWith("N"))
    return { style: "decimal", minimumFractionDigits: parseIntDefault(f.after("N"), 2), maximumFractionDigits: parseIntDefault(f.after("N"), 2), useGrouping: true };

  if (f.startsWith("D"))
    return { style: "decimal", maximumFractionDigits: 0, minimumIntegerDigits: parseIntDefault(f.after("D"), 1), useGrouping: false };

  if (f.startsWith("F"))
    return { style: "decimal", minimumFractionDigits: parseIntDefault(f.after("F"), 2), maximumFractionDigits: parseIntDefault(f.after("F"), 2), useGrouping: false };

  if (f.startsWith("E"))
    return { style: "decimal", notation: "scientific", minimumFractionDigits: parseIntDefault(f.after("E"), 6), maximumFractionDigits: parseIntDefault(f.after("E"), 6), useGrouping: false } as any;

  if (f.startsWith("P"))
    return { style: "percent", minimumFractionDigits: parseIntDefault(f.after("P"), 2), maximumFractionDigits: parseIntDefault(f.after("P"), 2), useGrouping: false };

  if (f.startsWith("K"))
    return { style: "decimal", minimumFractionDigits: parseIntDefault(f.after("K"), 2), maximumFractionDigits: parseIntDefault(f.after("K"), 2), notation: "compact", useGrouping: true };

  //simple heuristic
  var regex = /(?<plus>\+)?(?<body>[0#,.]+)(?<suffix>[%MKB])?/;
  const match = regex.exec(f);
  var body = match?.groups?.body ?? f;
  const suffix = match?.groups?.suffix;
  var afterDot = body.tryAfter(".") ?? "";
  const result: Intl.NumberFormatOptions = {
    style: suffix == "%" ? "percent" : "decimal",
    minimumFractionDigits: afterDot.replaceAll("#", "").length,
    maximumFractionDigits: afterDot.length,
    useGrouping: f.contains(","),
  };

  if (match?.groups?.plus)
    (result as any).signDisplay = "always";

  return result;
}

// C#-numeric-type min/max ranges (Signum's numberLimits). altea value types are "Number"/"Decimal",
// so a lookup by altea type name returns undefined ⇒ no overflow guard (acceptable). Kept keyed by
// the C# names for when the vocabulary is reconciled.
export const numberLimits: {
  [numType: string]: { min: number, max: number }
} = {
  "sbyte": { min: -128, max: 127 },
  "byte": { min: 0, max: 255 },
  "short": { min: -32768, max: 32767 },
  "ushort": { min: 0, max: 65535 },
  "int": { min: -2147483648, max: 2147483647 },
  "uint": { min: 0, max: 4294967295 },
  "long": { min: -9223372036854775808, max: 9223372036854775807 },
  "ulong": { min: 0, max: 18446744073709551615 },
  "float": { min: -3.402823E+38, max: 3.402823E+38 },
  "double": { min: -1.7976931348623157E+308, max: 1.7976931348623157E+308 },
  "decimal": { min: -79228162514264337593543950335, max: 79228162514264337593543950335 }
};

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
