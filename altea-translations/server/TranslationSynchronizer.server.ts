import { getDeterminer, tryGetGenderFromDeterminer, type Gender } from "@altea/altea/data/utils/naturalLanguage";
import type { ITranslator } from "./Translators.server";
import { isTypeCompleted, type LocalizedPackage, type LocalizedType } from "./LocalizedPackage.server";

// Port of Signum.Translation's TranslationSynchronizer.cs — "what is still missing in this culture, and
// what would the machine translators suggest for it?".
//
// The shape is Signum's exactly: `getMergeChanges` diffs the TARGET culture's file against the MASTER
// (the package's source language), producing one entry per type with a type-level and/or member-level
// conflict; `translate` then asks every configured translator for a suggestion, using the SUPPORT cultures
// (the other languages that DO have the string) as extra source material — which is what makes the
// suggestions good: a Spanish label is a far better source for Italian than the English one.
//
// altea divergences:
//  - the translators are ASYNC (see Translators.server), so `translate` awaits each batch.
//  - Signum's determiner round-trip (prefixing "el " / "la " so the translator reveals the GENDER, then
//    stripping it back off) is kept — it is the whole reason gender comes out of a machine translation —
//    and rides on altea's own naturalLanguage helpers (getDeterminer / tryGetGenderFromDeterminer, the
//    second one added to core for this) instead of NaturalLanguageTools.

export interface AutomaticTranslation {
    translatorName: string;
    text: string;
}

export interface AutomaticTypeTranslation {
    translatorName: string;
    gender?: string;
    singular: string;
    plural?: string;
}

export interface TypeNameConflict {
    original: LocalizedType;
    automaticTranslations: AutomaticTypeTranslation[];
}

export interface MemberNameConflict {
    original?: string;
    automaticTranslations: AutomaticTranslation[];
}

export interface LocalizedTypeChanges {
    type: LocalizedType;
    /** culture → the type-level labels that culture already has. undefined ⇒ nothing type-level is missing. */
    typeConflict?: Map<string, TypeNameConflict>;
    /** member → culture → what that culture has. */
    memberConflicts: Map<string, Map<string, MemberNameConflict>>;
}

export interface FolderSyncStats {
    folder: string;
    types: number;
    translations: number;
}

/** Signum's `MaxTotalSyncCharacters` — one sync page is capped, so a translator bill stays bounded. */
export let maxTotalSyncCharacters = 800;

/**
 * Signum's `GetAssemblyChanges` — the changes for ONE sync page: the merge diff, optionally narrowed to a
 * folder, chunked to {@link maxTotalSyncCharacters}, with the automatic suggestions filled in.
 */
export async function getPackageChanges(
    translators: ITranslator[],
    target: LocalizedPackage,
    master: LocalizedPackage,
    support: LocalizedPackage[],
    folder: string | undefined,
): Promise<{ types: LocalizedTypeChanges[]; totalTypes: number }> {

    let types = getMergeChanges(target, master, support);

    if (folder != undefined)
        types = types.filter(t => t.type.folder === folder);

    const totalTypes = types.length;

    // Signum's `Chunk(a => a.TotalOriginalLength(), Max).First()`: take types until the budget is spent.
    let used = 0;
    const chunk: LocalizedTypeChanges[] = [];
    for (const t of types) {
        const length = totalOriginalLength(t, master.culture);
        if (chunk.length > 0 && used + length > maxTotalSyncCharacters)
            break;
        chunk.push(t);
        used += length;
    }

    await translate(translators, target, chunk);

    return { types: chunk, totalTypes };
}

/** Signum's `SyncNamespaceStats` — how much is left to do, per folder. */
export function folderSyncStats(target: LocalizedPackage, master: LocalizedPackage): FolderSyncStats[] {
    const byFolder = new Map<string, { types: number; translations: number }>();

    for (const [typeName, ltm] of master.types) {
        const ltt = target.types.get(typeName);

        let count = (isTypeCompleted(ltm, master.culture) && (ltt == undefined || !isTypeCompleted(ltt, target.culture))) ? 1 : 0;
        for (const [member, text] of ltm.members)
            if (text != undefined && text !== "" && (ltt?.members.get(member) ?? undefined) == undefined)
                count++;

        if (count === 0)
            continue;

        const stats = byFolder.get(ltm.folder) ?? byFolder.set(ltm.folder, { types: 0, translations: 0 }).get(ltm.folder)!;
        stats.types++;
        stats.translations += count;
    }

    return [...byFolder.entries()]
        .map(([folder, s]) => ({ folder, types: s.types, translations: s.translations }))
        .sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * Signum's `GetMergeChanges` — one entry per type that has something missing in `target`, carrying what
 * the MASTER and each SUPPORT culture have for it.
 */
export function getMergeChanges(
    target: LocalizedPackage, master: LocalizedPackage, support: LocalizedPackage[],
): LocalizedTypeChanges[] {

    const result: LocalizedTypeChanges[] = [];

    for (const [typeName, masterType] of master.types) {
        const targetType = target.types.get(typeName);
        if (targetType == undefined)
            continue; // the type is not in the target's declared set (it was removed from the code)

        const supportTypes = support.map(la => ({ culture: la.culture, type: la.types.get(typeName) }))
            .filter((a): a is { culture: string; type: LocalizedType } => a.type != undefined);

        const typeConflict = typeConflicts(targetType, target.culture, master.culture, masterType, supportTypes);

        const memberConflicts = new Map<string, Map<string, MemberNameConflict>>();
        for (const member of masterType.members.keys()) {
            const con = memberConflict(member, targetType, master.culture, masterType, supportTypes);
            if (con != undefined)
                memberConflicts.set(member, con);
        }

        if (memberConflicts.size === 0 && typeConflict == undefined)
            continue;

        result.push({ type: targetType, typeConflict, memberConflicts });
    }

    return result;
}

function typeConflicts(
    target: LocalizedType, targetCulture: string, masterCulture: string, master: LocalizedType,
    support: { culture: string; type: LocalizedType }[],
): Map<string, TypeNameConflict> | undefined {

    if (!isTypeCompleted(master, masterCulture))
        return undefined;    // the SOURCE has nothing to translate from
    if (isTypeCompleted(target, targetCulture))
        return undefined;    // already done

    const sentences = new Map<string, TypeNameConflict>();
    sentences.set(masterCulture, { original: master, automaticTranslations: [] });
    for (const s of support)
        if (s.type.description != undefined && s.type.description !== "")
            sentences.set(s.culture, { original: s.type, automaticTranslations: [] });
    return sentences;
}

function memberConflict(
    member: string, target: LocalizedType, masterCulture: string, master: LocalizedType,
    support: { culture: string; type: LocalizedType }[],
): Map<string, MemberNameConflict> | undefined {

    const masterText = master.members.get(member);
    if (masterText == undefined || masterText === "")
        return undefined;
    const targetText = target.members.get(member);
    if (targetText != undefined && targetText !== "")
        return undefined;

    const sentences = new Map<string, MemberNameConflict>();
    sentences.set(masterCulture, { original: masterText, automaticTranslations: [] });
    for (const s of support) {
        const text = s.type.members.get(member);
        if (text != undefined && text !== "")
            sentences.set(s.culture, { original: text, automaticTranslations: [] });
    }
    return sentences;
}

/** Signum's `LocalizedTypeChanges.TotalOriginalLength` — the characters this type would cost to translate. */
function totalOriginalLength(t: LocalizedTypeChanges, masterCulture: string): number {
    let total = t.typeConflict?.get(masterCulture)?.original.description?.length ?? 0;
    for (const byCulture of t.memberConflicts.values())
        total += byCulture.get(masterCulture)?.original?.length ?? 0;
    return total;
}

/** Signum's private `Translate` — fill each conflict's `automaticTranslations` from every translator. */
async function translate(
    translators: ITranslator[], target: LocalizedPackage, types: LocalizedTypeChanges[],
): Promise<void> {

    // ---- Type descriptions, grouped by SOURCE culture -----------------------------------------------
    const typeGroups = new Map<string, TypeNameConflict[]>();
    for (const t of types)
        for (const [culture, tc] of t.typeConflict ?? [])
            (typeGroups.get(culture) ?? typeGroups.set(culture, []).get(culture)!).push(tc);

    for (const [culture, group] of typeGroups) {
        const valid = group.filter(a => a.original.description != undefined && a.original.description !== "");

        // Signum's determiner trick: ask for "el pedido\nlos pedidos" so the translator's own article
        // reveals the target-language GENDER, which is then read back off the first word.
        const originals = valid.map(a =>
            (a.original.options.hasGender
                ? (getDeterminer(a.original.gender as Gender | undefined, false, culture) ?? "") + " " + a.original.description!
                : a.original.description!)
            + (a.original.options.hasPluralDescription ? "\n" + (a.original.pluralDescription ?? "") : ""));

        for (const tr of translators) {
            const translations = await tr.translateBatch(originals, culture, target.culture);
            if (translations == null)
                continue;

            valid.forEach((sp, i) => {
                const translated = translations[i];
                if (translated == null)
                    return;

                const lines = translated.split("\n");
                let singular = lines[0];
                const plural = sp.original.options.hasPluralDescription ? lines[1] : undefined;

                let gender: string | undefined;
                if (sp.original.options.hasGender) {
                    const space = singular.indexOf(" ");
                    const determiner = space < 0 ? undefined : singular.slice(0, space);
                    gender = tryGetGenderFromDeterminer(determiner, false, target.culture);
                    if (gender != undefined)
                        singular = singular.slice(space + 1);
                }

                sp.automaticTranslations.push({ singular, plural, gender, translatorName: tr.name });
            });
        }
    }

    // ---- Members, grouped by SOURCE culture ----------------------------------------------------------
    const memberGroups = new Map<string, MemberNameConflict[]>();
    for (const t of types)
        for (const byCulture of t.memberConflicts.values())
            for (const [culture, mc] of byCulture)
                (memberGroups.get(culture) ?? memberGroups.set(culture, []).get(culture)!).push(mc);

    for (const [culture, group] of memberGroups) {
        const valid = group.filter(a => a.original != undefined && a.original !== "");
        const originals = valid.map(a => a.original!);

        for (const tr of translators) {
            const translations = await tr.translateBatch(originals, culture, target.culture);
            if (translations == null)
                continue;
            valid.forEach((sp, i) => {
                const text = translations[i];
                if (text != null)
                    sp.automaticTranslations.push({ text, translatorName: tr.name });
            });
        }
    }
}
