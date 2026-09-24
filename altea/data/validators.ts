
import { getOrCreateTypeInfo, getOrCreateFieldInfo, tryGetTypeInfo, Validator, registerImplicitNotNullValidator, MAX_SIZE } from './reflection';
import type { FieldInfo, IntegrityCheckEnvironment, FieldInfoOf } from './reflection';
import type { BaseEntity } from './entity';
import { msg } from './utils/localization';
import { Decimal, Temporal } from './basics';
import { DateTimePrecision, getPrecision, getTimePrecision } from './globals/dateTimeExtensions';
import { Clock } from './utils/clock';
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
    _0ShouldBeGreaterThan1: msg("{0} should be greater than {1}"),
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
    _0HasToBeBetween1And2: msg("{0} has to be between {1} and {2}"),
    BeBetween0And1: msg("be between {0} and {1}"),
    PowerOf: msg("power of"),
    _0ShouldBeADateInThePast: msg("{0} should be a date in the past"),
    BeInThePast: msg("be in the past"),
    _0ShouldBeADateInTheFuture: msg("{0} should be a date in the future"),
    BeInTheFuture: msg("be in the future"),
    // altea has no Signum twin: Signum's TimePrecisionValidator hard-codes "{0} has days" in English.
    // Its `IsATimeOfTheDay` member says the same thing and has never had a caller.
    _0ShouldBeATimeOfTheDay: msg("{0} should be a time of the day"),
    HaveValid0Format: msg("have a valid {0} format"),
    Telephone: msg("Telephone"),
    Numeric: msg("Numeric"),
    FileName: msg("file name"),
    BeNotNull: msg("be not null"),
    BeAString: msg("be a string"),
    BeAMultilineString: msg("be a multiline string"),
    HaveBetween0And1Characters: msg("have between {0} and {1} characters"),
    HaveMinimum0Characters: msg("have minimum {0} characters"),
    HaveMaximum0Characters: msg("have maximum {0} characters"),
    HaveNoRepeatedElements: msg("have no repeated elements"),

    // --- The rest of Signum's ValidationMessage -------------------------------------------------
    //
    // No DECORATOR in altea builds these: they are the vocabulary a hand-written rule reaches for —
    // a `@validate` method, an operation's `canExecute`, a logic-layer guard. That is exactly why they
    // belong here: a container is a framework's public surface, and an APPLICATION built on altea has
    // no other way to say "{0} and {1} can not be set at the same time" in the user's language. Several
    // have no altea caller today and are still declared, because a member the framework never declares
    // is simply unavailable to the application.
    //
    // Text is Signum's `[Description]` verbatim, with two deliberate departures, both of which the
    // members already above made first: no trailing full stop (Signum is inconsistent about it and
    // altea's `_0IsMandatoryWhen1IsSetTo2` already dropped it), and a sentence FRAGMENT — one spliced
    // into a help message rather than shown on its own — stays lowercase (`or be null`, as `be not null`
    // and `power of` are). A member Signum leaves undescribed takes its humanised name in altea's
    // sentence case ("Invalid date format"), not C#'s Title Case.
    _0DoesNotHaveAValid1IdentifierFormat: msg("'{0}' does not have a valid {1} identifier format"),
    _0HasAnInvalidFormat: msg("{0} has an invalid format"),
    _0ShouldBe1InsteadOf2: msg("{0} should be {1} instead of {2}"),
    _0IsNecessary: msg("{0} is necessary"),
    _0IsNecessaryOnState1: msg("{0} is necessary on state {1}"),
    _0IsNotAllowed: msg("{0} is not allowed"),
    _0IsNotAllowedOnState1: msg("{0} is not allowed on state {1}"),
    _0IsNotSetIn1: msg("{0} is not set in {1}"),
    _0AreNotSet: msg("{0} are not set"),
    _0IsNotA1_G: msg("{0} is not a {1}"),
    BeA0_G: msg("be a {0}"),
    InvalidDateFormat: msg("Invalid date format"),
    InvalidFormat: msg("Invalid format"),
    NotPossibleToaAssign0: msg("Not possible to assign {0}"),
    OrBeNull: msg("or be null"),
    _0ShouldHaveJustOneLine: msg("{0} should have just one line"),
    _0ShouldNotHaveInitialSpaces: msg("{0} should not have initial spaces"),
    _0ShouldNotHaveFinalSpaces: msg("{0} should not have final spaces"),
    // Signum's English says "lenght" here and "length" in the two below; the member NAME keeps the typo
    // (it is the translation key an application already references), the text does not.
    TheLenghtOf0HasToBeEqualTo1: msg("The length of {0} has to be equal to {1}"),
    TheLengthOf0HasToBeGreaterOrEqualTo1: msg("The length of {0} has to be greater than or equal to {1}"),
    TheLengthOf0HasToBeLesserOrEqualTo1: msg("The length of {0} has to be less than or equal to {1}"),
    TheRowsAreBeingGroupedBy0: msg("The rows are being grouped by {0}"),
    Type0NotAllowed: msg("Type {0} not allowed"),
    _0IsMandatoryWhen1IsNotSetTo2: msg("{0} is mandatory when {1} is not set to {2}"),
    _0ShouldBeNullWhen1IsNotSetTo2: msg("{0} should be null when {1} is not set to {2}"),
    _0ShouldBe1When2Is3: msg("{0} should be {1} when {2} is {3}"),
    _0ShouldBeGreaterThanOrEqual1: msg("{0} should be greater than or equal {1}"),
    _0ShouldBeLessThan1: msg("{0} should be less than {1}"),
    _0ShouldBeLessThanOrEqual1: msg("{0} should be less than or equal {1}"),
    _0ShouldBeOfType1: msg("{0} should be of type {1}"),
    _0ShouldNotBeOfType1: msg("{0} should not be of type {1}"),
    _0And1CanNotBeSetAtTheSameTime: msg("{0} and {1} can not be set at the same time"),
    _0Or1ShouldBeSet: msg("{0} or {1} should be set"),
    _0And1And2CanNotBeSetAtTheSameTime: msg("{0} and {1} and {2} can not be set at the same time"),
    _0Have1ElementsButAllowedOnly2: msg("{0} have {1} elements, but allowed only {2}"),
    _0IsEmpty: msg("{0} is empty"),
    _0ShouldBeEmpty: msg("{0} should be empty"),
    _AtLeastOneValueIsNeeded: msg("At least one value is needed"),
    // Signum's help-message twin of `_0ShouldBeATimeOfTheDay` above (which is the sentence the
    // TimePrecisionValidator reports); this is the fragment the help generator splices.
    IsATimeOfTheDay: msg("is a time of the day"),
    ThereAre0InState1: msg("There are {0} in state {1}"),
    ThereAre0ThatReferenceThis1: msg("There are {0} that reference this {1}"),
    _0IsNotCompatibleWith1: msg("{0} is not compatible with {1}"),
    _0IsRepeated: msg("{0} is repeated"),
    Either0Or1ShouldBeSet: msg("Either {0} or {1} should be set"),
    _0ContainsInvalidControlCharactersNear1: msg("{0} contains invalid control characters near: '{1}'"),
    ValidXMLCharacters: msg("Valid XML characters"),
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

// Hand-written, like StringCase below: no entity field is of this type. It matters here because the
// member is spliced into two messages a user READS (`_0HasToBe12`, `HaveANumberOfElements01`), so
// unregistered a German form would say "has to be greater than 0".
registerEnum(ComparisonType);

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
    get helpMessage(): string { return ValidationMessage.BeNotNull.niceToString(); }

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

/**
 * Signum's `(pi, value).IsSetOnlyWhen(shouldBeSet)` (ValidationAttributes.cs, beside ValidationMessage) —
 * the one hand-written rule common enough to be framework vocabulary: a member must be present EXACTLY
 * when some other member says so, and both halves of getting it wrong have a message.
 *
 * "Not set" is Signum's: null, the empty string, or an empty collection. `propertyName` is the member's
 * NICE name — `fi.niceToString()` inside a `@validate`, or `X.nicePropertyName(…)` when the rule is
 * reported on a different member than the one it is about.
 */
export function isSetOnlyWhen(value: unknown, shouldBeSet: boolean, propertyName: string): string | null {
    const notSet = value == null || value === "" || (Array.isArray(value) && value.length === 0);
    if (notSet && shouldBeSet)
        return ValidationMessage._0IsNotSet.niceToString(propertyName);
    if (!notSet && !shouldBeSet)
        return ValidationMessage._0ShouldBeNull.niceToString(propertyName);
    return null;
}

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

    /** `max: MAX_SIZE` means UNBOUNDED, not "at most -1". Signum spells the same rule `Max != -1`, and it
     *  is the value an entity writes to say "this column has no size limit" — so the check has to skip,
     *  not fail. Without this every such field is permanently invalid, and the message reads literally
     *  "must have at most -1 characters". */
    private get boundedMax(): number | undefined {
        const max = this.options.max;
        return max == null || max === MAX_SIZE ? undefined : max;
    }

    get helpMessage(): string {
        const { min, multiLine } = this.options;
        const max = this.boundedMax;
        if (min != null && max != null) return ValidationMessage.HaveBetween0And1Characters.niceToString(min, max);
        if (min != null) return ValidationMessage.HaveMinimum0Characters.niceToString(min);
        if (max != null) return ValidationMessage.HaveMaximum0Characters.niceToString(max);
        return multiLine ? ValidationMessage.BeAMultilineString.niceToString() : ValidationMessage.BeAString.niceToString();
    }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const s = value as string | null | undefined;
        if (s == null || s === '') return null;
        const { min } = this.options;
        const max = this.boundedMax;
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

// --- TimePrecisionValidator ---
//
// Signum's [TimePrecisionValidator(p)], the TIME-OF-DAY sibling of DateTimePrecisionValidator: it bounds
// how fine a `PlainTime` (Signum's TimeOnly) or `Duration` (its TimeSpan) may be. Unlike its date
// sibling it is a check and nothing else — it puts nothing on the FieldInfo and it does not size the
// column (Signum's `GetSqlPrecision` reads no validator; the lookup there is commented out).
//
// DIVERGENCE: Signum derives a DISPLAY FORMAT from it too (`Reflector.GetFormatString` →
// FormatString_TimeSpan / FormatString_TimeOnly). Those are custom .NET patterns (@"hh\:mm\:ss"), and
// altea's format vocabulary is the standard specifiers alone — TimeLine renders a fixed HH:MM:SS and
// reads no format — so there is no specifier to answer with, and hence nothing to denormalise.
//
// Its two messages are altea's localized ones; Signum hard-codes both in English.

export interface TimePrecisionOptions extends ValidatorOptions { }

export function timePrecisionValidator(precision: DateTimePrecision, options: TimePrecisionOptions = {}) {
    return (target: object, propertyKey: string | symbol) =>
        addValidator(target, propertyKey, new TimePrecisionValidator(precision), options);
}

export class TimePrecisionValidator extends Validator {
    constructor(public readonly precision: DateTimePrecision) { super(); }

    isCompatibleWith(type: Function) { return type === Temporal.PlainTime || type === Temporal.Duration; }

    get helpMessage(): string {
        return ValidationMessage.HaveAPrecisionOf0.niceToString(Enum.niceName(DateTimePrecision, this.precision).toLowerCase());
    }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        if (value == null)
            return null;
        if (!(value instanceof Temporal.PlainTime) && !(value instanceof Temporal.Duration))
            return null;

        const actual = getTimePrecision(value);
        if (actual != null && actual > this.precision)
            return ValidationMessage._0HasAPrecisionOf1InsteadOf2.niceToString(
                fi.niceToString(), Enum.niceName(DateTimePrecision, actual), Enum.niceName(DateTimePrecision, this.precision));

        // A Duration is an ELAPSED time, so it can hold whole days a time of the day cannot (Signum's
        // `ts.Days != 0`). A PlainTime never can.
        if (value instanceof Temporal.Duration && value.round({ largestUnit: "day" }).days !== 0)
            return ValidationMessage._0ShouldBeATimeOfTheDay.niceToString(fi.niceToString());

        return null;
    }
}

// --- DateInPastValidator / DateInFutureValidator ---
//
// Signum's [DateInPastValidator] / [DateInFutureValidator], read against `Clock` rather than the wall
// clock so an application's UTC/local choice and a test's pinned `overrideNow` both apply. A DATE is
// compared against today, so today passes either way — Signum reaches the same answer by widening the
// date to midnight.

export function dateInPastValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new DateInPastValidator(), options);
}

export class DateInPastValidator extends Validator {
    isCompatibleWith(type: Function) { return type === Temporal.PlainDateTime || type === Temporal.PlainDate; }

    get helpMessage(): string { return ValidationMessage.BeInThePast.niceToString(); }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const compared = compareToNow(value);
        return compared != null && compared > 0
            ? ValidationMessage._0ShouldBeADateInThePast.niceToString(fi.niceToString())
            : null;
    }
}

export function dateInFutureValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new DateInFutureValidator(), options);
}

export class DateInFutureValidator extends Validator {
    isCompatibleWith(type: Function) { return type === Temporal.PlainDateTime || type === Temporal.PlainDate; }

    get helpMessage(): string { return ValidationMessage.BeInTheFuture.niceToString(); }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const compared = compareToNow(value);
        return compared != null && compared < 0
            ? ValidationMessage._0ShouldBeADateInTheFuture.niceToString(fi.niceToString())
            : null;
    }
}

/** Where a date value sits relative to now, or undefined when it is not a date at all. */
function compareToNow(value: unknown): number | undefined {
    if (value instanceof Temporal.PlainDate)
        return Temporal.PlainDate.compare(value, Clock.today);
    if (value instanceof Temporal.PlainDateTime)
        return Temporal.PlainDateTime.compare(value, Clock.now);
    return undefined;
}

// --- YearGreaterThanValidator ---
//
// Signum's [YearGreaterThanValidator(minYear)]: a floor on the YEAR alone, which is what a birth date or
// a licence date wants — the day and month are free.

export function yearGreaterThanValidator(minYear: number, options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new YearGreaterThanValidator(minYear), options);
}

export class YearGreaterThanValidator extends Validator {
    constructor(public readonly minYear: number) { super(); }

    isCompatibleWith(type: Function) { return type === Temporal.PlainDateTime || type === Temporal.PlainDate; }

    get helpMessage(): string {
        return ValidationMessage.BeA01.niceToString(comparisonName(ComparisonType.GreaterThanOrEqualTo), this.minYear);
    }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        if (!(value instanceof Temporal.PlainDate) && !(value instanceof Temporal.PlainDateTime))
            return null;

        return value.year < this.minYear
            ? ValidationMessage._0HasToBe12.niceToString(
                fi.niceToString(), comparisonName(ComparisonType.GreaterThanOrEqualTo), this.minYear)
            : null;
    }
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

// --- RegexValidator ---
//
// Signum's abstract [RegexValidatorAttribute]: a string that has to MATCH at least one of a list of
// regular expressions, described to the reader by a `FormatName` that names the shape ("URL", "IP",
// "e-Mail"). Both messages come from here, so a concrete validator is a regex plus that name.
//
// `FormatName` is deliberately NOT localized — it is the `{1}` of "{0} does not have a valid {1}
// format", and Signum writes "URL" / "IP" / "e-Mail" as literals. The three that DO name a concept
// rather than a spelling (telephone, numeric, file name) take a ValidationMessage member, as Signum's do.
//
// A regex here must not carry the `g` flag: `RegExp.test` is stateful under it (lastIndex), so the same
// validator would answer differently on consecutive calls.

export abstract class RegexValidator extends Validator {
    constructor(public readonly regexList: readonly RegExp[]) { super(); }

    abstract get formatName(): string;

    isCompatibleWith(type: Function) { return type === String; }

    get helpMessage(): string { return ValidationMessage.HaveValid0Format.niceToString(this.formatName); }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const s = value as string | null | undefined;
        if (s == null || s === '') return null;
        return this.regexList.some(r => r.test(s))
            ? null
            : ValidationMessage._0DoesNotHaveAValid1Format.niceToString(fi.niceToString(), this.formatName);
    }
}

// Signum's regexes are matched with `Regex.IsMatch`, which — like JS `RegExp.test` — searches ANYWHERE in
// the string. Five of the ones below are written without anchors, which makes them accept any string that
// merely CONTAINS something valid: `[A-Za-z0-9]` passes "!!!a!!!" for a validator called AlphanumericOnly.
// altea anchors them; each is marked where it diverges.

// --- UrlValidator ---
//
// Signum's URLValidator takes four shapes; altea ports the ABSOLUTE one, which is its default and the
// only one its own url properties ask for. AspNetRelative (`~/…`) is an ASP.NET app-relative path with no
// meaning here, and the SiteRelative / DocumentRelative regexes beside it are written so loosely that
// they accept nearly any string — there is nothing to gain by carrying either across until a property
// needs one, and the base above makes adding it a regex and a flag.
const absoluteUrlRegex = /^(https?:\/\/)(([0-9a-z_!~*'().&=+$%-]+: )?[0-9a-z_!~*'().&=+$%-]+@)?(([0-9]{1,3}\.){3}[0-9]{1,3}|([0-9a-z_!~*'()-]+\.)*([0-9a-z][0-9a-z-]{0,61})?[0-9a-z](\.[a-z]{2,6})?)(:[0-9]{1,4})?[/0-9a-z_!~*'().;?:@&=+$,%#-|]+$/i;

export function urlValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new UrlValidator(), options);
}

export class UrlValidator extends RegexValidator {
    constructor() { super([absoluteUrlRegex]); }
    get formatName(): string { return "URL"; }
}

// --- TelephoneValidator ---

// `\p{Nd}` (any Unicode decimal digit) needs the `u` flag, and is what Signum's telephone shapes accept.
const telephoneRegex = /^[\p{Nd}+\-/() ]+$/u;

export function telephoneValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new TelephoneValidator(), options);
}

export class TelephoneValidator extends RegexValidator {
    constructor() { super([telephoneRegex]); }
    get formatName(): string { return ValidationMessage.Telephone.niceToString(); }
}

// --- MultipleTelephoneValidator ---

// A comma-separated list of telephone numbers. DIVERGES from Signum, whose
// `^[\p{Nd}+\-/() ](,\s*[\p{Nd}+\-/() ])*` matches ONE character per number and is unanchored at the end,
// so it accepts any string starting with a digit — "5 fine numbers" included.
const multipleTelephoneRegex = /^[\p{Nd}+\-/() ]+(,\s*[\p{Nd}+\-/() ]+)*$/u;

export function multipleTelephoneValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new MultipleTelephoneValidator(), options);
}

export class MultipleTelephoneValidator extends RegexValidator {
    constructor() { super([multipleTelephoneRegex]); }
    get formatName(): string { return ValidationMessage.Telephone.niceToString(); }
}

// --- EmailValidator ---

const emailRegex = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/i;

export function emailValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new EmailValidator(), options);
}

export class EmailValidator extends RegexValidator {
    constructor() { super([emailRegex]); }
    get formatName(): string { return "e-Mail"; }
}

// --- AlphanumericOnlyValidator ---

// DIVERGES from Signum twice. Its regex is the unanchored `[A-Za-z0-9]`, which asks for an alphanumeric
// somewhere rather than alphanumerics only; and its FormatName splices a whole sentence ("Special
// characters (-_#+%&...) is not allowed") into the middle of another one. The name of the shape is
// "Alphanumeric", like "URL" and "IP" beside it.
const alphanumericOnlyRegex = /^[A-Za-z0-9]*$/;

export function alphanumericOnlyValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new AlphanumericOnlyValidator(), options);
}

export class AlphanumericOnlyValidator extends RegexValidator {
    constructor() { super([alphanumericOnlyRegex]); }
    get formatName(): string { return "Alphanumeric"; }
}

// --- NumericTextValidator ---

// Digits held as TEXT — a phone extension, a postcode, an account number: the leading zeros matter, so
// the property is a string and not a number.
const numericTextRegex = /^\p{Nd}*$/u;

export function numericTextValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new NumericTextValidator(), options);
}

export class NumericTextValidator extends RegexValidator {
    constructor() { super([numericTextRegex]); }
    get formatName(): string { return ValidationMessage.Numeric.niceToString(); }
}

// --- IpValidator ---

// DIVERGES from Signum's unanchored `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`, which passes any string
// with an address SOMEWHERE in it. Neither version bounds an octet to 255 — that is Signum's shape, and
// tightening it would reject nothing a database holds today.
const ipRegex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function ipValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new IpValidator(), options);
}

export class IpValidator extends RegexValidator {
    constructor() { super([ipRegex]); }
    get formatName(): string { return "IP"; }
}

// --- FileNameValidator ---
//
// Signum tests `Path.GetInvalidPathChars()`, whose answer depends on the machine .NET runs on — the
// control characters plus '|' on Windows, NUL alone on Unix — so the same entity validates differently
// per host. altea uses the set Signum's own `RemoveInvalidCharts` uses instead
// (`GetInvalidFileNameChars`): the characters Windows reserves, plus the control range. It is the
// stricter of the two and the one that actually means "a file NAME", separator included.
const fileNameRegex = /^[^\x00-\x1F<>:"/\\|?*]*$/;

export function fileNameValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new FileNameValidator(), options);
}

export class FileNameValidator extends RegexValidator {
    constructor() { super([fileNameRegex]); }
    get formatName(): string { return ValidationMessage.FileName.niceToString(); }
}

/** Strips everything `@fileNameValidator` rejects (Signum's `FileNameValidatorAttribute.RemoveInvalidCharts`). */
export function removeInvalidFileNameChars(name: string): string {
    return name.replace(/[\x00-\x1F<>:"/\\|?*]/g, "");
}

// --- IdentifierValidator ---
//
// A string that has to read as a programming identifier — the name of a generated type, property or
// symbol. `International` is the Unicode identifier rule (a letter or underscore, then letters, digits
// and underscores); the two ASCII ones narrow it.

export enum IdentifierType {
    PascalAscii,
    Ascii,
    International,
}
export type IdentifierTypeKeys = keyof typeof IdentifierType;

// DIVERGENCE: Signum's PascalAscii is `^[A-Z[_a-zA-Z0-9]*$` — the `[` inside the class is a typo that
// swallows the intended second bracket, so its "Pascal" form is identical to its Ascii one and enforces
// no leading capital at all. Both are written here as they read.
const pascalAsciiRegex = /^[A-Z][_a-zA-Z0-9]*$/;
const asciiRegex = /^[_a-zA-Z][_a-zA-Z0-9]*$/;
const internationalRegex = /^[_\p{Ll}\p{Lu}\p{Lt}\p{Lo}\p{Nl}][_\p{Ll}\p{Lu}\p{Lt}\p{Lo}\p{Nl}\p{Nd}]*$/u;

export function identifierValidator(type: IdentifierType, options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new IdentifierValidator(type), options);
}

export class IdentifierValidator extends RegexValidator {
    constructor(public readonly type: IdentifierType) {
        super([type === IdentifierType.PascalAscii ? pascalAsciiRegex
            : type === IdentifierType.Ascii ? asciiRegex
                : internationalRegex]);
    }

    // The bare member NAME, as Signum's `type.ToString()` gives — "PascalAscii" is a spelling rule, not
    // a word to translate, so IdentifierType needs no registerEnum.
    get formatName(): string { return Enum.toName(IdentifierType, this.type); }
}

// --- NoRepeatValidator ---
//
// Signum's [NoRepeatValidator] compares the MList's ELEMENTS, which for an `MList<Lite<T>>` / `MList<Symbol>`
// are the values themselves. altea has no MList: such a collection is an array of `@part` ROWS whose
// `@valueField` holds the value (see the MList divergence in CLAUDE.md). Comparing the ROWS would compare
// object identity — every row is a distinct object, so nothing would EVER be reported as repeated. So a row
// with a `@valueField` is compared through THAT field, which is the element Signum saw.

/**
 * `@noRepeatValidator(a => a.entity)` — no two rows of the collection may share that member's value.
 *
 * The SELECTOR is the useful form, and on a `@part` row it is usually the only meaningful one. A part row
 * is a distinct entity per element, so comparing the ROWS compares object identity, which can never
 * repeat — `@noRepeatValidator()` on `specificColors: ColorPaletteEntity_SpecificColor[]` reports nothing,
 * ever. Signum has no such problem: its MList element is an EMBEDDED compared with `Equals`, structurally.
 *
 * Without a selector the comparison falls back to the element's `@valueField`, which is the one case where
 * the bare form IS meaningful — a collection of scalars or lites (`EmployeeEntity_Territory.territory`) is
 * a row whose single value field IS the element.
 *
 * Whatever the form, the COMPARED value must have an identity of its own: a scalar, a `Lite`, or a saved
 * entity. If it is an owned row or an embedded, the validator THROWS rather than passing silently — that
 * includes a `@valueField` that holds an embedded, so `UserChartEntity_Parameter` needs
 * `a => a.element.name` and not the bare form. A validator that cannot fail is worse than no validator: it
 * reads like a rule and enforces nothing.
 */
export function noRepeatValidator<T = any>(
    selector?: ((row: T) => unknown) | ValidatorOptions,
    options: ValidatorOptions = {},
) {
    const isSelector = typeof selector === "function";
    const opts = isSelector ? options : (selector ?? {});
    return (target: object, propertyKey: string | symbol) =>
        addValidator(target, propertyKey, new NoRepeatValidator(isSelector ? selector as (row: unknown) => unknown : undefined), opts);
}

export class NoRepeatValidator extends Validator {
    constructor(private readonly selector?: (row: unknown) => unknown) { super(); }

    isCompatibleWith(type: Function) { return type === Array; }
    get helpMessage(): string { return ValidationMessage.HaveNoRepeatedElements.niceToString(); }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const list = value as unknown[] | null | undefined;
        if (list == null || list.length <= 1) return null;

        const seen = new Map<string, unknown>();
        const repeated: unknown[] = [];
        for (const item of list) {
            const element = this.selector != undefined ? this.selector(item) : valueOfElement(item);

            // The compared ELEMENT must have an identity of its own. An owned row or an embedded has none —
            // every instance is a distinct object, so the comparison could never report and the validator
            // would read like a rule while enforcing nothing. Refuse instead of passing silently. A
            // `Lite<X>`, a scalar and an INDEPENDENT entity all compare by a real key (see `comparisonKey`).
            if (isOwnedRow(element))
                throw new Error(
                    `@noRepeatValidator on '${fi.name}' compares ${element!.constructor.name}, which has no ` +
                    `identity of its own, so it can never report a repeat. Point the selector at a member ` +
                    `that does, e.g. @noRepeatValidator(a => a.someField).`);

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

/** An element whose identity is its own ROW: a `@part` row (it has a `@backReference` to the owner) or an
 *  embedded / model. Two such elements are never equal to each other no matter what they hold, so a bare
 *  `@noRepeatValidator` over them can never report. An INDEPENDENT entity is not owned — it compares by id. */
function isOwnedRow(item: unknown): boolean {
    if (item == null || typeof item !== 'object')
        return false;

    const ti = tryGetTypeInfo(item.constructor);
    return ti != undefined && ti.valueField == undefined
        && (ti.backReferenceField != undefined || ti.kind === "Model");
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

// --- NumberBetweenValidator ---
//
// Signum's [NumberBetweenValidator(min, max)] — both bounds INCLUSIVE ("Not using C intervals to please
// user!", as its source says). It reports only: a value outside the range is refused, never clamped. A
// null passes, for the reason NumberIsValidator's header gives. It does not touch the column either —
// SchemaSettings reads only StringLengthValidator (size) and DecimalsValidator (scale).

export interface NumberBetweenOptions extends ValidatorOptions { }

export function numberBetweenValidator(min: number, max: number, options: NumberBetweenOptions = {}) {
    return (target: object, propertyKey: string | symbol) =>
        addValidator(target, propertyKey, new NumberBetweenValidator(min, max), options);
}

export class NumberBetweenValidator extends Validator {
    constructor(public readonly min: number, public readonly max: number) { super(); }

    isCompatibleWith(type: Function) { return type === Number || type === Decimal; }

    get helpMessage(): string {
        return ValidationMessage.BeBetween0And1.niceToString(this.min, this.max);
    }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        if (value == null)
            return null;

        const n = typeof value === "number" ? value : Number(value);
        if (Number.isNaN(n) || (this.min <= n && n <= this.max))
            return null;

        return ValidationMessage._0HasToBeBetween1And2.niceToString(fi.niceToString(), this.min, this.max);
    }
}

// --- NumberPowerOfTwoValidator ---

export function numberPowerOfTwoValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) =>
        addValidator(target, propertyKey, new NumberPowerOfTwoValidator(), options);
}

export class NumberPowerOfTwoValidator extends Validator {
    isCompatibleWith(type: Function) { return type === Number; }

    get helpMessage(): string {
        return ValidationMessage.BeA01.niceToString(ValidationMessage.PowerOf.niceToString(), 2);
    }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        if (value == null)
            return null;

        const n = typeof value === "number" ? value : Number(value);
        if (Number.isNaN(n) || isPowerOfTwo(n))
            return null;

        return ValidationMessage._0HasToBe12.niceToString(
            fi.niceToString(), ValidationMessage.PowerOf.niceToString(), 2);
    }
}

// Signum's halving loop rather than `n & (n - 1)`, which would be wrong above 2^31 — a JS bitwise
// operator truncates to 32 bits.
function isPowerOfTwo(n: number): boolean {
    if (!Number.isInteger(n) || n <= 0)
        return false;
    while (n !== 1) {
        if (n % 2 !== 0)
            return false;
        n /= 2;
    }
    return true;
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

// Signum's `ComparisonType.NiceToString().FirstLower()` — "greater than", "less than or equal to", … in
// the reader's own language. Signum disagrees with itself (CountIsValidator FirstLower, NumberIsValidator
// ToLower); altea takes FirstLower for both, since ToLower would flatten a translation's own capitals.
function comparisonName(comparison: ComparisonType): string {
    const name = Enum.niceName(ComparisonType, comparison);
    return name.charAt(0).toLowerCase() + name.slice(1);
}

// --- StateValidator ---
//
// Signum's StateValidator<E, S> (Entities/Validation/ValidationAttributes.cs): which properties an entity
// must, may, or must not have in each of its states. Per state, one entry per property — `true` necessary,
// `false` not allowed, `null` either — and a property's value is judged against its entity's CURRENT state:
//
//     export const roleAssignmentStates = new StateValidator<RoleAssignmentEntity, RoleAssignmentStatus>(
//         a => a.status, ["fromDate", "toDate"], RoleAssignmentStatus)
//         .add(RoleAssignmentStatus.Interested, false, false)
//         .add(RoleAssignmentStatus.Assigned, true, null);
//
//     @stateValidator(roleAssignmentStates)
//     export class RoleAssignmentEntity extends Entity { … }
//
// Signum calls `Validate(this, pi)` from PropertyValidation; `@stateValidator` puts that call on each listed
// property instead. An empty string or an empty array counts as no value — both are indistinguishable from
// null once retrieved. Pass the state's enum object so an enum state compares by member and the message
// names it by its nice name.
export class StateValidator<E extends BaseEntity, S> {
    private readonly byState = new Map<string, (boolean | null)[]>();

    constructor(
        readonly getState: (entity: E) => S,
        readonly propertyNames: readonly (keyof E & string)[],
        readonly stateEnum?: object,
    ) { }

    /** The row for one state: an entry per property, in the constructor's order. */
    add(state: S, ...necessary: (boolean | null)[]): this {
        if (necessary.length !== this.propertyNames.length)
            throw new Error(`The StateValidator for state ${this.stateText(state)} has ${necessary.length} values instead of ${this.propertyNames.length}`);
        const key = this.stateKey(state);
        if (this.byState.has(key))
            throw new Error(`The StateValidator already has state ${this.stateText(state)}`);
        this.byState.set(key, necessary);
        return this;
    }

    /** The error for `propertyName` in the entity's current state, or null (also for an unlisted property). */
    validate(entity: E, propertyName: string, showState = true): string | null {
        const index = this.propertyNames.indexOf(propertyName as keyof E & string);
        if (index === -1)
            return null;
        return this.message(entity, this.getState(entity), showState, index);
    }

    /** Whether the property is allowed in `state` — undefined for a property the validator does not list. */
    isAllowed(state: S, propertyName: string): boolean | null | undefined {
        const index = this.propertyNames.indexOf(propertyName as keyof E & string);
        return index === -1 ? undefined : this.necessaryAt(state, index);
    }

    /** `true` necessary, `false` not allowed, `null` either — for a listed property. */
    necessary(state: S, propertyName: keyof E & string): boolean | null {
        const index = this.propertyNames.indexOf(propertyName);
        if (index === -1)
            throw new Error(`The property '${propertyName}' is not registered in the StateValidator`);
        return this.necessaryAt(state, index);
    }

    /** Every error the entity would have in `targetState` — what a state transition would be refused for. */
    previewErrors(entity: E, targetState: S, showState = true): string | null {
        const errors = this.propertyNames.map((_, i) => this.message(entity, targetState, showState, i)).filter(e => e != null);
        return errors.length === 0 ? null : errors.join("\n");
    }

    private message(entity: E, state: S, showState: boolean, index: number): string | null {
        const necessary = this.necessaryAt(state, index);
        if (necessary == null)
            return null;

        let value: unknown = entity[this.propertyNames[index]];
        if (Array.isArray(value) && value.length === 0 || value === "")
            value = null;

        const niceName = tryGetTypeInfo(entity.constructor)?.fields[this.propertyNames[index]]?.niceToString() ?? this.propertyNames[index];
        if (value != null && !necessary)
            return showState ? ValidationMessage._0IsNotAllowedOnState1.niceToString(niceName, this.stateText(state)) : ValidationMessage._0IsNotAllowed.niceToString(niceName);
        if (value == null && necessary)
            return showState ? ValidationMessage._0IsNecessaryOnState1.niceToString(niceName, this.stateText(state)) : ValidationMessage._0IsNecessary.niceToString(niceName);
        return null;
    }

    private necessaryAt(state: S, index: number): boolean | null {
        const row = this.byState.get(this.stateKey(state));
        if (row == null)
            throw new Error(`State ${this.stateText(state)} not registered in StateValidator`);
        return row[index];
    }

    private stateKey(state: S): string {
        return this.stateEnum != null && typeof state === "number" ? Enum.toName(this.stateEnum as never, state as never) : String(state);
    }

    private stateText(state: S): string {
        return this.stateEnum != null ? Enum.niceName(this.stateEnum as never, state as never) : String(state);
    }
}

/** Puts a StateValidator on each property it lists (Signum calls it from PropertyValidation). */
export function stateValidator<E extends BaseEntity, S>(validator: StateValidator<E, S>): (target: Function) => void {
    return (target: Function) => {
        for (const name of validator.propertyNames)
            addValidator(target.prototype, name, new StateFieldValidator(validator as StateValidator<BaseEntity, unknown>));
    };
}

class StateFieldValidator extends Validator {
    constructor(readonly stateValidator: StateValidator<BaseEntity, unknown>) { super(); }

    get helpMessage(): string { return ""; }

    protected overrideError(_value: unknown, entity: BaseEntity, fi: FieldInfo): string | null {
        return this.stateValidator.validate(entity, fi.name);
    }
}
