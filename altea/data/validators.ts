
import { getOrCreateTypeInfo, getOrCreateFieldInfo, Validator, registerImplicitNotNullValidator } from './reflection';
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
    NumberIsTooSmall: msg("Number is too small"),
    NumberIsTooBig: msg("Number is too big"),
    EachRowRepresentsAGroupOf0WithSame1: msg("Each row represents a group of {0} with same {1}"),
    TheNumberOf0IsBeingMultipliedBy1: msg("The number of {0} is being multiplied by {1}"),
};

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

export function customValidators<T>(fn: (entity: T, fi: FieldInfo, env: IntegrityCheckEnvironment) => string | null) {
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

export function noRepeatValidator(options: ValidatorOptions = {}) {
    return (target: object, propertyKey: string | symbol) => addValidator(target, propertyKey, new NoRepeatValidator(), options);
}

export class NoRepeatValidator extends Validator {
    isCompatibleWith(type: Function) { return type === Array; }
    get helpMessage() { return 'have no repeated elements'; }

    protected overrideError(value: unknown, _entity: BaseEntity, fi: FieldInfo): string | null {
        const list = value as unknown[] | null | undefined;
        if (list == null || list.length <= 1) return null;
        const seen = new Set<unknown>();
        const repeated: unknown[] = [];
        for (const item of list) {
            if (seen.has(item)) repeated.push(item);
            else seen.add(item);
        }
        return repeated.length > 0
            ? ValidationMessage._0HasSomeRepeatedElements1.niceToString(fi.niceToString(), repeated.join(', '))
            : null;
    }
}
