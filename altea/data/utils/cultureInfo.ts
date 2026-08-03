
import type { IContextVariable, IContextStorage } from './context';

// Culture context (Signum's CultureInfo.CurrentCulture / CurrentUICulture): the process-wide default
// cultures plus per-async-context overrides. Split out of DescriptionManager into its own module so the
// culture state has a single home; the localization layer imports it to resolve the current UI culture,
// and the client/server bootstrap sets the defaults through it.
export namespace CultureInfo {
    // Process-wide defaults.
    let _defaultCulture = 'en';
    let _defaultUICulture = 'en';

    // Per-async-context overrides — backed by IContextVariable so the implementation works on both Node
    // (AsyncLocalStorage) and browser (global var). Call initLocalizationContext(Statics) once at startup.
    let _cultureVar: IContextVariable<string> | undefined;
    let _uiCultureVar: IContextVariable<string> | undefined;

    export function initLocalizationContext(storage: IContextStorage): void {
        _cultureVar = storage.newContextVariable<string>();
        _uiCultureVar = storage.newContextVariable<string>();
    }

    export function currentCulture(): string { return _cultureVar?.getValue() ?? _defaultCulture; }
    export function currentUICulture(): string { return _uiCultureVar?.getValue() ?? _defaultUICulture; }

    export function setDefaultCulture(locale: string): void { _defaultCulture = locale; }
    export function setDefaultUICulture(locale: string): void { _defaultUICulture = locale; }

    export function withCulture<T>(locale: string, fn: () => T): T {
        if (_cultureVar == null)
            throw new Error('Call CultureInfo.initLocalizationContext(Statics) before using withCulture');
        return _cultureVar.withValue(locale, fn);
    }

    export function withUICulture<T>(locale: string, fn: () => T): T {
        if (_uiCultureVar == null)
            throw new Error('Call CultureInfo.initLocalizationContext(Statics) before using withUICulture');
        return _uiCultureVar.withValue(locale, fn);
    }

    export function withCultures<T>(locale: string, fn: () => T): T {
        return withCulture(locale, () => withUICulture(locale, fn));
    }
}
