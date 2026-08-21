
import { getOrCreateTypeInfo, getOrCreateFieldInfo, tryGetTypeInfo, Validator, registerImplicitNotNullValidator } from './reflection';
import type { FieldInfo, IntegrityCheckEnvironment } from './reflection';
import type { BaseEntity } from './entity';
import { msg } from './utils/localization';

export { Validator } from './reflection';

export const ValidationMessage = {
    _0MustHaveAtMost1Characters: msg(),
    _0MustHaveAtLeast1Characters: msg(),
    _0DoesNotHaveAValid1Format: msg(),
    _0HasSomeRepeatedElements1: msg("{0} has some repeated elements: {1}"),
    _0IsNotSet: msg("{0} is not set"),
    _0ShouldBeNull: msg("{0} should be null"),
    _0IsSet: msg("{0} is set"),
    _0ShouldBe1: msg("{0} should be {1}"),
    NumberIsTooSmall: msg("Number is too small"),
    NumberIsTooBig: msg("Number is too big"),
    EachRowRepresentsAGroupOf0WithSame1: msg("Each row represents a group of {0} with same {1}"),
    TheNumberOf0IsBeingMultipliedBy1: msg("The number of {0} is being multiplied by {1}"),
    TheNumberOfElementsOf0HasToBe12: msg("The number of elements of {0} has to be {1} {2}"),
    HaveANumberOfElements01: msg("have a number of elements {0} {1}"),
};

// Signum's ComparisonType (Entities/Validation/ValidationAttributes.cs) — how a count / number validator
// compares. A real altea enum object so `Enum.niceName` gives it a translatable display name.
export enum ComparisonType {
    EqualTo,
    DistinctTo,
    GreaterThan,
    GreaterThanOrEqualTo,
    LessThan,
    LessThanOrEqualTo,
}

// Options common to EVERY validator (they map to fields on the base Validator, so any validator can
// carry them). Each specific options interface extends this, and `addValidator` applies them uniformly.
export interface ValidatorOptions {
    // Per-environment opt-out (Signum's Disabled / DisabledInModelBinder, generalised). Return true to
    // SKIP this validator in that phase: `() => true` (always off), `env => env === "Client"` (server-only),
    // `env => env !== "Saving"` (only at save). See Validator.disabled / IntegrityCheckEnvironment.
    disabled?: (env: IntegrityCheckEnvironment) => boolean;
    // Only validate when this predicate holds for the entity (Signum's ValidatorAttribute.IsApplicable).
    isApplicable?: (entity: any) => boolean;
}

function addValidator(target: object, propertyKey: string | symbol, validator: Validator, options?: ValidatorOptions): void {
    if (options?.disabled != null) validator.disabled = options.disabled;
    if (options?.isApplicable != null) validator.isApplicable = options.isApplicable;
    const typeInfo = getOrCreateTypeInfo(target);
    getOrCreateFieldInfo(typeInfo, String(propertyKey)).validators.push(validator);
}

// --- NotNullValidator ---
//
// Signum auto-adds one of these to every non-nullable property that does not already declare one (see
// FieldInfo.getImplicitNotNull / computeNeedsImplicitNotNull). Declare it explicitly only to OVERRIDE
// that default — most often to opt OUT of a required non-nullable field:
//   @notNullValidator({ disabled: () => true })                 // never required
//   @notNullValidator({ disabled: env => env === "Client" })    // required, but not on the client
// A non-null @backReference / @rowOrder is exempt automatically (wired by the save cascade), no opt-out needed.

export function notNullValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new NotNullValidator(), options);
}

export class NotNullValidator extends Validator {
    override get isNotNull(): boolean { return true; }
    get helpMessage() { return 'be set'; }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        // Signum's NotNullValidator: null OR empty string counts as "not set". `== null` is the safe
        // null/undefined test (never calls valueOf, unlike `== ""` on a Temporal — see AutoLine); the
        // `=== ""` is a strict compare that only matches actual empty strings. (The disabled/env opt-out
        // is handled once, in Validator.error.)
        if (value == null || value === '')
            return ValidationMessage._0IsNotSet.niceToString(fi.niceToString());
        return null;
    }
}

// Register the factory the reflection layer uses to build the IMPLICIT NotNull it auto-adds (kept here,
// with the class, to avoid a reflection→validators import cycle).
registerImplicitNotNullValidator(() => new NotNullValidator());

// --- fieldValidation ---

export function customValidators<T>(
    fn: (entity: T, fi: FieldInfo, env: IntegrityCheckEnvironment) => string | null | undefined | Promise<string | null | undefined>,
) {
    return (target: object, propertyKey: string | symbol) => {
        const typeInfo = getOrCreateTypeInfo(target);
        getOrCreateFieldInfo(typeInfo, String(propertyKey)).customValidation = fn;
    };
}

// --- StringLengthValidator ---

export interface StringLengthOptions extends ValidatorOptions {
    min?: number;
    max?: number;
    allowNulls?: boolean;
    multiLine?: boolean;
}

export function stringLengthValidator(options: StringLengthOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new StringLengthValidator(options), options);
}

export class StringLengthValidator extends Validator {
    constructor(public readonly options: StringLengthOptions = {}) { super(); }

    isCompatibleWith(type: Function) { return type === String; }

    get helpMessage(): string {
        const { min, max } = this.options;
        if (min != null && max != null) return `have between ${min} and ${max} characters`;
        if (min != null) return `have at least ${min} characters`;
        if (max != null) return `have at most ${max} characters`;
        return 'be a string';
    }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const s = value as string | null | undefined;
        if (s == null || s === '') return null;
        const { min, max } = this.options;
        if (max != null && s.length > max)
            return ValidationMessage._0MustHaveAtMost1Characters.niceToString(fi.niceToString(), max);
        if (min != null && s.length < min)
            return ValidationMessage._0MustHaveAtLeast1Characters.niceToString(fi.niceToString(), min);
        return null;
    }
}

// --- UrlValidator ---

const urlRegex = /^(https?:\/\/)[^\s/$.?#].[^\s]*$/i;

export function urlValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new UrlValidator(), options);
}

export class UrlValidator extends Validator {
    isCompatibleWith(type: Function) { return type === String; }
    get helpMessage() { return 'be a valid URL'; }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const s = value as string | null | undefined;
        if (s == null || s === '') return null;
        return urlRegex.test(s) ? null : ValidationMessage._0DoesNotHaveAValid1Format.niceToString(fi.niceToString(), 'URL');
    }
}

// --- TelephoneValidator ---

const telephoneRegex = /^[\d+\-/() ]+$/;

export function telephoneValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new TelephoneValidator(), options);
}

export class TelephoneValidator extends Validator {
    isCompatibleWith(type: Function) { return type === String; }
    get helpMessage() { return 'be a valid telephone number'; }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const s = value as string | null | undefined;
        if (s == null || s === '') return null;
        return telephoneRegex.test(s) ? null : ValidationMessage._0DoesNotHaveAValid1Format.niceToString(fi.niceToString(), 'telephone number');
    }
}

// --- EmailValidator ---

const emailRegex = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/i;

export function emailValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new EmailValidator(), options);
}

export class EmailValidator extends Validator {
    isCompatibleWith(type: Function) { return type === String; }
    get helpMessage() { return 'be a valid e-mail address'; }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const s = value as string | null | undefined;
        if (s == null || s === '') return null;
        return emailRegex.test(s) ? null : ValidationMessage._0DoesNotHaveAValid1Format.niceToString(fi.niceToString(), 'e-mail address');
    }
}

// --- NoRepeatValidator ---
//
// Signum's [NoRepeatValidator] compares the MList's ELEMENTS, which for an `MList<Lite<T>>` / `MList<Symbol>`
// are the values themselves. altea has no MList: such a collection is an array of `@part` ROWS whose
// `@valueField` holds the value (see the MList divergence in CLAUDE.md). Comparing the ROWS would compare
// object identity — every row is a distinct object, so nothing would EVER be reported as repeated. So a row
// with a `@valueField` is compared through THAT field, which is the element Signum saw.

export function noRepeatValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new NoRepeatValidator(), options);
}

export class NoRepeatValidator extends Validator {
    isCompatibleWith(type: Function) { return type === Array; }
    get helpMessage() { return 'have no repeated elements'; }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const list = value as unknown[] | null | undefined;
        if (list == null || list.length <= 1) return null;

        const seen = new Map<string, unknown>();
        const repeated: unknown[] = [];
        for (const item of list) {
            const element = valueOfElement(item);
            const key = comparisonKey(element);
            if (seen.has(key)) repeated.push(element);
            else seen.set(key, element);
        }

        return repeated.length > 0
            ? ValidationMessage._0HasSomeRepeatedElements1.niceToString(fi.niceToString(),
                repeated.map(r => String(r)).join(', '))
            : null;
    }
}

/** The ELEMENT a collection item stands for: a `@part` row's `@valueField` when it has one, else the item. */
function valueOfElement(item: unknown): unknown {
    if (item == null || typeof item !== 'object')
        return item;

    const valueField = tryGetTypeInfo(item.constructor)?.valueField;
    return valueField == null ? item : (item as Record<string, unknown>)[valueField.name];
}

/** A stable string identity for the comparison. Lites / entities compare by their KEY (a Lite is a fresh
 *  object on every read, so reference equality is wrong); everything else by value, with a type tag so
 *  `1` and `"1"` stay distinct. Two rows with no valueField still compare by reference, as before. */
function comparisonKey(element: unknown): string {
    if (element == null)
        return 'null';

    const asLite = element as { entityType?: { name?: string }; id?: unknown; key?: () => string };
    if (typeof asLite.key === 'function' && asLite.entityType != null)
        return 'lite:' + asLite.key();

    const asEntity = element as { toLite?: () => { key(): string }; idOrNull?: unknown; id?: unknown };
    if (typeof asEntity.toLite === 'function' && asEntity.id != null)
        return 'entity:' + asEntity.toLite!().key();

    if (typeof element === 'object')
        return 'ref:' + (referenceIds.get(element as object) ?? setReferenceId(element as object));

    return typeof element + ':' + String(element);
}

// Reference identity for the objects that have no value identity (an embedded, a row with no valueField):
// they must still compare as themselves, and a WeakMap gives each one a stable tag without leaking.
const referenceIds = new WeakMap<object, number>();
let nextReferenceId = 0;
function setReferenceId(o: object): number {
    const id = nextReferenceId++;
    referenceIds.set(o, id);
    return id;
}

// --- CountIsValidator ---
//
// Signum's [CountIsValidator(ComparisonType, number)] — how MANY elements a collection must hold:
//   @countIsValidator(ComparisonType.GreaterThan, 0)        // at least one — and MANDATORY in the UI
//   @countIsValidator(ComparisonType.GreaterThan, 1)        // at least two
//   @countIsValidator(ComparisonType.LessThanOrEqualTo, 5)  // at most five
//
// `GreaterThan 0` / `GreaterThanOrEqualTo 1` are Signum's `IsGreaterThanZero`: they mean "non-empty", which
// is what makes the LINE mandatory (the red/asterisked label). altea surfaces that through
// `Validator.isGreaterThanZero`, which the client's taskSetMandatory reads — a collection is otherwise never
// mandatory (a non-null array means "not null", not "non-empty"; see FieldInfo.computeNeedsImplicitNotNull).

export interface CountIsOptions extends ValidatorOptions { }

export function countIsValidator(comparison: ComparisonType, number: number, options: CountIsOptions = {}) {
    return (target: object, propertyKey: string | symbol) =>
        addValidator(target, propertyKey, new CountIsValidator(comparison, number), options);
}

export class CountIsValidator extends Validator {
    constructor(public readonly comparison: ComparisonType, public readonly number: number) { super(); }

    isCompatibleWith(type: Function) { return type === Array; }

    /** Signum's IsGreaterThanZero — the two spellings of "non-empty" (see the header). */
    override get isGreaterThanZero(): boolean {
        return (this.comparison === ComparisonType.GreaterThan && this.number === 0)
            || (this.comparison === ComparisonType.GreaterThanOrEqualTo && this.number === 1);
    }

    get helpMessage(): string {
        return ValidationMessage.HaveANumberOfElements01.niceToString(comparisonName(this.comparison), this.number);
    }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const list = value as unknown[] | null | undefined;
        const count = list == null ? 0 : list.length;

        if (holds(this.comparison, count, this.number))
            return null;

        return ValidationMessage.TheNumberOfElementsOf0HasToBe12.niceToString(
            fi.niceToString(), comparisonName(this.comparison), this.number);
    }
}

function holds(comparison: ComparisonType, value: number, target: number): boolean {
    switch (comparison) {
        case ComparisonType.EqualTo: return value === target;
        case ComparisonType.DistinctTo: return value !== target;
        case ComparisonType.GreaterThan: return value > target;
        case ComparisonType.GreaterThanOrEqualTo: return value >= target;
        case ComparisonType.LessThan: return value < target;
        case ComparisonType.LessThanOrEqualTo: return value <= target;
    }
}

// Signum's `ComparisonType.NiceToString().FirstLower()` — "greater than", "less than or equal to", …
// Built from the member name rather than through `Enum.niceName`, so validators.ts stays free of the
// enum-registry import (this module is loaded very early, next to reflection).
function comparisonName(comparison: ComparisonType): string {
    const name = ComparisonType[comparison];
    const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toLowerCase() + spaced.slice(1);
}
