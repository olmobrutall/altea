import { Entity } from './entity';
import { reflect } from './reflection';
import { entity, uniqueIndex, quoted, fieldValidation, niceName, nicePluralName } from './decorators';
import { stringLengthValidator } from './validators';
import { init } from './registration';
import type { ExecuteSymbol, DeleteSymbol } from './operations';
import { msg } from './utils/localization';

// Port of Signum's `CultureInfoEntity` (Signum/Basics/CultureInfoEntity.cs): the system table with one row
// per culture the APPLICATION supports. It is what turns "a culture" from a bare string into something a
// user can pick, an entity can reference, and authorization can reason about — an email or Office template
// stores `Lite<CultureInfoEntity>`, not a free-text locale tag.
//
// altea divergences:
//  - .NET's `CultureInfo.GetCultureInfo(name)` becomes `Intl.DisplayNames`, which every modern runtime
//    ships. So `nativeName` / `englishName` are derived the same way, from the same CLDR data, and the
//    validation below is "does the runtime know this tag" rather than a CultureNotFoundException catch.
//  - Signum fills the two derived names in `PreSaving`; altea has no PreSaving hook on the entity, so
//    `CultureInfoLogic` fills them on the Save operation (and the seeder does the same).
// The DEFAULT-language names: humanizing the class name gives "Culture Info", and the naive pluralizer
// then inflects the head noun into "Cultures Info". Every translation calls it simply Kultur / Cultura,
// so say so in English too. (These are only the no-translation default — a translation file still wins.)
@niceName("Culture")
@nicePluralName("Cultures")
@reflect
@entity("String", "Master")
export class CultureInfoEntity extends Entity {
    // The locale tag ("en", "es", "de-CH"). Signum's [UniqueIndex, StringLengthValidator(2, 10)].
    @uniqueIndex
    @stringLengthValidator({ min: 2, max: 10 })
    @fieldValidation<CultureInfoEntity>((c: CultureInfoEntity) => isKnownCulture(c.name) ? null : CultureInfoMessage._0IsNotAValidCultureName.niceToString(c.name))
    name: string;

    // The language's own name for itself ("español"), and its English name ("Spanish"). Derived from the
    // tag, so they are stored rather than typed — kept as columns (as Signum does) so a query can sort and
    // filter on them without every row going through Intl.
    @stringLengthValidator({ max: 200 })
    nativeName: string;

    @stringLengthValidator({ max: 200 })
    englishName: string;

    /** Signum's `IsNeutral => !Name.Contains("-")` — a language with no region ("es", not "es-AR"). */
    @quoted
    isNeutral(): boolean {
        return !this.name.includes("-");
    }

    // Signum's `[AutoExpressionField] ToString() => EnglishName`. @quoted so it ALSO lowers to SQL: the
    // table has no stored ToStr column, so without it a `Lite<CultureInfoEntity>` read from a FK — a
    // template's culture, say — would arrive with an empty display string.
    @quoted
    toString(): string {
        return this.englishName;
    }
}

export namespace CultureInfoOperation {
    export const Save: ExecuteSymbol<CultureInfoEntity> = init();
    export const Delete: DeleteSymbol<CultureInfoEntity> = init();
}

export const CultureInfoMessage = {
    _0IsNotAValidCultureName: msg("'{0}' is not a valid culture name"),
};

/**
 * The locale TAG a stored culture reference points at. A lite's `toStr` is the culture's ENGLISH name
 * (`CultureInfoEntity.toString`), not its tag, so matching has to go through the loaded ROW — which is a
 * runtime concern of whichever tier is asking. Both install a resolver: the server from CultureInfoLogic's
 * cache, the client from the applied metadata. Undefined when the row is not resolvable here.
 */
export function cultureNameOf(lite: { id: unknown } | null | undefined): string | undefined {
    return lite == null ? undefined : cultureNameResolver?.(lite);
}

let cultureNameResolver: ((lite: { id: unknown }) => string | undefined) | undefined;
export function setCultureNameResolver(fn: ((lite: { id: unknown }) => string | undefined) | undefined): void {
    cultureNameResolver = fn;
}

/**
 * Whether the runtime recognises this locale tag — the altea equivalent of Signum catching
 * `CultureNotFoundException` from `CultureInfo.GetCultureInfo`. `Intl.getCanonicalLocales` throws a
 * RangeError on a structurally invalid tag; a structurally valid but unknown one canonicalises fine and is
 * accepted, exactly as .NET accepts an unknown-but-well-formed tag.
 */
export function isKnownCulture(name: string | null | undefined): boolean {
    if (name == null || name === "")
        return false;
    try {
        return Intl.getCanonicalLocales(name).length === 1;
    } catch {
        return false;
    }
}

/**
 * The language's own name and its English name for a tag — what the two derived columns hold. Isomorphic
 * (Intl is in both runtimes), so the client can preview them before the row is saved.
 */
export function cultureDisplayNames(name: string): { nativeName: string; englishName: string } {
    const of = (locale: string): string => {
        try {
            // The tag can carry a region ("de-CH"); the DISPLAY name is of its language, which is what
            // Signum's NativeName/EnglishName hold for a neutral culture and what reads best for a specific
            // one too ("Deutsch (Schweiz)" comes from the region part, which Intl adds when asked for the
            // full tag — so ask for the full tag and let Intl decide).
            return new Intl.DisplayNames([locale], { type: "language" }).of(name) ?? name;
        } catch {
            return name;
        }
    };
    const capitalize = (s: string, locale: string): string => s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
    return { nativeName: capitalize(of(name), name), englishName: capitalize(of("en"), "en") };
}
