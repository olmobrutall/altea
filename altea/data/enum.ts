import { enumNameOf } from './registration';
import { Localization } from './utils/localization';

// A single entity-level helper over altea's numeric TS enums (the runtime `XEnum` objects paired with
// the string-union `type X = keyof typeof XEnum`). It replaces both the per-enum `enumAccessors`
// companions that lived in dynamicQueries.ts and the react-layer `EnumType<T>` class — one API, used as
// `Enum.values(FilterOperationEnum)` / `Enum.niceName(FilterOperationEnum, "EqualTo")`.
//
// These are always NUMBER ↔ STRING enums: a member's value is its numeric ordinal, its name is the
// string. `Enum` is not for string-valued enums. So the MEMBER argument accepts either the string name
// ("EqualTo") or the numeric member (FilterOperationEnum.EqualTo) — `toName` normalises to the name,
// which is altea's wire/runtime value.
//
// `niceName` / `niceTypeName` are localisation-backed: they consult the reflection translations blob
// (DescriptionManager) for the current UI culture and fall back to humanising the identifier.

// A numeric TS enum's runtime object: name→ordinal (forward) and ordinal→name (reverse-map) entries.
type EnumObject = Record<string, string | number>;
// The string member NAMES of an enum object (excludes the numeric reverse-map keys).
type EnumName<E> = Extract<keyof E, string>;
// A member reference: its string name or its numeric ordinal.
type EnumValue<E> = EnumName<E> | number;

// Per-enum set of members that are NOT MAPPED — excluded both from UI value lists and, crucially, from
// the generated/synchronised enum table (Signum's `isIgnoredEnum`; consistent with altea's
// `notMapped` field concept). Keyed by the enum object identity so it needs no registration.
// `enumEntityMembers` (entities/enumEntity) consults this, so it flows into the Schema Generator and
// the Synchronizer.
const notMappedMembers = new WeakMap<object, Set<string>>();

// Per-enum code-declared DEFAULT-language member labels (Enum.setNiceName). Keyed by the enum object
// identity — the same as notMappedMembers — because an enum has no registered name at the point
// setNiceName is called (registration happens lazily when a field references the enum). Consulted by
// niceName BELOW any loaded translation, so a translation file for the current UI culture still wins.
const niceNameOverrides = new WeakMap<object, Map<string, string>>();

export namespace Enum {

  /** The member NAMES in declaration order (drops the numeric reverse-map keys). */
  export function values<E extends EnumObject>(e: E): EnumName<E>[] {
    return Object.keys(e).filter(k => isNaN(Number(k))) as EnumName<E>[];
  }

  /** Normalise a member reference (name or numeric ordinal) to its string name. */
  export function toName<E extends EnumObject>(e: E, value: EnumValue<E>): EnumName<E> {
    return (typeof value === "number" ? (e as Record<number, string>)[value] : value) as EnumName<E>;
  }

  /** The numeric ordinal for a member NAME (inverse of the reverse-map) — the runtime/stored value. */
  export function toValue<E extends EnumObject>(e: E, name: EnumName<E>): number {
    return e[name] as number;
  }

  /** A member's localised display name (translation for the current UI culture, else humanised). */
  export function niceName<E extends EnumObject>(e: E, value: EnumValue<E>): string {
    const name = toName(e, value);
    const typeName = enumNameOf(e);
    // Precedence: loaded translation (current UI culture) → code-declared default (setNiceName) →
    // humanise the (PascalCase) member name (Signum's member.NiceName() = SpacePascalOrUnderscores):
    // "Canceled" → "Canceled", "InProcess" → "In process". NOT inferDescription — that lowercases for
    // message sentences ("BeNotNull" → "be not null").
    return (typeName != null ? Localization.translate(typeName, name) : undefined)
      ?? niceNameOverrides.get(e)?.get(name)
      ?? Localization.niceMemberName(name);
  }

  /**
   * Set a member's DEFAULT-language display name in code (Signum's [Description] on an enum member),
   * e.g. `Enum.setNiceName(ColorEnum, "Weiss", "Weiß")`. This is only the no-translation default: a
   * loaded translation for the current UI culture still wins. The member accepts either its string
   * name or its numeric ordinal.
   */
  export function setNiceName<E extends EnumObject>(e: E, value: EnumValue<E>, niceName: string): void {
    let map = niceNameOverrides.get(e);
    if (map == null) niceNameOverrides.set(e, map = new Map<string, string>());
    map.set(toName(e, value), niceName);
  }

  /** The enum type's localised display name (its registered clean name, humanised). */
  export function niceTypeName<E extends EnumObject>(e: E): string | undefined {
    const typeName = enumNameOf(e);
    return typeName == null ? undefined : Localization.niceNameFromName(typeName);
  }

  /** Whether `value` is a valid member NAME of the enum. */
  export function isDefined<E extends EnumObject>(e: E, value: unknown): value is EnumName<E> {
    return typeof value === "string" && isNaN(Number(value)) && Object.prototype.hasOwnProperty.call(e, value);
  }

  /** Returns the member name, throwing if it is not a valid member of the enum. */
  export function assertDefined<E extends EnumObject>(e: E, value: EnumValue<E>): EnumName<E> {
    const name = toName(e, value);
    if (!isDefined(e, name))
      throw new Error(`'${String(value)}' is not a valid value of enum '${niceTypeName(e) ?? "?"}'`);
    return name;
  }

  /**
   * Mark members as NOT MAPPED: excluded from `mappedValues` (UI value lists) AND from the enum
   * table emitted by the Schema Generator / reconciled by the Synchronizer (via `enumEntityMembers`).
   * Use for wire-only / deprecated members that must never gain a database row.
   */
  export function markAsNotMapped<E extends EnumObject>(e: E, ...valuesToExclude: EnumValue<E>[]): void {
    let set = notMappedMembers.get(e);
    if (set == null)
      notMappedMembers.set(e, set = new Set<string>());
    for (const v of valuesToExclude)
      set.add(toName(e, v));
  }

  /** Whether a member has been marked not-mapped (consulted by schema generation / synchronization). */
  export function isNotMapped<E extends EnumObject>(e: E, value: EnumValue<E>): boolean {
    return notMappedMembers.get(e)?.has(toName(e, value)) ?? false;
  }

  /** The member names except those marked not-mapped (Signum's EnumType.notIgnoredValues). */
  export function mappedValues<E extends EnumObject>(e: E): EnumName<E>[] {
    const set = notMappedMembers.get(e);
    return values(e).filter(v => set == null || !set.has(v));
  }
}
