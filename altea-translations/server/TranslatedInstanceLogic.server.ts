import "@altea/altea/server"; // installs save()/toLite()
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { table } from "@altea/altea/server/table";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import { PropertyRouteTranslationLogic } from "@altea/altea/server/propertyRouteTranslation";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { Entity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { CultureInfo } from "@altea/altea/data/utils/cultureInfo";
import { cleanTypeName } from "@altea/altea/data/registration";
import { PlainExcelGenerator } from "@altea/altea-office-template/server/excel/PlainExcelGenerator.server";
import {
    TranslatedInstanceEntity, TranslatedSummaryState, MatchTranslatedInstances,
} from "../data/Translation";
import type { ITranslator } from "./Translators.server";
import type { AutomaticTranslation } from "./TranslationSynchronizer.server";

// Port of Signum.Translation's Instances/TranslatedInstanceLogic.cs (+ TranslatedInstanceSynchronizer.cs) —
// the storage, cache, status, sync and excel round-trip of PER-INSTANCE translations.
//
// The one structural divergence, which simplifies most of this file, is that **there is no rowId**: altea
// has no MList, so a collection row is an ENTITY with its own lite and its own PropertyRoute root. A
// translation is therefore keyed by (culture, instance lite, route string) and nothing else — Signum's
// `LocalizedInstanceKey` triple, its MList primary-key parsing, the `"route;rowId"` composite key and the
// whole `RemoveTranslationsForMissingRowIds` branch all collapse. See core's PropertyRouteTranslationLogic
// for the full note.
//
// Other divergences:
//  - the lazy is ASYNC (altea's ResetLazy), so every reader awaits; `translatedFieldFunc` — which is SYNC,
//    because it is called from the serializer — reads a snapshot the lazy refreshes (the pattern
//    CultureInfoLogic and GlobalsLogic already use).
//  - `Schema.GetInMemoryFilter<TranslatedInstanceEntity>` (the row-level visibility filter applied to the
//    excel export) has no counterpart: altea enforces type conditions as a QUERY filter, so the rows the
//    export reads are already scoped.
//  - `BulkInsert` becomes a plain save loop inside the transaction — the volumes here are one type's
//    translations, and a bulk insert would bypass the entity events.
export namespace TranslatedInstanceLogic {

    /** Signum's `LocalizedInstanceKey` minus the rowId: "<lite key>|<route>". */
    export type InstanceKey = string;

    export function instanceKey(lite: Lite<Entity>, route: string): InstanceKey {
        return `${lite.key()}|${route}`;
    }

    /** Signum's `DefaultCulture` — the language the stored (untranslated) values are written in. */
    let getDefaultCulture: () => string = () => CultureInfo.defaultUICulture();
    export function defaultCulture(): string { return getDefaultCulture(); }

    /**
     * Signum's `InstanceFilters` — an optional per-type predicate narrowing which rows are worth
     * translating at all ("only the user queries that a dashboard or a toolbar actually shows"). The Status
     * and Sync pages offer it as the "only recommended instances" toggle.
     */
    const instanceFilters = new Map<Function, (e: Entity) => boolean>();

    export function registerFilter<T extends Entity>(type: Type<T>, filter: (e: T) => boolean): void {
        instanceFilters.set(type, filter as (e: Entity) => boolean);
    }

    // culture → key → row. Async lazy + a SYNC snapshot, because the serializer hook cannot await.
    let localizationCache: ResetLazy<Map<string, Map<InstanceKey, TranslatedInstanceEntity>>> = null!;
    let snapshot = new Map<string, Map<InstanceKey, TranslatedInstanceEntity>>();

    export function start(sb: SchemaBuilder, defaultCultureFn: () => string): void {
        if (sb.alreadyDefined(start))
            return;

        getDefaultCulture = defaultCultureFn;

        PropertyRouteTranslationLogic.start(sb);

        sb.include(TranslatedInstanceEntity).withQuery();

        localizationCache = sb.globalLazy(async () => {
            const all = await table(TranslatedInstanceEntity).toArray();
            const byCulture = new Map<string, Map<InstanceKey, TranslatedInstanceEntity>>();
            for (const ti of all) {
                const culture = ti.culture.name;
                const map = byCulture.get(culture) ?? byCulture.set(culture, new Map()).get(culture)!;
                map.set(instanceKey(ti.instance, ti.propertyRoute), ti);
            }
            snapshot = byCulture;
            return byCulture;
        }, { invalidateWith: [TranslatedInstanceEntity] });

        // Signum's `PropertyRouteTranslationLogic.TranslatedFieldFunc`: the resolver every read goes
        // through. A translation whose ORIGINAL no longer matches the row's current value is stale and is
        // NOT used — the fallback wins, and the Sync page lists it.
        PropertyRouteTranslationLogic.translatedFieldFunc = (lite, route, fallback) => {
            const ti = getTranslatedInstance(lite, route.propertyString(), CultureInfo.currentUICulture());
            if (ti != undefined && (fallback == null || normalize(ti.originalText) === normalize(fallback)))
                return ti.translatedText;
            return fallback;
        };

        PropertyRouteTranslationLogic.installSerializerHook();
        PropertyRouteTranslationLogic.isActivated = true;
    }

    /** Warm the sync snapshot after `schema.initialize()` (the pattern CultureInfoLogic uses). */
    export async function warmUp(): Promise<void> {
        await localizationCache.value();
    }

    // Signum compares originals ignoring line endings, so a CRLF/LF difference is not a stale translation.
    function normalize(text: string): string {
        return text.replace(/\r/g, "").replace(/\n/g, "");
    }

    /**
     * Signum's `GetTranslatedInstance` — with the same culture fallback: the exact culture, then its
     * neutral language ("es-AR" → "es").
     */
    export function getTranslatedInstance(lite: Lite<Entity>, route: string, culture: string): TranslatedInstanceEntity | undefined {
        const key = instanceKey(lite, route);
        const exact = snapshot.get(culture)?.get(key);
        if (exact != undefined)
            return exact;
        const dash = culture.indexOf("-");
        return dash > 0 ? snapshot.get(culture.slice(0, dash))?.get(key) : undefined;
    }

    // ---- Status ------------------------------------------------------------------------------------

    export interface TranslatedTypeSummary {
        type: string;
        culture: string;
        isDefaultCulture: boolean;
        state: TranslatedSummaryState | null;
    }

    /** Signum's `TranslationInstancesStatus` — the grid on the instance status page. */
    export async function translationInstancesStatus(applyFilter = true): Promise<TranslatedTypeSummary[]> {
        const cultures = currentCultures();
        const result: TranslatedTypeSummary[] = [];

        for (const type of PropertyRouteTranslationLogic.translatableTypes()) {
            for (const culture of cultures) {
                const isDefault = culture === defaultCulture();
                result.push({
                    type: cleanTypeName(type),
                    culture,
                    isDefaultCulture: isDefault,
                    // Signum only computes a state for a NEUTRAL, non-default culture; the rest are "-".
                    state: !isDefault && !culture.includes("-") ? await getState(type, culture, applyFilter) : null,
                });
            }
        }
        return result;
    }

    /** Signum's `TranslationLogic.CurrentCultureInfos` — the app's cultures, the default first. */
    export function currentCultures(): string[] {
        const def = defaultCulture();
        return CultureInfoLogic.applicationCultures()
            .sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
    }

    async function getState(type: Function, culture: string, applyFilter: boolean): Promise<TranslatedSummaryState> {
        const master = await fromEntities(type, applyFilter);
        const translations = await translationsForType(type, culture);

        const anyMissing = [...master.entries()].some(([key, value]) => {
            if (value == null || value === "")
                return false;
            const ti = translations.get(key);
            return ti == undefined || normalize(ti.originalText) !== normalize(value);
        });

        if (!anyMissing)
            return TranslatedSummaryState.Completed;

        return translations.size === 0 ? TranslatedSummaryState.None : TranslatedSummaryState.Pending;
    }

    // ---- Reading the current values -----------------------------------------------------------------

    export interface MasterValue {
        lite: Lite<Entity>;
        route: string;
        text: string | null;
    }

    /**
     * Signum's `FromEntities` — the CURRENT value of every translatable route of every row of `type`,
     * keyed the same way the cache is. This is the "what should be translated" side of every comparison.
     *
     * Signum builds one query per route (a per-route lambda + an MList query); altea reads the ROWS once
     * and walks their routes in memory, because a `@part` collection is a separate type with its own pass
     * and an embedded's value is already on the loaded row.
     */
    export async function fromEntities(type: Function, applyFilter = false): Promise<Map<InstanceKey, string | null>> {
        const result = new Map<InstanceKey, string | null>();
        for (const v of await masterValues(type, applyFilter))
            result.set(instanceKey(v.lite, v.route), v.text);
        return result;
    }

    export async function masterValues(type: Function, applyFilter = false): Promise<MasterValue[]> {
        const routes = [...PropertyRouteTranslationLogic.routesOf(type).keys()];
        if (routes.length === 0)
            return [];

        const filter = applyFilter ? instanceFilters.get(type) : undefined;
        const rows = await ExecutionMode.global(() => table(type as Type<Entity>).toArray());

        const result: MasterValue[] = [];
        for (const row of rows) {
            if (filter != undefined && !filter(row))
                continue;
            const lite = row.toLite();
            for (const route of routes)
                result.push({ lite, route, text: readRoute(row, route) });
        }
        return result;
    }

    // Walk a dotted route on a loaded row. Only value and embedded steps occur — a translatable route never
    // crosses an entity reference (PropertyRoute.generateRoutes re-roots there).
    function readRoute(row: Entity, route: string): string | null {
        let current: unknown = row;
        for (const step of route.split(".")) {
            if (current == null)
                return null;
            current = (current as Record<string, unknown>)[step];
        }
        return typeof current === "string" ? current : null;
    }

    /** Signum's `TranslationsForType` — the stored translations of one type, for one culture (or all). */
    export async function translationsForType(type: Function, culture: string): Promise<Map<InstanceKey, TranslatedInstanceEntity>> {
        const all = await localizationCache.value();
        const forCulture = all.get(culture);
        if (forCulture == undefined)
            return new Map();

        const typeLite = typeEntityOf(type);
        const result = new Map<InstanceKey, TranslatedInstanceEntity>();
        for (const [key, ti] of forCulture)
            if (String(ti.rootType.id) === String(typeLite.id))
                result.set(key, ti);
        return result;
    }

    /** Every culture's translations of one type (Signum's `TranslationsForType(type, null)`). */
    export async function allTranslationsForType(type: Function): Promise<Map<string, Map<InstanceKey, TranslatedInstanceEntity>>> {
        const result = new Map<string, Map<InstanceKey, TranslatedInstanceEntity>>();
        for (const culture of currentCultures())
            result.set(culture, await translationsForType(type, culture));
        return result;
    }

    // ---- The sync diff -------------------------------------------------------------------------------

    export interface RouteConflict {
        oldOriginal?: string;
        oldTranslation?: string;
        original: string;
        automaticTranslations: AutomaticTranslation[];
    }

    export interface InstanceChanges {
        instance: Lite<Entity>;
        /** route → culture → what that culture has for it. */
        routeConflicts: Map<string, Map<string, RouteConflict>>;
    }

    /**
     * Signum's `GetInstanceChanges` — per instance, the routes whose CURRENT text has no matching
     * translation in `targetCulture`, with what every other culture has for them as source material.
     */
    export async function getInstanceChanges(
        type: Function, targetCulture: string, cultures: string[], applyFilter = true,
    ): Promise<InstanceChanges[]> {

        const support = await allTranslationsForType(type);
        const target = support.get(targetCulture);
        const master = await masterValues(type, applyFilter);
        const def = defaultCulture();

        const byInstance = new Map<string, { lite: Lite<Entity>; values: MasterValue[] }>();
        for (const v of master) {
            const k = v.lite.key();
            (byInstance.get(k) ?? byInstance.set(k, { lite: v.lite, values: [] }).get(k)!).values.push(v);
        }

        const result: InstanceChanges[] = [];
        for (const { lite, values } of byInstance.values()) {
            const routeConflicts = new Map<string, Map<string, RouteConflict>>();

            for (const v of values) {
                if (v.text == null || v.text === "")
                    continue;
                const key = instanceKey(lite, v.route);
                const t = target?.get(key);
                if (t != undefined && normalize(t.originalText) === normalize(v.text))
                    continue; // already translated FROM this exact text

                const byCulture = new Map<string, RouteConflict>();
                for (const c of cultures) {
                    // The DEFAULT culture's "original" is the row's own value; another culture's is its
                    // stored translation, but only when it was made from the same original.
                    const str = c === def ? v.text
                        : (() => {
                            const s = support.get(c)?.get(key);
                            return s != undefined && normalize(s.originalText) === normalize(v.text!) ? s.translatedText : undefined;
                        })();
                    if (str == undefined || str === "")
                        continue;
                    byCulture.set(c, {
                        original: str,
                        // A STALE translation in the target culture is worth showing: the old original and
                        // the old text are what the sync page diffs.
                        oldOriginal: c === def ? t?.originalText : undefined,
                        oldTranslation: c === def ? t?.translatedText : undefined,
                        automaticTranslations: [],
                    });
                }
                if (byCulture.size > 0)
                    routeConflicts.set(v.route, byCulture);
            }

            if (routeConflicts.size > 0)
                result.push({ instance: lite, routeConflicts });
        }

        // Signum orders the instances that have a STALE translation first — those are the ones a reviewer
        // most wants to see.
        return result.sort((a, b) => Number(hasOld(b)) - Number(hasOld(a)));
    }

    function hasOld(ic: InstanceChanges): boolean {
        for (const byCulture of ic.routeConflicts.values())
            for (const rc of byCulture.values())
                if (rc.oldOriginal != undefined)
                    return true;
        return false;
    }

    /** Signum's `MaxTotalSyncCharacters` for the instance half. */
    export let maxTotalSyncCharacters = 4000;

    /**
     * Signum's `TranslatedInstanceSynchronizer.GetTypeInstanceChangesTranslated` — the sync diff, chunked
     * and with the automatic suggestions filled in.
     */
    export async function getTypeInstanceChangesTranslated(
        translators: ITranslator[], type: Function, targetCulture: string, applyFilter = true,
    ): Promise<{ instances: InstanceChanges[]; totalInstances: number }> {

        const cultures = currentCultures().filter(c => c !== targetCulture);
        let instances = await getInstanceChanges(type, targetCulture, cultures, applyFilter);
        const totalInstances = instances.length;

        let used = 0;
        const chunk: InstanceChanges[] = [];
        for (const ic of instances) {
            const length = totalOriginalLength(ic);
            if (chunk.length > 0 && used + length > maxTotalSyncCharacters)
                break;
            chunk.push(ic);
            used += length;
        }
        instances = chunk;

        // Signum's TranslateInstances: one batch per SOURCE culture, through every translator.
        const groups = new Map<string, RouteConflict[]>();
        for (const ic of instances)
            for (const byCulture of ic.routeConflicts.values())
                for (const [culture, rc] of byCulture)
                    (groups.get(culture) ?? groups.set(culture, []).get(culture)!).push(rc);

        for (const [culture, group] of groups) {
            const originals = group.map(a => a.original);
            for (const tr of translators) {
                const translations = await tr.translateBatch(originals, culture, targetCulture);
                if (translations == null)
                    continue;
                group.forEach((rc, i) => {
                    const text = translations[i];
                    if (text != null)
                        rc.automaticTranslations.push({ text, translatorName: tr.name });
                });
            }
        }

        return { instances, totalInstances };
    }

    function totalOriginalLength(ic: InstanceChanges): number {
        const def = defaultCulture();
        let total = 0;
        for (const byCulture of ic.routeConflicts.values())
            total += byCulture.get(def)?.original.length ?? 0;
        return total;
    }

    // ---- Saving ---------------------------------------------------------------------------------------

    export interface TranslationRecord {
        culture: string;
        instance: Lite<Entity>;
        route: string;
        originalText: string;
        translatedText: string;
    }

    /**
     * Signum's `SaveRecordsByInstance` — reconcile what the page posted against what the database has for
     * this type: insert the new, update the changed, delete the ones whose translation was cleared.
     *
     * `isSync` is Signum's flag for "these came from the sync page": a record with no translated text is
     * simply nothing to save (the user skipped it), where on the VIEW page it means "clear it".
     */
    export async function saveRecordsByInstance(
        records: TranslationRecord[], type: Function, isSync: boolean, culture: string | undefined,
    ): Promise<void> {

        const should = new Map<string, TranslationRecord>();
        for (const r of records) {
            if (isSync && (r.translatedText ?? "") === "")
                continue;
            should.set(`${r.culture}|${instanceKey(r.instance, r.route)}`, r);
        }

        const current = new Map<string, TranslatedInstanceEntity>();
        for (const [c, byKey] of await allTranslationsForType(type)) {
            if (culture != undefined && c !== culture)
                continue;
            for (const [key, ti] of byKey)
                current.set(`${c}|${key}`, ti);
        }

        await Transaction.create(async () => {
            const typeLite = typeEntityOf(type);

            for (const [key, n] of should) {
                const existing = current.get(key);
                if (existing == undefined) {
                    if ((n.translatedText ?? "") === "")
                        continue;
                    await TranslatedInstanceEntity.create({
                        culture: CultureInfoLogic.getCulture(n.culture),
                        instance: n.instance,
                        rootType: typeLite.toLite(),
                        propertyRoute: n.route,
                        originalText: n.originalText,
                        translatedText: n.translatedText,
                    }).save();
                } else if ((n.translatedText ?? "") === "") {
                    await existing.delete();
                } else if (existing.translatedText !== n.translatedText || existing.originalText !== n.originalText) {
                    existing.originalText = n.originalText;
                    existing.translatedText = n.translatedText;
                    await existing.save();
                }
            }
        });

        localizationCache.reset();
        await warmUp();
    }

    /**
     * Signum's `SaveRecordsByOriginalText` — the "different database" import mode: match by (route,
     * original text) instead of by instance id, so a file exported from another environment still lands.
     */
    export async function saveRecordsByOriginalText(
        records: TranslationRecord[], type: Function, isSync: boolean, culture: string | undefined,
    ): Promise<void> {

        // (route, originalText) → culture → translated
        const byText = new Map<string, Map<string, string>>();
        const conflicts = new Map<string, Set<string>>();
        for (const r of records) {
            if (isSync && (r.translatedText ?? "") === "")
                continue;
            const k = `${r.route}|${r.originalText}`;
            const byCulture = byText.get(k) ?? byText.set(k, new Map()).get(k)!;
            const existing = byCulture.get(r.culture);
            if (existing != undefined && existing !== r.translatedText)
                (conflicts.get(r.originalText) ?? conflicts.set(r.originalText, new Set([existing])).get(r.originalText)!).add(r.translatedText);
            byCulture.set(r.culture, r.translatedText);
        }

        if (conflicts.size > 0)
            throw new Error("There are more than one translations for:\n"
                + [...conflicts].map(([text, set]) => ` * ${text}: ${[...set].join(", ")}`).join("\n"));

        // The rows that currently HAVE each (route, originalText).
        const expanded: TranslationRecord[] = [];
        for (const v of await masterValues(type)) {
            if (v.text == null || v.text === "")
                continue;
            const byCulture = byText.get(`${v.route}|${v.text}`);
            if (byCulture == undefined)
                continue;
            for (const [c, translatedText] of byCulture)
                if (culture == undefined || culture === c)
                    expanded.push({ culture: c, instance: v.lite, route: v.route, originalText: v.text, translatedText });
        }

        await saveRecordsByInstance(expanded, type, isSync, culture);
    }

    /**
     * Signum's `CleanTranslations` — drop translations whose route no longer exists, or whose row is gone.
     * Returns how many were deleted (the sync page reports it).
     */
    export async function cleanTranslations(type: Function): Promise<number> {
        const validRoutes = [...PropertyRouteTranslationLogic.routesOf(type).keys()];
        const typeLite = typeEntityOf(type);
        const liveKeys = new Set((await masterValues(type)).map(v => instanceKey(v.lite, v.route)));

        const stale = (await table(TranslatedInstanceEntity).filter(a => a.rootType.is(typeLite)).toArray())
            .filter(ti => !validRoutes.includes(ti.propertyRoute)
                || !liveKeys.has(instanceKey(ti.instance, ti.propertyRoute)));

        if (stale.length === 0)
            return 0;

        await Transaction.create(async () => {
            for (const ti of stale)
                await ti.delete();
        });

        localizationCache.reset();
        await warmUp();
        return stale.length;
    }

    // ---- Excel -----------------------------------------------------------------------------------------

    const EXCEL_HEADERS = ["Instance", "Path", "Original", "Translated"];

    export interface FileContent { fileName: string; bytes: Uint8Array }

    /** Signum's `ExportExcelFile` — the translations that EXIST, for review. */
    export async function exportExcelFile(type: Function, culture: string, applyFilter = true): Promise<FileContent> {
        const master = await fromEntities(type, applyFilter);
        const translations = await translationsForType(type, culture);

        const rows = [...translations.entries()]
            .filter(([key]) => master.has(key))
            .map(([, ti]) => [ti.instance.key(), ti.propertyRoute, ti.originalText, ti.translatedText])
            .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

        return {
            fileName: `${cleanTypeName(type)}.${culture}.View.xlsx`,
            bytes: PlainExcelGenerator.writeStringTable(`${cleanTypeName(type)} — ${culture}`, EXCEL_HEADERS, rows),
        };
    }

    /** Signum's `ExportExcelFileSync` — what is still MISSING, for a translator to fill in. */
    export async function exportExcelFileSync(type: Function, culture: string, applyFilter = true): Promise<FileContent> {
        const def = defaultCulture();
        const changes = await getInstanceChanges(type, culture, [def], applyFilter);

        const rows = changes.flatMap(ic => [...ic.routeConflicts.entries()]
            .map(([route, byCulture]) => [ic.instance.key(), route, byCulture.get(def)?.original ?? "", ""]))
            .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

        return {
            fileName: `${cleanTypeName(type)}.${culture}.Sync.xlsx`,
            bytes: PlainExcelGenerator.writeStringTable(`${cleanTypeName(type)} — ${culture}`, EXCEL_HEADERS, rows),
        };
    }

    /**
     * Signum's `ImportExcelFile` — read an edited sheet back. Type and culture come from the FILE NAME
     * (`Order.es.View.xlsx`), exactly as Signum does, so the file is self-describing.
     */
    export async function importExcelFile(bytes: Uint8Array, fileName: string, mode: MatchTranslatedInstances): Promise<{ type: string; culture: string }> {
        const parts = fileName.split(".");
        if (parts.length < 3)
            throw new Error(`'${fileName}' should be named '<Type>.<culture>.View.xlsx'`);
        const typeName = parts[0];
        const culture = parts[1];

        const type = Entity.resolveType(typeName);

        const records: TranslationRecord[] = PlainExcelGenerator.readStringTable(bytes, EXCEL_HEADERS.length)
            .filter(cells => (cells[0] ?? "") !== "")
            .map(cells => ({
                culture,
                instance: Lite.parse(cells[0]!),
                route: cells[1] ?? "",
                originalText: cells[2] ?? "",
                translatedText: cells[3] ?? "",
            }));

        if (mode === MatchTranslatedInstances.ByInstanceID)
            await saveRecordsByInstance(records, type, false, culture);
        else
            await saveRecordsByOriginalText(records, type, false, culture);

        return { type: typeName, culture };
    }
}

// The TypeEntity row for an entity ctor (Signum's `type.ToTypeEntity()`). TypeLogic exposes the id→row
// direction, so this is the one hop across.
function typeEntityOf(type: Function): TypeEntity {
    const te = TypeLogic.idToEntity(TypeLogic.typeToId(type));
    if (te == undefined)
        throw new Error(`No TypeEntity row for '${type.name}'`);
    return te;
}

// Referenced only so PropertyRoute's module is loaded for the route walk above.
void PropertyRoute;
