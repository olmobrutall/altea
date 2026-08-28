import { readFileSync } from "node:fs";
import "@altea/altea/server";
import { WebBuilder, CustomType, attachmentDisposition } from "@altea/altea/server/webApi";
import { pluralize, detectGender, determinersFor } from "@altea/altea/data/utils/naturalLanguage";
import type { Gender } from "@altea/altea/data/utils/naturalLanguage";
import { TranslatedSummaryState } from "../data/Translation";
import {
    importXml, exportXml, localizablePackages, defaultCultureOf, translationFileExists, translationFilePath,
    fileBaseOf, type LocalizedPackage,
} from "./LocalizedPackage.server";
import {
    getMergeChanges, getPackageChanges, folderSyncStats,
    type LocalizedTypeChanges, type AutomaticTranslation, type AutomaticTypeTranslation,
} from "./TranslationSynchronizer.server";
import { TranslatedInstanceLogic } from "./TranslatedInstanceLogic.server";
import { TranslationLogic } from "./TranslationLogic.server";

// Port of Signum.Translation's TranslationController.cs — the CODE half's HTTP surface: the status grid,
// the per-package view and sync pages, the save that writes the XML files back, and the two natural-
// language helpers the editor calls while you type.
//
// Every "assembly" in Signum's routes is a PACKAGE here (see LocalizedPackage for the mapping), and its
// second grouping level is the declaring FOLDER rather than a C# namespace — so `syncStats` and the
// `folder` query parameter replace `namespace`.
export namespace TranslationServer {

    // ---- The DTOs the pages consume (Signum's *TS classes) -------------------------------------------

    export interface TranslationFileStatus {
        package: string;
        culture: string;
        isDefault: boolean;
        status: TranslatedSummaryState;
    }

    export interface CultureTS {
        name: string;
        pronoms: { gender: string; singular: string; plural: string }[];
    }

    export interface LocalizedDescriptionTS {
        gender?: string;
        description?: string;
        pluralDescription?: string;
        automaticTranslations?: AutomaticTypeTranslation[];
    }

    export interface LocalizedMemberTS {
        name: string;
        description?: string;
        automaticTranslations?: AutomaticTranslation[];
    }

    export interface LocalizedTypeTS {
        culture: string;
        typeDescription?: LocalizedDescriptionTS;
        members: Record<string, LocalizedMemberTS>;
    }

    export interface LocalizableTypeTS {
        type: string;
        folder: string;
        hasMembers: boolean;
        hasGender: boolean;
        hasDescription: boolean;
        hasPluralDescription: boolean;
        cultures: Record<string, LocalizedTypeTS>;
    }

    export interface PackageResultTS {
        totalTypes: number;
        cultures: Record<string, CultureTS>;
        types: Record<string, LocalizableTypeTS>;
    }

    export interface FolderSyncStatsTS {
        folder: string;
        types: number;
        translations: number;
    }

    export function start(ws: WebBuilder): void {

        // ---- status --------------------------------------------------------------------------------
        ws.get("/api/translation/state",
            { res: CustomType<TranslationFileStatus[]>() },
            async (_req, res) => { res.jsonTyped(getState()); });

        // ---- download the raw file -------------------------------------------------------------------
        ws.get("/api/translation/download",
            {},
            async (req, res) => {
                const packageName = String(req.query["package"] ?? "");
                const culture = String(req.query["culture"] ?? "");
                const path = translationFilePath(packageName, culture);
                if (path == undefined || !translationFileExists(packageName, culture)) {
                    res.status(404).send("No translation file");
                    return;
                }

                res.setHeader("Content-Disposition", attachmentDisposition(`${fileBaseOf(packageName)}.${culture}.xml`));
                res.type("application/xml").send(readFileSync(path, "utf8"));
            });

        // ---- view (read every culture, optionally filtered) --------------------------------------------
        ws.get("/api/translation/retrieve",
            { res: CustomType<PackageResultTS>() },
            async (req, res) => {
                const packageName = String(req.query["package"] ?? "");
                const culture = req.query["culture"] == undefined || req.query["culture"] === ""
                    ? undefined : String(req.query["culture"]);
                const filter = String(req.query["filter"] ?? "");
                res.jsonTyped(retrieve(packageName, culture, filter));
            });

        // ---- sync (what is missing + suggestions) ------------------------------------------------------
        ws.post("/api/translation/sync",
            { res: CustomType<PackageResultTS>() },
            async (req, res) => {
                const packageName = String(req.query["package"] ?? "");
                const culture = String(req.query["culture"] ?? "");
                const folder = req.query["folder"] == undefined || req.query["folder"] === ""
                    ? undefined : String(req.query["folder"]);
                res.jsonTyped(await sync(packageName, culture, folder));
            });

        ws.get("/api/translation/syncStats",
            { res: CustomType<FolderSyncStatsTS[]>() },
            async (req, res) => {
                const packageName = String(req.query["package"] ?? "");
                const culture = String(req.query["culture"] ?? "");
                const target = importXml(packageName, culture);
                const master = importXml(packageName, defaultCultureOf(packageName));
                res.jsonTyped(folderSyncStats(target, master));
            });

        // ---- save (write the XML files back) -----------------------------------------------------------
        ws.post("/api/translation/save",
            { req: CustomType<PackageResultTS>() },
            async (req, res) => {
                const packageName = String(req.query["package"] ?? "");
                const culture = req.query["culture"] == undefined || req.query["culture"] === ""
                    ? undefined : String(req.query["culture"]);
                saveTypes(packageName, culture, await req.jsonTyped());
                res.json({ ok: true });
            });

        // ---- auto-translate ----------------------------------------------------------------------------
        ws.get("/api/translation/autoTranslate",
            {},
            async (req, res) => {
                await autoTranslate(String(req.query["package"] ?? ""), String(req.query["culture"] ?? ""));
                res.json({ ok: true });
            });

        ws.get("/api/translation/autoTranslateAll",
            {},
            async (req, res) => {
                const culture = String(req.query["culture"] ?? "");
                for (const s of getState())
                    if (s.culture === culture && !s.isDefault && s.status !== TranslatedSummaryState.Completed)
                        await autoTranslate(s.package, culture);
                res.json({ ok: true });
            });

        // ---- the two natural-language helpers the editor calls while you type ---------------------------
        ws.post("/api/translation/pluralize",
            { res: CustomType<string>() },
            async (req, res) => {
                const culture = String(req.query["culture"] ?? "");
                const text = await readText(req);
                res.jsonTyped(pluralize(text, culture));
            });

        ws.post("/api/translation/gender",
            { res: CustomType<string | null>() },
            async (req, res) => {
                const culture = String(req.query["culture"] ?? "");
                const text = await readText(req);
                res.jsonTyped(detectGender(text, culture) ?? null);
            });
    }

    // ---- implementations ------------------------------------------------------------------------------

    /** Signum's `GetState` — one row per (package, culture). */
    export function getState(): TranslationFileStatus[] {
        const cultures = TranslatedInstanceLogic.currentCultures();
        const result: TranslationFileStatus[] = [];

        for (const packageName of localizablePackages()) {
            const defaultCulture = defaultCultureOf(packageName);
            const master = importXml(packageName, defaultCulture);
            for (const culture of cultures)
                result.push({
                    package: packageName,
                    culture,
                    isDefault: culture === defaultCulture,
                    status: calculateStatus(packageName, culture, master),
                });
        }
        return result;
    }

    function calculateStatus(packageName: string, culture: string, master: LocalizedPackage): TranslatedSummaryState {
        if (culture === master.culture)
            return TranslatedSummaryState.Completed; // the source language needs no file
        if (!translationFileExists(packageName, culture))
            return TranslatedSummaryState.None;
        const target = importXml(packageName, culture);
        return getMergeChanges(target, master, []).length > 0
            ? TranslatedSummaryState.Pending : TranslatedSummaryState.Completed;
    }

    /** Signum's `Retrieve` — every culture side by side, for reading and hand-editing. */
    export function retrieve(packageName: string, culture: string | undefined, filter: string): PackageResultTS {
        const defaultCulture = defaultCultureOf(packageName);
        const cultures = TranslatedInstanceLogic.currentCultures()
            .filter(c => c === defaultCulture || c === culture || translationFileExists(packageName, c));

        const packages = cultures.map(c => importXml(packageName, c));
        const types: Record<string, LocalizableTypeTS> = {};

        for (const pkg of packages)
            for (const lt of pkg.types.values()) {
                const entry = types[lt.typeName] ??= {
                    type: lt.typeName,
                    folder: lt.folder,
                    hasMembers: lt.options.hasMembers,
                    hasGender: lt.options.hasGender,
                    hasDescription: lt.options.hasDescription,
                    hasPluralDescription: lt.options.hasPluralDescription,
                    cultures: {},
                };
                entry.cultures[pkg.culture] = {
                    culture: pkg.culture,
                    typeDescription: {
                        gender: lt.gender,
                        description: lt.description,
                        pluralDescription: lt.pluralDescription,
                    },
                    members: Object.fromEntries([...lt.members].map(([name, description]) =>
                        [name, { name, description } satisfies LocalizedMemberTS])),
                };
            }

        return {
            totalTypes: Object.keys(types).length,
            cultures: culturesTS(cultures),
            types: filter === "" ? sortByKey(types) : sortByKey(applyFilter(types, filter)),
        };
    }

    // Signum's filter: a type matches by NAME or by any of its descriptions; otherwise the type is kept
    // with only its MATCHING members.
    function applyFilter(types: Record<string, LocalizableTypeTS>, filter: string): Record<string, LocalizableTypeTS> {
        const f = filter.toLowerCase();
        const contains = (s: string | undefined): boolean => s != undefined && s.toLowerCase().includes(f);
        const result: Record<string, LocalizableTypeTS> = {};

        for (const [name, t] of Object.entries(types)) {
            const typeMatches = contains(t.type)
                || Object.values(t.cultures).some(c => contains(c.typeDescription?.description) || contains(c.typeDescription?.pluralDescription));
            if (typeMatches) {
                result[name] = t;
                continue;
            }

            const allMembers = [...new Set(Object.values(t.cultures).flatMap(c => Object.keys(c.members)))];
            const matching = allMembers.filter(m => contains(m)
                || Object.values(t.cultures).some(c => contains(c.members[m]?.description)));
            if (matching.length === 0)
                continue;

            const narrowed: LocalizableTypeTS = { ...t, cultures: {} };
            for (const [c, lt] of Object.entries(t.cultures))
                narrowed.cultures[c] = { ...lt, members: Object.fromEntries(matching.filter(m => lt.members[m] != undefined).map(m => [m, lt.members[m]])) };
            result[name] = narrowed;
        }
        return result;
    }

    /** Signum's `Sync` — what is missing in one culture, with the machine suggestions attached. */
    export async function sync(packageName: string, culture: string, folder: string | undefined): Promise<PackageResultTS> {
        const defaultCulture = defaultCultureOf(packageName);
        const cultures = TranslatedInstanceLogic.currentCultures()
            .filter(c => c === defaultCulture || c === culture || translationFileExists(packageName, c));

        const byCulture = new Map(cultures.map(c => [c, importXml(packageName, c)]));
        const master = byCulture.get(defaultCulture)!;
        const target = byCulture.get(culture)!;
        const support = [...byCulture.entries()].filter(([c]) => c !== defaultCulture && c !== culture).map(([, p]) => p);

        const { types: changes, totalTypes } = await getPackageChanges(TranslationLogic.translators, target, master, support, folder);

        const types: Record<string, LocalizableTypeTS> = {};
        for (const t of changes)
            types[t.type.typeName] = {
                type: t.type.typeName,
                folder: t.type.folder,
                hasMembers: t.type.options.hasMembers,
                hasGender: t.type.options.hasGender,
                hasDescription: t.type.options.hasDescription,
                hasPluralDescription: t.type.options.hasPluralDescription,
                cultures: Object.fromEntries(cultures.map(c => [c, localizedTypeOf(t, c, c === culture)])),
            };

        return { totalTypes, cultures: culturesTS(cultures), types: sortByKey(types) };
    }

    // Signum's `GetLocalizedType`: for the TARGET culture, pre-fill from the suggestions when they AGREE
    // (`DisctincOnly`); for a source culture, show what it has.
    function localizedTypeOf(t: LocalizedTypeChanges, culture: string, isTarget: boolean): LocalizedTypeTS {
        const tc = t.typeConflict?.get(culture);
        const allTypeSuggestions = [...(t.typeConflict?.values() ?? [])].flatMap(a => a.automaticTranslations);

        return {
            culture,
            typeDescription: t.typeConflict == undefined || (tc == undefined && !isTarget) ? undefined : {
                description: tc?.original.description ?? (isTarget ? distinctOnly(allTypeSuggestions.map(a => a.singular)) : undefined),
                pluralDescription: tc?.original.pluralDescription ?? (isTarget ? distinctOnly(allTypeSuggestions.map(a => a.plural)) : undefined),
                gender: tc?.original.gender ?? (isTarget ? distinctOnly(allTypeSuggestions.map(a => a.gender)) : undefined),
                automaticTranslations: tc?.automaticTranslations,
            },
            members: Object.fromEntries([...t.memberConflicts.entries()]
                .filter(([, byCulture]) => byCulture.has(culture) || isTarget)
                .map(([member, byCulture]) => {
                    const mc = byCulture.get(culture);
                    const all = [...byCulture.values()].flatMap(a => a.automaticTranslations);
                    return [member, {
                        name: member,
                        description: mc?.original ?? (isTarget ? distinctOnly(all.map(a => a.text)) : undefined),
                        automaticTranslations: mc?.automaticTranslations,
                    } satisfies LocalizedMemberTS];
                })),
        };
    }

    // Signum's `DisctincOnly` (sic): pre-fill only when at least two translators produced the SAME answer.
    function distinctOnly(values: (string | undefined)[]): string | undefined {
        if (values.length < 2)
            return undefined;
        const distinct = [...new Set(values)];
        return distinct.length === 1 ? distinct[0] : undefined;
    }

    /** Signum's `SaveTypes` — overlay what the page posted onto each culture's file and write it back. */
    export function saveTypes(packageName: string, culture: string | undefined, result: PackageResultTS): void {
        for (const cult of Object.keys(result.cultures)) {
            if (culture != undefined && culture !== cult)
                continue;

            const pkg = importXml(packageName, cult);
            for (const lt of pkg.types.values()) {
                const ts = result.types[lt.typeName]?.cultures[cult];
                if (ts == undefined)
                    continue;

                if (ts.typeDescription != undefined) {
                    lt.gender = ts.typeDescription.gender == undefined ? undefined : ts.typeDescription.gender.charAt(0);
                    lt.description = ts.typeDescription.description;
                    lt.pluralDescription = ts.typeDescription.pluralDescription;
                }
                for (const [name, m] of Object.entries(ts.members))
                    lt.members.set(name, m.description);
            }
            exportXml(pkg);
        }
    }

    /**
     * Signum's `AutoTranslate` — accept the first suggestion for everything, repeatedly, until the sync is
     * empty. The loop is bounded by the fact that each pass SAVES what it filled in, so the next pass has
     * strictly less to do; it also stops when a pass fills nothing, so a type nothing can translate does
     * not spin forever (Signum's loop would).
     */
    export async function autoTranslate(packageName: string, culture: string): Promise<void> {
        for (; ;) {
            const changes = await sync(packageName, culture, undefined);
            if (Object.keys(changes.types).length === 0)
                return;

            let filled = 0;
            for (const t of Object.values(changes.types)) {
                const locType = t.cultures[culture];
                if (locType == undefined)
                    continue;

                if (t.hasDescription && locType.typeDescription != undefined) {
                    const suggestions = Object.entries(t.cultures)
                        .filter(([c]) => c !== culture)
                        .flatMap(([, v]) => v.typeDescription?.automaticTranslations ?? []);
                    const first = suggestions[0];
                    if (first != undefined) {
                        if ((locType.typeDescription.description ?? "") === "") { locType.typeDescription.description = first.singular; filled++; }
                        if ((locType.typeDescription.pluralDescription ?? "") === "") { locType.typeDescription.pluralDescription = first.plural; filled++; }
                        if ((locType.typeDescription.gender ?? "") === "") locType.typeDescription.gender = first.gender;
                    }
                }

                if (t.hasMembers)
                    for (const [member, m] of Object.entries(locType.members)) {
                        if ((m.description ?? "") !== "")
                            continue;
                        const first = Object.entries(t.cultures)
                            .filter(([c]) => c !== culture)
                            .flatMap(([, v]) => v.members[member]?.automaticTranslations ?? [])[0];
                        if (first != undefined) { m.description = first.text; filled++; }
                    }
            }

            if (filled === 0)
                return; // nothing left that a translator can help with

            saveTypes(packageName, culture, changes);
        }
    }

    function culturesTS(cultures: string[]): Record<string, CultureTS> {
        return Object.fromEntries(cultures.map(name => [name, {
            name,
            pronoms: determinersFor(name).map(d => ({ gender: d.gender as Gender as string, singular: d.singular, plural: d.plural })),
        } satisfies CultureTS]));
    }

    function sortByKey<T>(o: Record<string, T>): Record<string, T> {
        return Object.fromEntries(Object.entries(o).sort((a, b) => a[0].localeCompare(b[0])));
    }
}

// The two natural-language helpers take the raw text as the request BODY (Signum posts a bare string).
// altea's typed reader expects JSON, so read the raw body and strip the JSON quoting when present — the
// same accommodation altea-office-template's XML route makes.
async function readText(req: { text?: () => Promise<string>; body?: unknown }): Promise<string> {
    const raw = req.text != undefined ? await req.text() : String(req.body ?? "");
    if (raw.startsWith("\"") && raw.endsWith("\""))
        try { return JSON.parse(raw) as string; } catch { /* not JSON — use it verbatim */ }
    return raw;
}
