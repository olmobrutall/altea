import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { declaredLegacyClassNames } from "@altea/altea/data/registration";
import {
    exportXml, importXml, localizableTypes, parseTranslationXml,
    defaultCultureOf, type LocalizableType, type StoredType,
} from "./LocalizedPackage";

/**
 * Port a Signum application's translation files into this altea process's packages.
 *
 * Signum ships its translated strings as `<Assembly>/Translations/<Assembly>.<culture>.xml`, and altea's
 * files are the same XML one directory over (`<package>/translations/<Base>.<culture>.xml`) — so a port is
 * not a conversion of FORMAT but a re-addressing of three things at once, and each one is why doing it by
 * hand goes wrong:
 *
 *  - **The owner moved.** A translation is filed under the ASSEMBLY that declared the type, and altea
 *    regrouped: Signum.Authorization.WindowsAD's `ActiveDirectoryMessage` is declared by @altea/altea-auth
 *    (one shared AD base for both directory modules). So the port cannot copy file to file — it pools every
 *    source entry by TYPE and asks the running process which package declares that type now.
 *  - **The type was renamed.** `@legacyClassName` already records exactly this, because Signum's
 *    `TypeEntity.className` has to keep matching: `@legacyClassName("WordTemplateEntity")` on
 *    `OfficeTemplateEntity` is the port's rename table, written once, in the code, for a reason that has
 *    nothing to do with translations. The port reads it rather than asking for it again.
 *  - **A name that is renamed usually needs rewording.** altea's Office templates render docx, pptx AND
 *    xlsx, so the German "Word-Vorlage" is no longer true of them. {@link TranslationPortRule} carries
 *    both halves — how to rewrite an identifier, and how to reword the text, per culture.
 *
 * Anything the running process does not declare is REPORTED, never written: a translation altea cannot
 * resolve is dead weight in the file and `exportXml` would strip it on the next save anyway. The report is
 * the working list — re-run with the unmatched names added to `typeRenames` / `memberRenames` until it is
 * empty or the leftovers are modules altea does not have.
 *
 * Used for Signum → altea (the framework packages) and for an application's own port (Southwind →
 * eastwind); the two differ only in `sourceRoot`.
 */

/** A rewrite applied to the names and the text of the types it selects. */
export interface TranslationPortRule {
    /** Signum type names this rule applies to. A string matches exactly; omitted means every type. */
    types?: (string | RegExp)[];
    /**
     * Applied to the TYPE name and to each MEMBER name, in order — the conventional half of a rename, so
     * `WordTemplateEntity.WordConverter` follows `WordTemplateEntity` → `OfficeTemplateEntity` without a
     * line per member. A rewritten name is used only if the process actually declares it.
     */
    identifiers?: [RegExp | string, string][];
    /** Applied to every ported string, in order, for every culture. */
    text?: [RegExp | string, string][];
    /** Applied to every ported string of THAT culture, after `text` — where the wording is language-specific. */
    textByCulture?: Record<string, [RegExp | string, string][]>;
}

export interface TranslationPortOptions {
    /** Directory to scan for source files — a Signum checkout, or one application's folder. */
    sourceRoot: string;
    /** Cultures to port. Defaults to every culture found under `sourceRoot` that is not a package's own. */
    cultures?: string[];
    /** Signum type name → altea type name, for what `@legacyClassName` and the rules do not already say. */
    typeRenames?: Record<string, string>;
    /** `"SignumType.Member"` → altea member name, for a member that was renamed on its own. */
    memberRenames?: Record<string, string>;
    rules?: TranslationPortRule[];
    /** Replace a string altea already has. Default false: the port only FILLS, never overwrites. */
    overwrite?: boolean;
    /** Work out everything and report it, but write no file. */
    dryRun?: boolean;
}

export interface TranslationPortReport {
    cultures: string[];
    /** Files written (or that would be, under `dryRun`). */
    written: string[];
    filledTypes: number;
    filledMembers: number;
    reworded: number;
    /** Source entries kept out because they were already translated here. */
    keptExisting: number;
    /**
     * Signum type names the process does not declare, with how many strings each would have carried and
     * the best altea candidate if one looks convincing — see {@link suggester}. A line here is either a
     * `typeRenames` entry waiting to be written or a module altea does not have.
     */
    unmatchedTypes: { type: string; strings: number; suggestion?: string }[];
    /** `"AlteaType.SignumMember"` the altea type does not declare. */
    unmatchedMembers: string[];
}

export function portTranslations(options: TranslationPortOptions): TranslationPortReport {
    const rules = options.rules ?? [];
    const byCulture = readSource(options.sourceRoot, options.cultures);
    const resolveType = typeResolver(options);

    const report: TranslationPortReport = {
        cultures: [...byCulture.keys()].sort(), written: [], filledTypes: 0, filledMembers: 0,
        reworded: 0, keptExisting: 0, unmatchedTypes: [], unmatchedMembers: [],
    };
    const unmatched = new Map<string, number>();
    const unmatchedSource = new Map<string, StoredType>();
    const unmatchedMembers = new Set<string>();
    const declaredByName = new Map(localizableTypes().map(t => [t.typeName, t]));

    for (const [culture, source] of byCulture) {
        // Resolve every source type to (altea type, owning package) ONCE, then port package by package —
        // importXml/exportXml work on one package's file and that is the unit that gets written.
        const perPackage = new Map<string, { target: LocalizableType; from: StoredType; signumName: string }[]>();
        for (const [signumName, stored] of source) {
            const alteaName = resolveType(signumName);
            const target = alteaName == undefined ? undefined : declaredByName.get(alteaName);
            if (target == undefined) {
                unmatched.set(signumName, (unmatched.get(signumName) ?? 0) + countStrings(stored));
                unmatchedSource.set(signumName, stored);
                continue;
            }
            (perPackage.get(target.packageName) ?? perPackage.set(target.packageName, []).get(target.packageName)!)
                .push({ target, from: stored, signumName });
        }

        for (const [packageName, entries] of perPackage) {
            // A package's OWN language is written in its code, not in a file — there is nothing to port into.
            if (culture === defaultCultureOf(packageName))
                continue;

            const pkg = importXml(packageName, culture);
            let touched = false;

            for (const { target, from, signumName } of entries) {
                const lt = pkg.types.get(target.typeName);
                if (lt == undefined)
                    continue;
                const reword = (text: string): string => {
                    const next = applyText(text, signumName, culture, rules);
                    if (next !== text) report.reworded++;
                    return next;
                };

                if (lt.options.hasDescription && from.description)
                    touched = fill(lt, "description", reword(from.description), options, report) || touched;
                if (lt.options.hasPluralDescription && from.pluralDescription)
                    touched = fill(lt, "pluralDescription", reword(from.pluralDescription), options, report) || touched;
                if (lt.options.hasGender && from.gender)
                    touched = fill(lt, "gender", from.gender, options, report) || touched;

                if (!lt.options.hasMembers)
                    continue;
                for (const [signumMember, text] of from.members) {
                    const member = resolveMember(signumName, signumMember, target, options, rules);
                    if (member == undefined) {
                        unmatchedMembers.add(`${target.typeName}.${signumMember}`);
                        continue;
                    }
                    const existing = lt.members.get(member);
                    if (existing != undefined && existing !== "" && !options.overwrite) {
                        report.keptExisting++;
                        continue;
                    }
                    lt.members.set(member, reword(text));
                    report.filledMembers++;
                    touched = true;
                }
            }

            if (!touched)
                continue;
            report.written.push(`${packageName} ${culture}`);
            if (!options.dryRun)
                exportXml(pkg);
        }
    }

    const suggest = suggester(unmatchedSource);
    report.unmatchedTypes = [...unmatched].map(([type, strings]) => ({ type, strings, suggestion: suggest(type) }))
        .sort((a, b) => b.strings - a.strings);
    report.unmatchedMembers = [...unmatchedMembers].sort();
    return report;
}

/** One type-level string, honouring fill-only. Returns whether the file needs rewriting. */
function fill(
    lt: { description?: string; pluralDescription?: string; gender?: string },
    field: "description" | "pluralDescription" | "gender",
    value: string, options: TranslationPortOptions, report: TranslationPortReport,
): boolean {
    const existing = lt[field];
    if (existing != undefined && existing !== "" && !options.overwrite) {
        report.keptExisting++;
        return false;
    }
    lt[field] = value;
    if (field === "description") report.filledTypes++;
    return true;
}

/**
 * Signum type name → altea type name, in the order the names become less certain: what the operator
 * SAID, what the code DECLARED (`@legacyClassName`), what a rule's identifier rewrite makes of it, and
 * finally the name itself. Every answer but the first is confirmed against the declared set, so a rule
 * that rewrites too eagerly cannot invent a target.
 */
function typeResolver(options: TranslationPortOptions): (signumName: string) => string | undefined {
    const declared = new Set(localizableTypes().map(t => t.typeName));
    const legacy = new Map([...declaredLegacyClassNames()].map(([className, ctor]) => [className, ctor.name]));
    const rules = options.rules ?? [];
    const cache = new Map<string, string | undefined>();

    return (signumName: string): string | undefined => {
        if (cache.has(signumName))
            return cache.get(signumName);

        let answer = options.typeRenames?.[signumName];
        if (answer == undefined) {
            const fromCode = legacy.get(signumName);
            if (fromCode != undefined && declared.has(fromCode))
                answer = fromCode;
        }
        if (answer == undefined) {
            const rewritten = applyIdentifiers(signumName, signumName, rules);
            if (rewritten !== signumName && declared.has(rewritten))
                answer = rewritten;
        }
        if (answer == undefined && declared.has(signumName))
            answer = signumName;

        cache.set(signumName, answer);
        return answer;
    };
}

/** Signum member name → a member the altea type actually declares, or undefined. */
function resolveMember(
    signumType: string, signumMember: string, target: LocalizableType,
    options: TranslationPortOptions, rules: TranslationPortRule[],
): string | undefined {
    const declared = new Set(target.members);
    const named = options.memberRenames?.[`${signumType}.${signumMember}`];
    if (named != undefined)
        return declared.has(named) ? named : undefined;

    // Casing is a CONVENTION difference, not a rename. altea writes every member PascalCase in the XML
    // (`localizableTypes` capitalises), while Signum writes the C# identifier as declared — and a message
    // container's members are camelCase there (`JavascriptMessage.addFilter`). Probing both spellings is
    // the same tolerance `importXml` already applies to the declared defaults; without it ~40 of the
    // framework's most-used strings look like members altea does not have.
    for (const candidate of [signumMember, capitalize(signumMember), lowerFirst(signumMember)])
        if (declared.has(candidate))
            return candidate;

    const rewritten = applyIdentifiers(signumMember, signumType, rules);
    if (rewritten === signumMember)
        return undefined;
    for (const candidate of [rewritten, capitalize(rewritten), lowerFirst(rewritten)])
        if (declared.has(candidate))
            return candidate;
    return undefined;
}

function capitalize(s: string): string {
    return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
    return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function applyIdentifiers(name: string, signumType: string, rules: TranslationPortRule[]): string {
    let result = name;
    for (const rule of rules)
        if (selects(rule, signumType))
            for (const [from, to] of rule.identifiers ?? [])
                result = result.replace(from as RegExp, to);
    return result;
}

function applyText(text: string, signumType: string, culture: string, rules: TranslationPortRule[]): string {
    let result = text;
    for (const rule of rules) {
        if (!selects(rule, signumType))
            continue;
        for (const [from, to] of rule.text ?? [])
            result = result.replace(from as RegExp, to);
        for (const [from, to] of rule.textByCulture?.[culture] ?? [])
            result = result.replace(from as RegExp, to);
    }
    return result;
}

function selects(rule: TranslationPortRule, signumType: string): boolean {
    if (rule.types == undefined)
        return true;
    return rule.types.some(t => typeof t === "string" ? t === signumType : t.test(signumType));
}

/**
 * A name the operator could put in `typeRenames`, found by SHAPE rather than by spelling: the declared
 * type whose member set overlaps this one's the most.
 *
 * Spelling is what already failed — altea's restructurings rename a type precisely when they change what
 * it IS (`PanelPartEmbedded` → `DashboardEntity_Part`, `OrderDetailEmbedded` → `OrderLineEntity`), and no
 * string rule connects those. Their MEMBERS survive the move nearly intact, which is the signal. Offered
 * only above half the source's members and only with three or more to go on, so a two-member embedded
 * cannot match everything; and offered, never applied — the operator confirms it into the map.
 */
function suggester(sources: Map<string, StoredType>): (signumName: string) => string | undefined {
    const declared = localizableTypes().map(t => ({ name: t.typeName, members: new Set(t.members.map(m => m.toLowerCase())) }));

    return (signumName: string): string | undefined => {
        const members = [...(sources.get(signumName)?.members.keys() ?? [])].map(m => m.toLowerCase());
        if (members.length < 3)
            return undefined;

        let best: { name: string; hits: number } | undefined;
        for (const candidate of declared) {
            let hits = 0;
            for (const m of members) if (candidate.members.has(m)) hits++;
            if (best == undefined || hits > best.hits)
                best = { name: candidate.name, hits };
        }
        return best != undefined && best.hits * 2 > members.length ? best.name : undefined;
    };
}

function countStrings(t: StoredType): number {
    return (t.description ? 1 : 0) + t.members.size;
}

/**
 * Every source file under `sourceRoot`, pooled per culture and keyed by TYPE — the step that makes a
 * regrouped package irrelevant, because the port re-derives the owner from the running process.
 *
 * A file is any `*.<culture>.xml` inside a directory named `translations`, which is both layouts: Signum's
 * `Signum.Alerts/Translations/Signum.Alerts.de.xml` and altea's `altea-alert/translations/Altea.Alerts.de.xml`
 * (so an altea tree can be a source too — one application porting from another).
 */
function readSource(sourceRoot: string, cultures: string[] | undefined): Map<string, Map<string, StoredType>> {
    const wanted = cultures == undefined ? undefined : new Set(cultures);
    const result = new Map<string, Map<string, StoredType>>();

    for (const file of translationFilesUnder(sourceRoot)) {
        const culture = /\.([A-Za-z]{2}(?:-[A-Za-z]{2,4})?)\.xml$/.exec(file)?.[1];
        if (culture == undefined || (wanted != undefined && !wanted.has(culture)))
            continue;

        const pool = result.get(culture) ?? result.set(culture, new Map()).get(culture)!;
        for (const [typeName, stored] of parseTranslationXml(readFileSync(file, "utf8"))) {
            const existing = pool.get(typeName);
            if (existing == undefined) {
                pool.set(typeName, stored);
                continue;
            }
            // Two assemblies describing one type name is Signum re-declaring a shared base; first wins for
            // the type-level strings, and the members union.
            existing.description ??= stored.description;
            existing.pluralDescription ??= stored.pluralDescription;
            existing.gender ??= stored.gender;
            for (const [m, d] of stored.members)
                if (!existing.members.has(m)) existing.members.set(m, d);
        }
    }
    return result;
}

function translationFilesUnder(root: string, inTranslations = false, acc: string[] = []): string[] {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return acc; // unreadable or not a directory — nothing to take from it
    }
    for (const e of entries) {
        const path = join(root, e.name);
        if (e.isDirectory()) {
            if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "bin" || e.name === "obj")
                continue;
            translationFilesUnder(path, inTranslations || e.name.toLowerCase() === "translations", acc);
        } else if (inTranslations && e.name.toLowerCase().endsWith(".xml")) {
            acc.push(path);
        }
    }
    return acc;
}

/** A one-line-per-fact summary — what a terminal command prints. */
export function formatPortReport(r: TranslationPortReport, limit = 30): string {
    const lines = [
        `cultures: ${r.cultures.join(", ") || "(none found)"}`,
        `filled: ${r.filledTypes} type descriptions, ${r.filledMembers} members (${r.reworded} reworded)`,
        `kept: ${r.keptExisting} already translated here`,
        `files: ${r.written.length}${r.written.length > 0 ? ` — ${r.written.join(", ")}` : ""}`,
    ];
    if (r.unmatchedTypes.length > 0)
        lines.push(`unmatched types (${r.unmatchedTypes.length}): `
            + r.unmatchedTypes.slice(0, limit).map(u => `${u.type}(${u.strings})${u.suggestion ? ` →? ${u.suggestion}` : ""}`).join(", ")
            + (r.unmatchedTypes.length > limit ? ", …" : ""));
    if (r.unmatchedMembers.length > 0)
        lines.push(`unmatched members (${r.unmatchedMembers.length}): `
            + r.unmatchedMembers.slice(0, limit).join(", ") + (r.unmatchedMembers.length > limit ? ", …" : ""));
    return lines.join("\n");
}
