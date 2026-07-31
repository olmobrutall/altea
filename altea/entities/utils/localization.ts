
import type { IContextVariable, IContextStorage } from './context';
import { pluralize, detectGender } from './naturalLanguage';

// One localised container (Signum's LocalizedType): its own description (+ plural/gender for a type)
// and a member→description map (entity members / enum values / messages / operations / symbols). This
// is the parsed shape the server ships to the client; XML parsing itself lives server-side
// (server/translations.ts), so this model stays isomorphic and dependency-free.
export interface LocalizedType {
    description?: string;
    pluralDescription?: string;
    gender?: string;
    members: Record<string, string>;
}
export type LocalizedTypes = Record<string, LocalizedType>;

// Re-exported from the import-free registration leaf so the quote-transformer can
// attach `registerObject` to the `msg` import in localization files (which don't
// import reflect) to auto-register msg() containers. The leaf imports nothing, so
// this does not create a cycle with reflection.
export { registerObject } from '../registration';

// Human-readable name of an entity *type* (Signum's `Type.NiceName()`): the class
// name with a trailing "Entity" dropped and PascalCase split into words —
// `GrammyAwardEntity` → "Grammy Award". Takes the constructor only (never an instance):
// the display string must be computable from the type + id alone, so building a lite's
// model never forces the (potentially unloaded) entity to be retrieved.
export function niceName(ctor: Function): string {
    return DescriptionManager.typeDescription(ctor.name) ?? niceNameFromName(ctor.name);
}

// De-camelCase a raw identifier into a display label: "GrammyAwardEntity" → "Grammy Award",
// "FilterOperation" → "Filter Operation". The string-only core of `niceName(ctor)`, shared with
// the `Enum` helper's `niceTypeName` (entities/enum) so enum type names humanise identically.
export function niceNameFromName(name: string): string {
    const raw = name.replace(/Entity$/, "");
    return raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").trim();
}

// Display name of a new (unsaved) entity of this type (Signum's `Type.NewNiceName()`).
export function newNiceName(ctor: Function): string {
    return "New " + niceName(ctor);
}

// Plural of the entity type's nice name (Signum's `Type.NicePluralName()`). Signum runs a real
// pluralizer keyed on the UI culture; altea uses a naive English "+s" stand-in for now (good enough
// for the default query/expression display names — swap for a culture-aware pluralizer later).
export function nicePluralName(ctor: Function): string {
    return DescriptionManager.typePluralDescription(ctor.name)
        ?? pluralize(niceName(ctor), DescriptionManager.currentUICulture());
}

// Grammatical gender of an entity type (Signum's Type gender): the translation's Gender attribute,
// else detected from the (localised) nice name for the current UI culture (English has none).
export function gender(ctor: Function): string | undefined {
    return DescriptionManager.typeGender(ctor.name)
        ?? detectGender(niceName(ctor), DescriptionManager.currentUICulture());
}

// `f.constructor.niceName()` in a query (Signum's Type.NiceName() on a runtime type): `this` is
// the entity constructor, so it delegates to niceName(). A real in-memory body (so it also works
// when a lambda runs in memory) plus the query `__resultType` fromQuoted reads to type the call;
// the QueryBinder lowers the call to SQL. Lives here alongside niceName().
declare global {
    interface Function {
        niceName(): string;
    }
}
Function.prototype.niceName = function (this: Function): string {
    return niceName(this);
};
// NOTE: the query `__resultType` metadata for Function.prototype.niceName / niceName / newNiceName
// (all → string) is RuntimeType, so it lives in logic/index.ts (server); entities/ stays RuntimeType-free.

export class LocalizableMessage {
    private _inferred?: string;

    constructor(
        readonly defaultDescription: string | undefined,
        readonly member: string | undefined,
        readonly module: string | undefined,
    ) { }

    niceToString(...args: unknown[]): string {
        const template = DescriptionManager.lookup(this) ?? this._getDefault();
        return args.length > 0 ? format(template, ...args) : template;
    }

    private _getDefault(): string {
        if (this.defaultDescription != null) return this.defaultDescription;
        if (this.member == null) return '?';
        return this._inferred ??= DescriptionManager.inferDescription(this.member);
    }
}

// Overload seen by developers — desc optional, member/module injected by transformer
export function msg(desc?: string): LocalizableMessage;
// Full signature used by transformer-generated code
export function msg(desc: string | undefined, member: string, module: string): LocalizableMessage;
export function msg(desc?: string, member?: string, module?: string): LocalizableMessage {
    return new LocalizableMessage(desc, member, module);
}

function format(template: string, ...args: unknown[]): string {
    return template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
}

export namespace DescriptionManager {
    // Process-wide defaults
    let _defaultCulture = 'en';
    let _defaultUICulture = 'en';

    // Per-async-context overrides — backed by IContextVariable so the
    // implementation works on both Node (AsyncLocalStorage) and browser (global var).
    // Call initLocalizationContext(Statics) once at application startup.
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
            throw new Error('Call DescriptionManager.initLocalizationContext(Statics) before using withCulture');
        return _cultureVar.withValue(locale, fn);
    }

    export function withUICulture<T>(locale: string, fn: () => T): T {
        if (_uiCultureVar == null)
            throw new Error('Call DescriptionManager.initLocalizationContext(Statics) before using withUICulture');
        return _uiCultureVar.withValue(locale, fn);
    }

    export function withCultures<T>(locale: string, fn: () => T): T {
        return withCulture(locale, () => withUICulture(locale, fn));
    }

    // Translations keyed by locale → type name → LocalizedType (Signum's LocalizedAssembly model). A
    // "type" is any named container the XML localises: entity/embedded (description + members), enum
    // (members), message (members), operation/symbol container (members).
    const _localized = new Map<string, Map<string, LocalizedType>>();

    // Merge parsed LocalizedTypes into a locale (later files override earlier keys).
    export function addLocalizedTypes(locale: string, types: LocalizedTypes): void {
        let byType = _localized.get(locale);
        if (byType == null) { byType = new Map(); _localized.set(locale, byType); }
        for (const [name, lt] of Object.entries(types)) {
            const existing = byType.get(name);
            if (existing == null) {
                byType.set(name, { ...lt, members: { ...lt.members } });
            } else {
                if (lt.description != null) existing.description = lt.description;
                if (lt.pluralDescription != null) existing.pluralDescription = lt.pluralDescription;
                if (lt.gender != null) existing.gender = lt.gender;
                Object.assign(existing.members, lt.members);
            }
        }
    }

    function localizedType(typeName: string): LocalizedType | undefined {
        return _localized.get(currentUICulture())?.get(typeName);
    }

    // Dump every loaded LocalizedType for a locale as a plain (deep-copied) LocalizedTypes — the
    // Translations section of the /api/reflection/metadata blob. The client feeds it straight back
    // into addLocalizedTypes, so the XML parser never ships to the browser. Empty object if the
    // locale has no translations loaded (the client then falls back to niceNameFromName).
    export function getLocalizedTypes(locale: string): LocalizedTypes {
        const result: LocalizedTypes = {};
        const byType = _localized.get(locale);
        if (byType != null)
            for (const [name, lt] of byType)
                result[name] = { ...lt, members: { ...lt.members } };
        return result;
    }

    // Type-level translations (current UI culture) — the XML's <Type Description/PluralDescription/
    // Gender>. Consumed by niceName / nicePluralName.
    export function typeDescription(typeName: string): string | undefined { return localizedType(typeName)?.description; }
    export function typePluralDescription(typeName: string): string | undefined { return localizedType(typeName)?.pluralDescription; }
    export function typeGender(typeName: string): string | undefined { return localizedType(typeName)?.gender; }

    export function lookup(msg: LocalizableMessage): string | undefined {
        if (msg.module == null || msg.member == null) return undefined;
        return translate(msg.module, msg.member);
    }

    // A container member's translation (current UI culture): the XML <Member> under <Type Name=module>.
    // Used by the Enum helper (enum member names) and messages (msg containers) — their member names
    // are already the PascalCase C# identifiers the XML uses.
    export function translate(module: string, member: string): string | undefined {
        return localizedType(module)?.members[member];
    }

    // An entity member's display name (current UI culture): altea's member identifiers are camelCase
    // but the XML uses the PascalCase C# name, so try the name as-is then capitalised.
    export function memberNiceName(typeName: string, member: string): string | undefined {
        const lt = localizedType(typeName);
        return lt?.members[member] ?? lt?.members[member.charAt(0).toUpperCase() + member.slice(1)];
    }

    // Infers a human-readable description from a member name.
    // Strips a leading '_', splits on PascalCase boundaries, lowercases,
    // and replaces each digit N with the placeholder {N}.
    // e.g. "_0IsNotSet" → "{0} is not set", "BeNotNull" → "be not null"
    export function inferDescription(member: string): string {
        const s = member.startsWith('_') ? member.slice(1) : member;
        const tokens: string[] = [];
        let i = 0;
        while (i < s.length) {
            const ch = s[i];
            if (ch >= '0' && ch <= '9') {
                tokens.push(`{${ch}}`);
                i++;
                continue;
            }
            let word = ch.toLowerCase();
            i++;
            while (i < s.length && !(s[i] >= '0' && s[i] <= '9') && s[i] === s[i].toLowerCase()) {
                word += s[i];
                i++;
            }
            tokens.push(word);
        }
        return tokens.join(' ');
    }
}
