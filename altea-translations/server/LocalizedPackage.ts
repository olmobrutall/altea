import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { EmbeddedEntity, Entity, MixinEntity, ModelEntity } from "@altea/altea/data/entity";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { Localization, type LocalizableMessage } from "@altea/altea/data/utils/localization";
import { pluralize, detectGender, determinersFor } from "@altea/altea/data/utils/naturalLanguage";
import {
    getRegisteredTypes, getRegisteredEnums, getRegisteredObjects, getLocation, getPackageCulture,
    allDeclaredSymbols, getDefaultDescription,
} from "@altea/altea/data/registration";

import { tryResolvePackageDir, resolveAppRoot } from "@altea/altea/server/translations";

// Port of Signum.Utilities' `LocalizedAssembly` / `LocalizedType` (the model Signum.Translation's code half
// edits) — an in-memory, WRITABLE view of one package's translation file for one culture.
//
// **The central mapping of this half: a Signum ASSEMBLY is an altea PACKAGE.** Signum groups localizable
// types by the .NET assembly that declares them and keeps one `<Assembly>.<culture>.xml` per assembly per
// culture; altea's translations already live per package (`<pkg>/translations/<Base>.<culture>.xml`, see
// core's server/translations.ts), and every registered name knows its owning package through the
// quote-transformer's `__fileInfo` (`getLocation`). So the port is one-to-one, and the files these pages
// write are exactly the files `loadAppTranslations` reads at boot.
//
// Two smaller renames follow from it:
//  - Signum's second grouping level is the C# NAMESPACE; altea has none, so it is the DIRECTORY the type is
//    declared in (`getLocation(name).fileName`'s folder) — the same "which part of the package" question.
//  - `[assembly: DefaultAssemblyCulture("en")]` is `setDefaultCulture("en")` (core's registration leaf),
//    read back per package by `getPackageCulture`.

/** Which of the four labels a localizable type actually has (Signum's DescriptionOptions). */
export interface DescriptionOptions {
    hasDescription: boolean;
    hasPluralDescription: boolean;
    hasGender: boolean;
    hasMembers: boolean;
}

/** One type / enum / container in one culture. `undefined` = not translated (what Sync looks for). */
export interface LocalizedType {
    typeName: string;
    /** The directory inside the package that declares it — the sync grouping (Signum's namespace). */
    folder: string;
    options: DescriptionOptions;
    description?: string;
    pluralDescription?: string;
    gender?: string;
    /** Member NAME (PascalCase, the XML's own casing) → its description. */
    members: Map<string, string | undefined>;
}

export interface LocalizedPackage {
    packageName: string;
    culture: string;
    /** Keyed by type name, in the same order `localizableTypes` returns them. */
    types: Map<string, LocalizedType>;
}

/**
 * Signum's `LocalizedType.IsTypeCompleted` — the type-level labels this type needs are all present.
 * `culture` is the package's culture: the GENDER check applies only where the language HAS genders
 * (Signum's `NaturalLanguageTools.HasGenders`), else every English type would read as incomplete forever.
 */
export function isTypeCompleted(lt: LocalizedType, culture: string): boolean {
    if (lt.options.hasDescription && (lt.description == undefined || lt.description === ""))
        return false;
    if (lt.options.hasPluralDescription && (lt.pluralDescription == undefined || lt.pluralDescription === ""))
        return false;
    if (lt.options.hasGender && determinersFor(culture).length > 0 && (lt.gender == undefined || lt.gender === ""))
        return false;
    return true;
}

// ---- What is localizable, and who owns it ---------------------------------------------------------------

interface LocalizableType {
    typeName: string;
    packageName: string;
    folder: string;
    options: DescriptionOptions;
    /** The member names, in the XML's PascalCase. */
    members: string[];
    /**
     * The DEFAULT-language text a member is declared with, where that is not in the shared defaults
     * registry. A `msg("This version was CREATED")` keeps its text on the LocalizableMessage INSTANCE
     * (only @niceName / init({niceName}) write to `defaultDescriptions`), so a msg container's masters
     * are read off the container object itself — otherwise the sync would offer the humanised
     * "This version was created" as the English to translate from, which is not what the app shows.
     */
    memberDefaults?: Record<string, string>;
}

let cachedTypes: LocalizableType[] | undefined;

/**
 * Every localizable name in the process, with the package and folder that declares it — Signum's
 * `assembly.GetTypes().Where(t => GetDescriptionOptions(t) != None)`, over altea's four registries:
 * reflected CLASSES (entities + models), ENUMS, message/`msg` CONTAINERS, and SYMBOL containers.
 *
 * Computed once: every registry is filled at import time and frozen after boot.
 */
export function localizableTypes(): LocalizableType[] {
    if (cachedTypes != undefined)
        return cachedTypes;

    const result: LocalizableType[] = [];

    const add = (typeName: string, options: DescriptionOptions, members: string[], memberDefaults?: Record<string, string>,
        locationName?: string): void => {
        const loc = getLocation(locationName ?? typeName);
        if (loc == undefined)
            return; // declared without a FileInfo (a hand-built registration) — no package to file it under
        result.push({ typeName, packageName: loc.packageName, folder: folderOf(loc.fileName), options, members, memberDefaults });
    };

    // Entities, models, embeddeds and mixins: everything, including abstract bases (they carry their own
    // nice name). Which of the four labels each one has is `descriptionOptionsOf`.
    for (const ctor of getRegisteredTypes())
        add(ctor.name, descriptionOptionsOf(ctor), routeMemberNames(ctor));

    // Enums: a name and its members (Signum: Description | Members).
    for (const [name, enumObject] of getRegisteredEnums())
        add(name,
            { hasDescription: true, hasPluralDescription: false, hasGender: false, hasMembers: true },
            enumMemberNames(enumObject));

    // msg() containers: members only (Signum's Message enums), with each member's declared text.
    for (const [name, obj] of getRegisteredObjects())
        add(name,
            { hasDescription: false, hasPluralDescription: false, hasGender: false, hasMembers: true },
            Object.keys(obj).map(capitalize),
            messageDefaults(obj));

    // Symbol containers (operations, permissions, type conditions), grouped by the key's container half.
    // GOTCHA: `init()` registers a symbol's FileInfo under its full "Container.Member" KEY, never under the
    // container alone — so the container's location has to come from one of its members, or every symbol
    // container silently drops out of the localizable set (and `exportXml` then strips its translations
    // from the file it rewrites).
    const symbolMembers = new Map<string, { members: string[]; anyKey: string }>();
    for (const symbol of allDeclaredSymbols()) {
        const dot = symbol.key.indexOf(".");
        if (dot < 0) continue;
        const container = symbol.key.slice(0, dot);
        const entry = symbolMembers.get(container)
            ?? symbolMembers.set(container, { members: [], anyKey: symbol.key }).get(container)!;
        entry.members.push(symbol.key.slice(dot + 1));
    }
    for (const [container, entry] of symbolMembers)
        add(container, { hasDescription: false, hasPluralDescription: false, hasGender: false, hasMembers: true },
            entry.members, undefined, entry.anyKey);

    result.sort((a, b) => a.typeName.localeCompare(b.typeName));
    return cachedTypes = result;
}

/** The packages that declare something localizable, in dependency-friendly (alphabetical) order. */
export function localizablePackages(): string[] {
    return [...new Set(localizableTypes().map(t => t.packageName))].sort();
}

/** Signum's `[DefaultAssemblyCulture]` — the language a package's code-declared strings are written in. */
export function defaultCultureOf(packageName: string): string {
    return getPackageCulture(packageName) ?? "en";
}

// Which of the four labels a reflected class has. Signum keeps this on the base classes, as an
// INHERITED `[DescriptionOptions]`, and the branches below are those bases one for one — except for
// the MODEL, the single case altea widens.
function descriptionOptionsOf(ctor: Function): DescriptionOptions {

    // Signum's `[DescriptionOptions(All)]` on `Entity`.
    if (isOrExtends(ctor, Entity))
        return { hasDescription: true, hasPluralDescription: true, hasGender: true, hasMembers: true };

    // A MODEL is Signum's `ModifiableEntity` (`Description | Members`), WIDENED here to the plural and
    // the gender. A manual query is NAMED BY ITS ROW MODEL in altea — there is no QueryDescription to
    // hang a caption on — and a search page's title is the query name's PLURAL (`getQueryNiceName` →
    // `nicePluralName`). So `CustomerModel`'s plural is a user-visible page heading ("Customers" over
    // /find/CustomerModel), and the gender is what a determiner-inflecting language needs for "los
    // Clientes".
    if (isOrExtends(ctor, ModelEntity))
        return { hasDescription: true, hasPluralDescription: true, hasGender: true, hasMembers: true };

    // Signum's `[DescriptionOptions(Members | Description)]` on `ModifiableEntity`: an embedded is
    // named (a line's label, a tab caption) but never counted, so nothing would ever read its plural.
    if (isOrExtends(ctor, EmbeddedEntity))
        return { hasDescription: true, hasPluralDescription: false, hasGender: false, hasMembers: true };

    // Signum's `[DescriptionOptions(Members)]` on `MixinEntity`: a mixin's fields are FLATTENED onto
    // its owner, so only the member names are ever read — the mixin itself is never shown as a thing.
    if (isOrExtends(ctor, MixinEntity))
        return { hasDescription: false, hasPluralDescription: false, hasGender: false, hasMembers: true };

    // Anything else registered under `@reflect` (a bare BaseEntity subclass) gets Signum's
    // `ModifiableEntity` default — named and with members, nothing that has to be inflected.
    return { hasDescription: true, hasPluralDescription: false, hasGender: false, hasMembers: true };
}

function isOrExtends(ctor: Function, base: Function): boolean {
    return ctor === base || ctor.prototype instanceof base;
}

// A reflected class's member names, in the XML's PascalCase — every property ROUTE (so an embedded's
// members appear dotted under their owner, which is how the metadata builder keys them too).
function routeMemberNames(ctor: Function): string[] {
    return PropertyRoute.generateRoutes(ctor)
        .map(r => r.propertyString())
        .filter(p => p !== "")
        .map(capitalizePath);
}

function enumMemberNames(enumObject: object): string[] {
    // A numeric TS enum is a two-way map; the NAME keys are the non-numeric ones.
    return Object.keys(enumObject).filter(k => !/^\d+$/.test(k));
}

// A msg container's members are LocalizableMessage instances; their `defaultDescription` is the text the
// author wrote, and the app falls back to the inferred one when they wrote none — which is exactly the
// pair `niceToString()` resolves, so the master reads as the app does.
function messageDefaults(obj: object): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [member, value] of Object.entries(obj)) {
        const text = (value as LocalizableMessage | undefined)?.niceToString?.();
        if (typeof text === "string" && text !== "?")
            result[capitalize(member)] = text;
    }
    return result;
}

function capitalize(s: string): string {
    return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// "address.city" → "Address.City" — the casing Signum's XML uses and the one core's resolver probes
// (Localization.Internal.tryRouteNiceName tries both the raw and the capitalized path).
function capitalizePath(path: string): string {
    return path.replace(/(^|[.\]/])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

function folderOf(fileName: string): string {
    const i = fileName.lastIndexOf("/");
    return i < 0 ? "" : fileName.slice(0, i);
}

// ---- The files -------------------------------------------------------------------------------------------

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: n => n === "Type" || n === "Member" });
const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "", format: true, indentBy: "  ", suppressEmptyNode: true });

/** The `translations/` directory of a package, created on demand. undefined if the package is not installed. */
export function translationsDirOf(packageName: string, create = false): string | undefined {
    const pkgDir = tryResolvePackageDir(packageName, resolveAppRoot()) ?? resolveAppRootIfSelf(packageName);
    if (pkgDir == undefined)
        return undefined;
    const dir = join(pkgDir, "translations");
    if (!existsSync(dir)) {
        if (!create)
            return dir; // the caller only wanted the path (a read will simply find no file)
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// The APPLICATION's own package cannot be resolved through node_modules from itself, so fall back to the
// app root when the name matches (`loadAppTranslations` makes the same distinction).
function resolveAppRootIfSelf(packageName: string): string | undefined {
    const root = resolveAppRoot();
    try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
        return pkg.name === packageName ? root : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The file-name BASE a package's translation files use ("Altea.Tour" in `Altea.Tour.de.xml`).
 *
 * Read off whatever files the directory already has, so a hand-chosen base (`Altea.AuthAzureAD` for
 * `@altea/altea-auth-azuread`) is preserved; derived from the package name only when the directory is
 * empty. There is no other source — Signum gets it from the assembly name, which altea has no counterpart
 * for once the scope is stripped.
 */
export function fileBaseOf(packageName: string): string {
    const dir = translationsDirOf(packageName);
    if (dir != undefined && existsSync(dir)) {
        for (const file of readdirSync(dir)) {
            const m = /^(.*)\.[A-Za-z]{2}(?:-[A-Za-z]{2})?\.xml$/.exec(file);
            if (m != null)
                return m[1];
        }
    }
    return packageName.replace(/^@[^/]+\//, "").split("-").map(capitalize).join(".");
}

export function translationFilePath(packageName: string, culture: string, create = false): string | undefined {
    const dir = translationsDirOf(packageName, create);
    return dir == undefined ? undefined : join(dir, `${fileBaseOf(packageName)}.${culture}.xml`);
}

export function translationFileExists(packageName: string, culture: string): boolean {
    const path = translationFilePath(packageName, culture);
    return path != undefined && existsSync(path);
}

/**
 * Signum's `LocalizedAssembly.ImportXml(assembly, culture, forceCreate)` — the package's DECLARED shape for
 * a culture, filled in from its file where one exists. Every localizable type is present (with undefined
 * labels where nothing is translated), which is what makes the sync a straight comparison.
 */
export function importXml(packageName: string, culture: string): LocalizedPackage {
    const path = translationFilePath(packageName, culture);
    const stored = path != undefined && existsSync(path)
        ? parseFile(readFileSync(path, "utf8"))
        : new Map<string, StoredType>();

    // Signum's `assembly.IsDefault` branch in LocalizedType.ImportXml: the package's SOURCE language has
    // no file to read — its strings live in the CODE (@niceName / msg() / init({ niceName })), with the
    // humanised identifier below them. Without this the master side would be empty and the sync would
    // never offer anything to translate, which is the whole point of the page.
    const isDefault = culture === defaultCultureOf(packageName);

    const types = new Map<string, LocalizedType>();
    for (const t of localizableTypes()) {
        if (t.packageName !== packageName)
            continue;

        const s = stored.get(t.typeName);
        const declared = isDefault ? getDefaultDescription(t.typeName) : undefined;

        const description = t.options.hasDescription
            ? s?.description ?? (isDefault ? declared?.description ?? Localization.Internal.niceNameFromName(t.typeName) : undefined)
            : undefined;

        types.set(t.typeName, {
            typeName: t.typeName,
            folder: t.folder,
            options: t.options,
            description,
            pluralDescription: !t.options.hasPluralDescription ? undefined
                : s?.pluralDescription ?? (isDefault && description != undefined
                    ? declared?.pluralDescription ?? pluralize(description, culture) : undefined),
            gender: !t.options.hasGender ? undefined
                : s?.gender ?? (isDefault && description != undefined
                    ? declared?.gender ?? detectGender(description, culture) : undefined),
            members: new Map(t.members.map(m => [
                m,
                s?.members.get(m) ?? (isDefault
                    ? declared?.members[m] ?? declared?.members[lowerFirst(m)] ?? t.memberDefaults?.[m]
                    ?? Localization.Internal.niceMemberName(lastSegment(m))
                    : undefined),
            ])),
        });
    }
    return { packageName, culture, types };
}

// The declared defaults are keyed by the CODE's own casing (camelCase for a route, PascalCase for an enum
// member / message), while the XML — and therefore `t.members` — is PascalCase throughout.
function lowerFirst(s: string): string {
    return s.replace(/(^|[.\]/])([A-Z])/g, (_, sep: string, ch: string) => sep + ch.toLowerCase());
}

function lastSegment(path: string): string {
    const i = Math.max(path.lastIndexOf("."), path.lastIndexOf("/"));
    return i < 0 ? path : path.slice(i + 1);
}

/**
 * Signum's `LocalizedAssembly.ExportXml()` — write the file back, or DELETE it when nothing is translated
 * any more (Signum's `if (xml == null) File.Delete(path)`), so an empty file never lingers.
 */
export function exportXml(pkg: LocalizedPackage): void {
    const path = translationFilePath(pkg.packageName, pkg.culture, true);
    if (path == undefined)
        throw new Error(`Package '${pkg.packageName}' is not installed — nowhere to write its translations`);

    const typeNodes: Record<string, unknown>[] = [];
    for (const lt of [...pkg.types.values()].sort((a, b) => a.typeName.localeCompare(b.typeName))) {
        const memberNodes = [...lt.members.entries()]
            .filter(([, d]) => d != undefined && d !== "")
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, description]) => ({ Name: name, Description: description! }));

        const hasType = (lt.description ?? "") !== "" || (lt.pluralDescription ?? "") !== "" || (lt.gender ?? "") !== "";
        if (!hasType && memberNodes.length === 0)
            continue;

        const node: Record<string, unknown> = { Name: lt.typeName };
        if ((lt.description ?? "") !== "") node.Description = lt.description;
        if ((lt.pluralDescription ?? "") !== "") node.PluralDescription = lt.pluralDescription;
        if ((lt.gender ?? "") !== "") node.Gender = lt.gender;
        if (memberNodes.length > 0) node.Member = memberNodes;
        typeNodes.push(node);
    }

    if (typeNodes.length === 0) {
        if (existsSync(path))
            unlinkSync(path);
        return;
    }

    const xml = builder.build({
        "?xml": { version: "1.0", encoding: "utf-8", standalone: "yes" },
        Translations: { Type: typeNodes },
    }) as string;

    writeFileSync(path, xml, "utf8");
}

interface StoredType {
    description?: string;
    pluralDescription?: string;
    gender?: string;
    members: Map<string, string>;
}

function parseFile(xml: string): Map<string, StoredType> {
    const doc = parser.parse(xml) as { Translations?: { Type?: RawType[] } };
    const result = new Map<string, StoredType>();
    for (const t of doc.Translations?.Type ?? []) {
        if (t.Name == undefined) continue;
        const members = new Map<string, string>();
        for (const m of t.Member ?? [])
            if (m.Name != undefined && m.Description != undefined)
                members.set(String(m.Name), String(m.Description));
        result.set(String(t.Name), {
            description: t.Description == undefined ? undefined : String(t.Description),
            pluralDescription: t.PluralDescription == undefined ? undefined : String(t.PluralDescription),
            gender: t.Gender == undefined ? undefined : String(t.Gender),
            members,
        });
    }
    return result;
}

interface RawType {
    Name?: string; Description?: string; PluralDescription?: string; Gender?: string;
    Member?: { Name?: string; Description?: string }[];
}

// Referenced so the Entity base stays in the module graph for consumers that only import this file.
void Entity;
