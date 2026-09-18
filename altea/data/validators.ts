
import { getOrCreateTypeInfo, getOrCreateFieldInfo, tryGetTypeInfo, Validator, registerImplicitNotNullValidator } from './reflection';
import type { FieldInfo, IntegrityCheckEnvironment, FieldInfoOf } from './reflection';
import type { BaseEntity } from './entity';
import { msg } from './utils/localization';
import { Decimal, Temporal } from './basics';
import { DateTimePrecision, getPrecision } from './globals/dateTimeExtensions';
import { Enum } from './enum';
import { registerEnum } from './registration';

export { Validator } from './reflection';
// The vocabulary `@dateTimePrecisionValidator` takes, re-exported so a declaring entity imports the
// decorator and its argument from one place (it LIVES in globals/dateTimeExtensions, which is where
// Signum declares it too — DateTimeExtensions.cs, not the validation file).
export { DateTimePrecision } from './globals/dateTimeExtensions';

export const ValidationMessage = {
    _0MustHaveAtMost1Characters: msg(),
    _0MustHaveAtLeast1Characters: msg(),
    _0DoesNotHaveAValid1Format: msg(),
    _0HasSomeRepeatedElements1: msg("{0} has some repeated elements: {1}"),
    _0IsNotSet: msg("{0} is not set"),
    _0ShouldBeNull: msg("{0} should be null"),
    _0IsSet: msg("{0} is set"),
    _0ShouldBe1: msg("{0} should be {1}"),
    _0ShouldBe12: msg("{0} should be {1} {2}"),
    _0IsMandatoryWhen1IsNotSet: msg("{0} is mandatory when {1} is not set"),
    _0IsMandatoryWhen1IsSet: msg("{0} is mandatory when {1} is set"),
    _0IsMandatoryWhen1IsSetTo2: msg("{0} is mandatory when {1} is set to {2}"),
    _0ShouldBeNullWhen1IsNotSet: msg("{0} should be null when {1} is not set"),
    _0ShouldBeNullWhen1IsSet: msg("{0} should be null when {1} is set"),
    _0ShouldBeNullWhen1IsSetTo2: msg("{0} should be null when {1} is set to {2}"),
    NumberIsTooSmall: msg("Number is too small"),
    NumberIsTooBig: msg("Number is too big"),
    EachRowRepresentsAGroupOf0WithSame1: msg("Each row represents a group of {0} with same {1}"),
    TheNumberOf0IsBeingMultipliedBy1: msg("The number of {0} is being multiplied by {1}"),
    TheNumberOfElementsOf0HasToBe12: msg("The number of elements of {0} has to be {1} {2}"),
    HaveANumberOfElements01: msg("have a number of elements {0} {1}"),
    _0HasToBe12: msg("{0} has to be {1} {2}"),
    BeA01: msg("be {0} {1}"),
    _0HasMoreThan1DecimalPlaces: msg("{0} has more than {1} decimal places"),
    Have0Decimals: msg("have {0} decimals"),
    _0HasAPrecisionOf1InsteadOf2: msg("{0} has a precision of {1} instead of {2}"),
    HaveAPrecisionOf0: msg("have a precision of {0}"),
    _0HasToBeUppercase: msg("{0} has to be uppercase"),
    _0HasToBeLowercase: msg("{0} has to be lowercase"),
    Be0: msg("be {0}"),
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

// --- @validate ---

/**
 * `@validate<T>((e, fi, env) => message | null)` — Signum's `StaticPropertyValidation`, and the escape
 * hatch for a rule no declarative validator can express. Answers the error message, or null when the
 * value is fine.
 *
 * WRITE THE TYPE ARGUMENT, as `@isReadOnly` wants it: it is what types `entity` and narrows `fi.name` to
 * the type's members ({@link MemberOf}), so a member named in the body is checked. There is no default,
 * so forgetting it makes the body fail to compile rather than silently checking nothing.
 *
 * It runs after this field's declared validators and the global pass, and it may be ASYNC — a validation
 * that has to open a file, resolve query tokens or hit the database cannot be synchronous. An async one
 * runs ONLY on the awaiting paths (the save and deserialization passes, and /api/validateEntity), never
 * in the client's live per-keystroke path; see `FieldInfo.validate`.
 *
 * On a MIXIN's field it belongs on the mixin, where the field is declared — and it is honoured there,
 * because every reader resolves a field through `resolveField` / `eachFieldInfo`, which walk the declared
 * mixins as well as the type itself.
 *
 * A rule that needs the OWNER of the entity it validates reads it with `tryGetParentEntity` — mark the
 * field holding the child `@bindParent` (see data/parentEntity), which is how an order LINE validates
 * against its order.
 */
export function validate<T>(
    fn: (entity: T, fi: FieldInfoOf<T>, env: IntegrityCheckEnvironment) => string | null | undefined | Promise<string | null | undefined>,
) {
    return (target: object, propertyKey: string | symbol) => {
        const typeInfo = getOrCreateTypeInfo(target);
        getOrCreateFieldInfo(typeInfo, String(propertyKey)).customValidation =
            fn as FieldInfo["customValidation"];
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
    return (target: object, propertyKey: string | symbol) => {
        addValidator(target, propertyKey, new StringLengthValidator(options), options);
        // Stamped onto the FieldInfo the way `decimalsValidator` stamps `decimalPlaces`, because the six
        // readers are CLIENT components that hold a `MemberInfo`, not a validator list: AutoLine's
        // textarea dispatch, TextAreaLine's `maxLength` attribute and character counter, FinderRules'
        // multi-line cell, SearchValue's filter editor. Signum fills both from the validator in
        // `Reflector`, and both members have been declared on FieldInfo all along — with nothing writing
        // them, so `multiLine: true` never actually produced a textarea (SMSMessageEntity.message among
        // others) and no input ever carried its maximum length.
        const fi = getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey));
        if (options.max != null) fi.maxLength = options.max;
        if (options.multiLine != null) fi.isMultiline = options.multiLine;
    };
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

// --- DecimalsValidator ---
//
// Signum's [DecimalsValidator(n)], and it does TWO things — which is the point of having it rather than
// stating each half separately:
//
//  • it validates that the value really has at most n decimal places, and
//  • it is where the COLUMN'S SCALE comes from. `SchemaSettings.GetSqlScale` reads it (after an explicit
//    [DbType(Scale=…)] and before the numeric(18,2) money default), and `Reflector.GetFormatString`
//    reads it too, as "N" + n, after an explicit [Format] and before the type default.
//
// So one `@decimalsValidator(4)` says what `@column({ scale: 4 })` + `@format("N4")` + a hand-written
// check would have said three times, and says it the way Signum says it — which matters because a
// property's decimals are a modelling fact about the VALUE, not a fact about its storage.
//
// altea divergence: Signum's consumers reach the attribute through
// `Validator.TryGetPropertyValidator(route)`, walking the validator list. altea records `decimalPlaces`
// on the FieldInfo as well, because FieldInfo IS altea's reflection surface on both tiers (the same
// reason @format / @unit write straight onto it) and because `reflection.ts` cannot import this module
// to read the validator back — it is the module that defines Validator.

export interface DecimalsOptions extends ValidatorOptions {
    /** Signum's `DecimalPlaces`, defaulting to 2 as its parameterless ctor does. */
    decimalPlaces?: number;
}

export function decimalsValidator(decimalPlaces?: number, options?: DecimalsOptions): (target: object, propertyKey: string | symbol) => void;
export function decimalsValidator(options: DecimalsOptions): (target: object, propertyKey: string | symbol) => void;
export function decimalsValidator(arg1?: number | DecimalsOptions, arg2?: DecimalsOptions) {
    const options: DecimalsOptions = typeof arg1 === "number" ? { ...arg2, decimalPlaces: arg1 } : (arg1 ?? {});
    const decimalPlaces = options.decimalPlaces ?? 2;
    return (target: object, propertyKey: string | symbol) => {
        addValidator(target, propertyKey, new DecimalsValidator({ ...options, decimalPlaces }), options);
        // The schema (column scale) and the UI (display format) read it from here — see the note above.
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).decimalPlaces = decimalPlaces;
    };
}

export class DecimalsValidator extends Validator {
    constructor(public readonly options: DecimalsOptions = {}) { super(); }

    get decimalPlaces(): number { return this.options.decimalPlaces ?? 2; }

    // Signum restricts this to `decimal`. altea spells a decimal two ways — the decimal.js `Decimal`
    // class and the branded `decimal` number alias — and both are the same modelling type.
    isCompatibleWith(type: Function) { return type === Decimal || type === Number; }

    get helpMessage(): string { return ValidationMessage.Have0Decimals.niceToString(this.decimalPlaces); }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        if (value == null)
            return null;
        const places = this.decimalPlaces;
        // Signum: `Math.Round(value, DecimalPlaces) != value`. decimal.js rounds exactly, which is the
        // whole reason a money value is a Decimal and not a double.
        if (value instanceof Decimal)
            return value.toDecimalPlaces(places).equals(value)
                ? null
                : ValidationMessage._0HasMoreThan1DecimalPlaces.niceToString(fi.niceToString(), places);
        if (typeof value === "number") {
            // A plain number cannot be compared by rounding without reintroducing binary-float error
            // (0.145 is not 0.145), so compare the DECIMAL STRING's fraction length instead.
            const fraction = decimalFractionLength(value);
            return fraction <= places
                ? null
                : ValidationMessage._0HasMoreThan1DecimalPlaces.niceToString(fi.niceToString(), places);
        }
        return null;
    }
}

// How many digits a number's shortest decimal representation has after the point (0 for an integer, and
// for one written in exponent form with a positive exponent).
function decimalFractionLength(value: number): number {
    if (!Number.isFinite(value))
        return 0;
    const text = String(value);
    const exp = text.indexOf("e");
    if (exp >= 0) {
        const mantissa = text.slice(0, exp);
        const power = Number(text.slice(exp + 1));
        const dot = mantissa.indexOf(".");
        const digits = dot < 0 ? 0 : mantissa.length - dot - 1;
        return Math.max(0, digits - power);
    }
    const dot = text.indexOf(".");
    return dot < 0 ? 0 : text.length - dot - 1;
}

// --- DateTimePrecisionValidator ---
//
// Signum's [DateTimePrecisionValidator(DateTimePrecision.Seconds)], the DATE sibling of DecimalsValidator
// and, like it, more than a check — it is the one place a property says how far along a date it means,
// and four readers take it from there:
//
//  • it validates that the value is not FINER than that (a stored 12:30:45.123 where seconds were
//    promised is a lie the next round-trip may quietly change);
//  • it is where the DISPLAY FORMAT comes from (`Reflector.GetFormatString`, altea's defaultFormat) —
//    a date declared to the second shows its seconds, one declared to the day shows no time at all;
//  • it TRIMS the query token's date sub-tokens (Signum's EntityPropertyToken/ColumnToken pass it to
//    DateTimeProperties): no `Second` column under a date that never has one;
//  • and `Days` precision is what makes a DateTime GROUPABLE (QueryToken.IsGroupable) — grouping rows by
//    the millisecond is never meant, grouping them by the day is the whole point.
//
// It does NOT size the column, though the shape invites it: Signum's `SchemaSettings.GetSqlPrecision`
// has the corresponding validator lookup COMMENTED OUT, and its DDL renders a precision only for a
// decimal (`SqlBuilder.GetSizePrecisionScale` gates on IsDecimal). So a `datetime2`/`timestamp` keeps the
// provider default width in both frameworks, and altea's getSqlSize/precision stay as they are — the
// StringLengthValidator→size and DecimalsValidator→scale derivations have no third sibling here.
//
// altea divergences: the precision is copied onto the FieldInfo for the ONE reader that cannot walk the
// validator list (defaultFormat, inside reflection.ts — see FieldInfo.dateTimePrecision; the query
// tokens read the validator itself), and both messages name the precision through
// `Enum.niceName` — Signum's error interpolates the raw enum member, because string.Format calls
// ToString(), so its "has a precision of Milliseconds instead of Seconds" stays English in every culture.

export interface DateTimePrecisionOptions extends ValidatorOptions { }

export function dateTimePrecisionValidator(precision: DateTimePrecision, options: DateTimePrecisionOptions = {}) {
    return (target: object, propertyKey: string | symbol) => {
        addValidator(target, propertyKey, new DateTimePrecisionValidator(precision), options);
        // ONLY `defaultFormat` reads this copy — see the note above and FieldInfo.dateTimePrecision.
        getOrCreateFieldInfo(getOrCreateTypeInfo(target), String(propertyKey)).dateTimePrecision =
            Enum.toName(DateTimePrecision, precision);
    };
}

export class DateTimePrecisionValidator extends Validator {
    constructor(public readonly precision: DateTimePrecision) { super(); }

    isCompatibleWith(type: Function) { return type === Temporal.PlainDateTime || type === Temporal.PlainDate; }

    get helpMessage(): string {
        return ValidationMessage.HaveAPrecisionOf0.niceToString(this.precisionName().toLowerCase());
    }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        if (value == null)
            return null;
        if (!(value instanceof Temporal.PlainDateTime) && !(value instanceof Temporal.PlainDate))
            return null;

        const actual = getPrecision(value);
        return actual > this.precision
            ? ValidationMessage._0HasAPrecisionOf1InsteadOf2.niceToString(
                fi.niceToString(), Enum.niceName(DateTimePrecision, actual), this.precisionName())
            : null;
    }

    private precisionName(): string { return Enum.niceName(DateTimePrecision, this.precision); }
}

// --- StringCaseValidator ---
//
// Signum's [StringCaseValidator(StringCase.Uppercase)] and the enum it takes, which Signum declares in
// the SAME file as the validator (Entities/Validation/ValidationAttributes.cs) rather than in a
// utilities module — so both live here, unlike DateTimePrecision.
//
// It only REPORTS. Signum's OverrideError compares the string against its own ToUpper()/ToLower() and
// returns a message; it never writes the corrected value back, and neither does this. A validator that
// silently rewrote what the user typed would make `entity.isDirty()` true after a save and would hide a
// paste of the wrong text rather than surface it.
//
// Divergence, deliberate: Signum's `Reflector.GetFormatString` ALSO derives a format string from this
// validator — "U" or "L" — and nothing in Signum reads it back (no formatter, client or server, handles
// either specifier), so altea does not produce one. Unlike DateTimePrecision there is no second reader,
// which is why nothing is copied onto the FieldInfo either: the schema does not consult it (a string's
// column comes from StringLengthValidator's max), and the query tokens do not.

export enum StringCase {
    Uppercase,
    Lowercase,
}
export type StringCaseKeys = keyof typeof StringCase;

// No entity FIELD is of this type, so nothing auto-registers it — same reason DateTimePrecision needs the
// hand-written call. Without a registered NAME `Enum.niceName` (which the help message below reads) has
// no translation key and falls back to the English identifier in every culture. Registering creates no
// table; the schema builder only builds one where a FieldEnum references the type.
registerEnum(StringCase);

export interface StringCaseOptions extends ValidatorOptions { }

export function stringCaseValidator(textCase: StringCase, options: StringCaseOptions = {}) {
    return (target: object, propertyKey: string | symbol) =>
        addValidator(target, propertyKey, new StringCaseValidator(textCase), options);
}

export class StringCaseValidator extends Validator {
    constructor(public readonly textCase: StringCase) { super(); }

    isCompatibleWith(type: Function) { return type === String; }

    // Signum: ValidationMessage.Be0.NiceToString(textCase.NiceToString()) — the member's nice name, not
    // lower-cased, because "Uppercase" / "Lowercase" is how the value reads in a sentence.
    get helpMessage(): string {
        return ValidationMessage.Be0.niceToString(Enum.niceName(StringCase, this.textCase));
    }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const s = value as string | null | undefined;
        if (s == null || s === '') return null;

        if (this.textCase === StringCase.Uppercase && s !== s.toUpperCase())
            return ValidationMessage._0HasToBeUppercase.niceToString(fi.niceToString());

        if (this.textCase === StringCase.Lowercase && s !== s.toLowerCase())
            return ValidationMessage._0HasToBeLowercase.niceToString(fi.niceToString());

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

// --- NumberIsValidator ---
//
// Signum's [NumberIsValidator(ComparisonType, number)] — the SCALAR sibling of CountIsValidator, bounding
// a number's own value rather than a collection's length:
//   @numberIsValidator(ComparisonType.GreaterThan, 0)          // strictly positive
//   @numberIsValidator(ComparisonType.LessThanOrEqualTo, 100)  // at most 100
//
// Unlike the collection version this does NOT imply mandatory: "greater than zero" says nothing about
// whether the field may be null, and the implicit NotNull already covers a non-nullable declaration. A
// NULL value passes, exactly as Signum's does — a bound is about the value that IS there, and requiring
// one is a different rule with its own validator.

export interface NumberIsOptions extends ValidatorOptions { }

export function numberIsValidator(comparison: ComparisonType, number: number, options: NumberIsOptions = {}) {
    return (target: object, propertyKey: string | symbol) =>
        addValidator(target, propertyKey, new NumberIsValidator(comparison, number), options);
}

export class NumberIsValidator extends Validator {
    constructor(public readonly comparison: ComparisonType, public readonly number: number) { super(); }

    isCompatibleWith(type: Function) { return type === Number; }

    get helpMessage(): string {
        return ValidationMessage.BeA01.niceToString(comparisonName(this.comparison), this.number);
    }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        // Null passes — see the header.
        if (value == null)
            return null;

        const n = typeof value === "number" ? value : Number(value);
        if (Number.isNaN(n) || holds(this.comparison, n, this.number))
            return null;

        return ValidationMessage._0HasToBe12.niceToString(
            fi.niceToString(), comparisonName(this.comparison), this.number);
    }
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
// Built from the member name rather than through `Enum.niceName`, because ComparisonType is not
// REGISTERED (no entity field is of that type and nothing calls registerEnum for it), so there is no
// translation for niceName to find and it would humanise the same identifier by a longer route.
// Contrast DateTimePrecision, which is registered and therefore does go through Enum.niceName.
function comparisonName(comparison: ComparisonType): string {
    const name = ComparisonType[comparison];
    const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toLowerCase() + spaced.slice(1);
}
