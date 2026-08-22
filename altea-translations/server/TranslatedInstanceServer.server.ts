import "@altea/altea/server";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { PropertyRouteTranslationLogic } from "@altea/altea/server/propertyRouteTranslation";
import type { TranslatableRouteType } from "@altea/altea/data/reflection";
import { MatchTranslatedInstances, TranslatedSummaryState } from "../data/Translation";
import { TranslatedInstanceLogic } from "./TranslatedInstanceLogic.server";
import { TranslationLogic } from "./TranslationLogic.server";
import type { AutomaticTranslation } from "./TranslationSynchronizer.server";

// Port of Signum.Translation's Instances/TranslatedInstanceController.cs — the INSTANCE half's HTTP
// surface: the status grid, the per-type view and sync pages, the save, and the excel round-trip.
//
// altea divergences (all consequences of the no-rowId model — see TranslatedInstanceLogic's header):
//  - the composite key a page addresses a cell by is the plain ROUTE, not Signum's `"route;rowId"`; the
//    client's `tryBefore(";")` splitting goes with it.
//  - Signum's `GetTranslationRecords` has to re-parse each rowId against the MList table's primary-key
//    type; here a posted record is already (lite, route).
export namespace TranslatedInstanceServer {

    export interface TranslationRecordTS {
        culture: string;
        propertyRoute: string;
        lite: Lite<Entity>;
        originalText: string;
        translatedText: string;
    }

    export interface TranslatedPairViewTS {
        originalText: string;
        newText: string | null;
        translatedText: string;
    }

    export interface TranslatedInstanceViewTS {
        lite: Lite<Entity>;
        /** route → the row's CURRENT text. */
        master: Record<string, string | null>;
        /** route → culture → what is stored for it. */
        translations: Record<string, Record<string, TranslatedPairViewTS>>;
    }

    export interface TranslatedInstanceViewTypeTS {
        typeName: string;
        masterCulture: string;
        routes: Record<string, TranslatableRouteType>;
        instances: TranslatedInstanceViewTS[];
    }

    export interface PropertyRouteConflictTS {
        oldOriginal?: string;
        oldTranslation?: string;
        original: string;
        automaticTranslations: AutomaticTranslation[];
    }

    export interface PropertyChangeTS {
        translatedText?: string;
        support: Record<string, PropertyRouteConflictTS>;
    }

    export interface InstanceChangesTS {
        instance: Lite<Entity>;
        routeConflicts: Record<string, PropertyChangeTS>;
    }

    export interface TypeInstancesChangesTS {
        typeName: string;
        masterCulture: string;
        routes: Record<string, TranslatableRouteType>;
        totalInstances: number;
        instances: InstanceChangesTS[];
        deletedTranslations: number;
    }

    export interface FileUpload {
        fileName: string;
        /** base64, as the browser's FileReader produces it. */
        content: string;
    }

    export function start(ws: WebBuilder): void {

        ws.get("/api/translatedInstance",
            { res: CustomType<TranslatedInstanceLogic.TranslatedTypeSummary[]>() },
            async (req, res) => {
                const applyFilter = req.query["applyFilter"] !== "false";
                res.jsonTyped(await TranslatedInstanceLogic.translationInstancesStatus(applyFilter));
            });

        ws.get("/api/translatedInstance/view/:type",
            { params: CustomType<{ type: string }>(), res: CustomType<TranslatedInstanceViewTypeTS>() },
            async (req, res) => {
                const { type: typeName } = (req as unknown as { params: { type: string } }).params;
                const culture = optional(req.query["culture"]);
                const filter = String(req.query["filter"] ?? "");
                const applyFilter = req.query["applyFilter"] !== "false";
                res.jsonTyped(await view(typeName, culture, filter, applyFilter));
            });

        ws.get("/api/translatedInstance/sync/:type",
            { params: CustomType<{ type: string }>(), res: CustomType<TypeInstancesChangesTS>() },
            async (req, res) => {
                const { type: typeName } = (req as unknown as { params: { type: string } }).params;
                const culture = String(req.query["culture"] ?? "");
                const applyFilter = req.query["applyFilter"] !== "false";
                res.jsonTyped(await sync(typeName, culture, applyFilter));
            });

        ws.post("/api/translatedInstance/save/:type",
            { params: CustomType<{ type: string }>(), req: CustomType<TranslationRecordTS[]>() },
            async (req, res) => {
                const { type: typeName } = (req as unknown as { params: { type: string } }).params;
                const isSync = req.query["isSync"] === "true";
                const culture = optional(req.query["culture"]);
                const records = await req.jsonTyped();

                await TranslatedInstanceLogic.saveRecordsByInstance(
                    records.map(r => ({
                        culture: r.culture, instance: r.lite, route: r.propertyRoute,
                        originalText: r.originalText, translatedText: r.translatedText,
                    })),
                    Entity.resolveType(typeName), isSync, culture);

                res.json({ ok: true });
            });

        ws.get("/api/translatedInstance/autoTranslate/:type",
            { params: CustomType<{ type: string }>() },
            async (req, res) => {
                const { type: typeName } = (req as unknown as { params: { type: string } }).params;
                await autoTranslate(typeName, String(req.query["culture"] ?? ""));
                res.json({ ok: true });
            });

        ws.get("/api/translatedInstance/autoTranslateAll",
            {},
            async (req, res) => {
                const culture = String(req.query["culture"] ?? "");
                for (const s of await TranslatedInstanceLogic.translationInstancesStatus())
                    if (s.culture === culture && !s.isDefaultCulture && s.state != null && s.state !== TranslatedSummaryState.Completed)
                        await autoTranslate(s.type, culture);
                res.json({ ok: true });
            });

        // ---- Excel -------------------------------------------------------------------------------------

        ws.get("/api/translatedInstance/viewFile/:type",
            { params: CustomType<{ type: string }>() },
            async (req, res) => {
                const { type: typeName } = (req as unknown as { params: { type: string } }).params;
                const file = await TranslatedInstanceLogic.exportExcelFile(
                    Entity.resolveType(typeName), String(req.query["culture"] ?? ""), req.query["applyFilter"] !== "false");
                sendExcel(res, file);
            });

        ws.get("/api/translatedInstance/syncFile/:type",
            { params: CustomType<{ type: string }>() },
            async (req, res) => {
                const { type: typeName } = (req as unknown as { params: { type: string } }).params;
                const file = await TranslatedInstanceLogic.exportExcelFileSync(
                    Entity.resolveType(typeName), String(req.query["culture"] ?? ""), req.query["applyFilter"] !== "false");
                sendExcel(res, file);
            });

        ws.post("/api/translatedInstance/uploadFile",
            { req: CustomType<FileUpload>() },
            async (req, res) => {
                const upload = await req.jsonTyped();
                const mode = String(req.query["mode"] ?? "ByInstanceID") === "ByOriginalText"
                    ? MatchTranslatedInstances.ByOriginalText : MatchTranslatedInstances.ByInstanceID;
                await TranslatedInstanceLogic.importExcelFile(
                    new Uint8Array(Buffer.from(upload.content, "base64")), upload.fileName, mode);
                res.json({ ok: true });
            });
    }

    // ---- implementations --------------------------------------------------------------------------------

    /** Signum's `View` — every instance's current text side by side with what each culture has for it. */
    async function view(typeName: string, culture: string | undefined, filter: string, applyFilter: boolean): Promise<TranslatedInstanceViewTypeTS> {
        const type = Entity.resolveType(typeName);
        const master = await TranslatedInstanceLogic.masterValues(type, applyFilter);
        const support = culture == undefined
            ? await TranslatedInstanceLogic.allTranslationsForType(type)
            : new Map([[culture, await TranslatedInstanceLogic.translationsForType(type, culture)]]);

        const f = filter.toLowerCase();
        const matches = (lite: Lite<Entity>, route: string, text: string | null): boolean => {
            if (f === "")
                return true;
            if (String(lite.id) === filter || lite.key() === filter)
                return true;
            if (lite.toString().toLowerCase().includes(f) || route.toLowerCase().includes(f))
                return true;
            if (text != null && text.toLowerCase().includes(f))
                return true;
            const key = TranslatedInstanceLogic.instanceKey(lite, route);
            for (const byKey of support.values())
                if (byKey.get(key)?.translatedText.toLowerCase().includes(f))
                    return true;
            return false;
        };

        const byInstance = new Map<string, TranslatedInstanceViewTS>();
        for (const v of master) {
            if (!matches(v.lite, v.route, v.text))
                continue;

            const key = v.lite.key();
            const entry = byInstance.get(key)
                ?? byInstance.set(key, { lite: v.lite, master: {}, translations: {} }).get(key)!;
            entry.master[v.route] = v.text;

            const instKey = TranslatedInstanceLogic.instanceKey(v.lite, v.route);
            for (const [c, byKey] of support) {
                const ti = byKey.get(instKey);
                if (ti == undefined)
                    continue;
                (entry.translations[v.route] ??= {})[c] = {
                    originalText: ti.originalText,
                    newText: v.text,
                    translatedText: ti.translatedText,
                };
            }
        }

        return {
            typeName,
            masterCulture: TranslatedInstanceLogic.defaultCulture(),
            routes: routesOf(type),
            instances: [...byInstance.values()],
        };
    }

    /** Signum's `Sync` — cleans first (Signum does too), then the diff with the machine suggestions. */
    async function sync(typeName: string, culture: string, applyFilter: boolean): Promise<TypeInstancesChangesTS> {
        const type = Entity.resolveType(typeName);
        const deletedTranslations = await TranslatedInstanceLogic.cleanTranslations(type);

        const { instances, totalInstances } = await TranslatedInstanceLogic.getTypeInstanceChangesTranslated(
            TranslationLogic.translators, type, culture, applyFilter);

        return {
            typeName,
            masterCulture: TranslatedInstanceLogic.defaultCulture(),
            routes: routesOf(type),
            totalInstances,
            deletedTranslations,
            instances: instances.map(ic => ({
                instance: ic.instance,
                routeConflicts: Object.fromEntries([...ic.routeConflicts.entries()].map(([route, byCulture]) =>
                    [route, {
                        support: Object.fromEntries([...byCulture.entries()].map(([c, rc]) => [c, {
                            original: rc.original,
                            oldOriginal: rc.oldOriginal,
                            oldTranslation: rc.oldTranslation,
                            automaticTranslations: rc.automaticTranslations,
                        } satisfies PropertyRouteConflictTS])),
                    } satisfies PropertyChangeTS])),
            })),
        };
    }

    /** Signum's `AutoTranslate` — accept the first suggestion for every conflict, until none is left. */
    async function autoTranslate(typeName: string, culture: string): Promise<void> {
        const type = Entity.resolveType(typeName);
        const masterCulture = TranslatedInstanceLogic.defaultCulture();

        for (; ;) {
            const { instances } = await TranslatedInstanceLogic.getTypeInstanceChangesTranslated(
                TranslationLogic.translators, type, culture, true);
            if (instances.length === 0)
                return;

            const records: TranslatedInstanceLogic.TranslationRecord[] = [];
            for (const ic of instances)
                for (const [route, byCulture] of ic.routeConflicts) {
                    const master = byCulture.get(masterCulture);
                    const first = [...byCulture.values()].flatMap(a => a.automaticTranslations)[0];
                    if (master == undefined || first == undefined)
                        continue;
                    records.push({
                        culture, instance: ic.instance, route,
                        originalText: master.original, translatedText: first.text,
                    });
                }

            // Nothing a translator could suggest: stop rather than spin (Signum's loop would not).
            if (records.length === 0)
                return;

            await TranslatedInstanceLogic.saveRecordsByInstance(records, type, true, culture);
        }
    }

    function routesOf(type: Function): Record<string, TranslatableRouteType> {
        return Object.fromEntries(PropertyRouteTranslationLogic.routesOf(type));
    }

    function optional(value: unknown): string | undefined {
        return value == undefined || value === "" ? undefined : String(value);
    }

    function sendExcel(res: { setHeader(n: string, v: string): void; type(t: string): { send(b: unknown): void } },
        file: TranslatedInstanceLogic.FileContent): void {
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.fileName)}"`);
        res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(Buffer.from(file.bytes));
    }
}
