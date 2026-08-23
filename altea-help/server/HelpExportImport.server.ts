import "@altea/altea/server";
import { unzipSync, zipSync } from "fflate";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { table } from "@altea/altea/server/table";
import { Saver } from "@altea/altea/server/saver";
import * as Database from "@altea/altea/server/Database";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { QueryLogic } from "@altea/altea/server/dynamicQuery/queryLogic";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { CultureInfoLogic } from "@altea/altea/server/cultureInfoLogic";
import { FilePathEmbeddedLogic } from "@altea/altea-files/server/FilePathEmbeddedLogic.server";
import { FilePathEmbedded } from "@altea/altea-files/data/Files";
import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { cleanTypeName } from "@altea/altea/data/registration";
import type { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import {
    AppendixHelpEntity, NamespaceHelpEntity, QueryHelpEntity, QueryHelpEntity_Column,
    TypeHelpEntity, TypeHelpEntity_Operation, TypeHelpEntity_Property,
    HelpImportPreviewModel, HelpImportPreviewLineEmbedded,
    HelpImportReportModel, HelpImportReportLineEmbedded,
    HelpImageEntity, HelpImageFileType,
    type IHelpEntity, type ImportAction, type ImportStatus,
} from "../data/Help";
import { HelpLogic } from "./HelpLogic.server";
import { InlineImagesLogic } from "./InlineImagesLogic.server";

// Port of Signum.Help's HelpExportImport.cs — move help CONTENT between databases as a zip of small XML
// files, with a two-phase web flow: upload → preview (what would change) → apply the lines you ticked.
//
// The zip layout is Signum's exactly, so a zip produced by either framework is readable by the other:
//
//   Help/<culture>/<TypeFolder>/<key>.help            the XML
//   Help/<culture>/<TypeFolder>/<key>/<imageFile>     that entry's images
//
// where `<TypeFolder>` is the help type's clean name minus the "Help" suffix (`Appendix`, `Namespace`,
// `Type`, `Query`) and `<key>` is the entry's own identity (the appendix's uniqueName, the namespace's
// name, the type's clean name, the query's key).
//
// altea divergences:
//  - **ONE kind-descriptor table instead of four near-identical static classes.** Signum repeats
//    `ToXDocument` / `ToHelpContent` / `ParseXML` / `Import` per help type (~250 lines each); they differ
//    only in the element name, the key, and which child elements they carry — so this port states those
//    differences in a `HelpKind` record and runs one engine over it. Same XML, same behaviour.
//  - **the INTERACTIVE console mode is not ported.** Signum has three modes (Preview / ApplyPreview /
//    Interactive) — the third prompts on the terminal through `SafeConsole` and `Synchronizer`
//    replacements. The web preview does the same job with a better UI, and it is what the app actually
//    uses; the terminal entry points (`ImportAll`, the `iz` command) go with it.
//  - **XSD validation is dropped** (`SignumFrameworkHelp.xsd` + `LoadAndValidate`). It only ran on the
//    unported disk-loading path, and a mis-shaped file already fails the same way here: the kind is
//    unknown, or a required attribute is missing.
//  - `System.IO.Compression` → **fflate** (already the workspace's zip, via altea-office-template) and
//    `XDocument` → **fast-xml-parser** (already the workspace's XML, via altea-user-assets / altea-auth).
//  - the import runs in ONE transaction per applied line, so a failing line reports its error and leaves
//    the rest intact — Signum's per-line try/catch, made durable.
export namespace HelpExportImport {

    const ROOT = "Help";
    const ATTR = "@_";
    const TEXT = "#text";

    const builder = new XMLBuilder({
        attributeNamePrefix: ATTR,
        ignoreAttributes: false,
        format: true,
        suppressEmptyNode: true,
        textNodeName: TEXT,
    });

    const parser = new XMLParser({
        attributeNamePrefix: "",
        ignoreAttributes: false,
        parseAttributeValue: false,
        parseTagValue: false,
        trimValues: false,
        textNodeName: TEXT,
    });

    // ---- the four kinds ---------------------------------------------------------------------------

    /** One `.help` file, in flight (Signum's `HelpContent`). */
    interface HelpContent {
        kind: HelpKind;
        key: string;
        cultureName: string;
        xml: string;
        images: { fileName: string; bytes: Uint8Array }[];
        existing?: Lite<Entity>;
        action?: ImportAction;
        apply: boolean;
        status: ImportStatus;
        importError?: string;
    }

    interface HelpKind {
        /** The XML root element name (Signum's `_Appendix` / `_Namespace` / `_Query` / `_Entity`). */
        element: string;
        /** The folder segment inside the zip — the clean name minus "Help". */
        folder: string;
        type: Type<Entity>;
        /** The entry's identity, from an entity. */
        keyOf(entity: IHelpEntity): string;
        /** The entry's identity, from the parsed XML root. */
        keyOfXml(root: Record<string, unknown>): string;
        write(entity: IHelpEntity): Record<string, unknown>;
        /** The stored row with this key + culture, or undefined. */
        find(key: string, culture: CultureInfoEntity): Promise<IHelpEntity | undefined>;
        /** A fresh row carrying the key + culture (used when the import CREATES). */
        create(key: string, culture: CultureInfoEntity): IHelpEntity | undefined;
        /** Read the XML into the (existing or fresh) row. Returns false when the file names something gone. */
        read(entity: IHelpEntity, root: Record<string, unknown>): Promise<boolean>;
    }

    const kinds: HelpKind[] = [
        {
            element: "Appendix",
            folder: "Appendix",
            type: AppendixHelpEntity,
            keyOf: e => (e as AppendixHelpEntity).uniqueName,
            keyOfXml: root => String(root["Name"] ?? ""),
            write: e => {
                const a = e as AppendixHelpEntity;
                return {
                    [ATTR + "Name"]: a.uniqueName,
                    [ATTR + "Culture"]: a.culture.name,
                    [ATTR + "Title"]: a.title,
                    ...(a.description ? { Description: a.description } : {}),
                };
            },
            find: async (key, culture) =>
                await table(AppendixHelpEntity).filter(a => a.uniqueName == key && a.culture.is(culture)).firstOrNull() ?? undefined,
            create: (key, culture) => AppendixHelpEntity.create({ uniqueName: key, culture, title: key }),
            read: async (entity, root) => {
                const a = entity as AppendixHelpEntity;
                a.title = String(root["Title"] ?? a.title ?? a.uniqueName);
                a.description = textOf(root["Description"]);
                return true;
            },
        },
        {
            element: "Namespace",
            folder: "Namespace",
            type: NamespaceHelpEntity,
            keyOf: e => (e as NamespaceHelpEntity).name,
            keyOfXml: root => String(root["Name"] ?? ""),
            write: e => {
                const n = e as NamespaceHelpEntity;
                return {
                    [ATTR + "Name"]: n.name,
                    [ATTR + "Culture"]: n.culture.name,
                    ...(n.title ? { [ATTR + "Title"]: n.title } : {}),
                    ...(n.description ? { Description: n.description } : {}),
                };
            },
            find: async (key, culture) =>
                await table(NamespaceHelpEntity).filter(n => n.name == key && n.culture.is(culture)).firstOrNull() ?? undefined,
            create: (key, culture) => NamespaceHelpEntity.create({ name: key, culture }),
            read: async (entity, root) => {
                const n = entity as NamespaceHelpEntity;
                n.title = root["Title"] == undefined ? n.title : String(root["Title"]);
                n.description = textOf(root["Description"]);
                return true;
            },
        },
        {
            element: "Entity",
            folder: "Type",
            type: TypeHelpEntity,
            keyOf: e => (e as TypeHelpEntity).type.cleanName,
            keyOfXml: root => String(root["CleanName"] ?? ""),
            write: e => {
                const t = e as TypeHelpEntity;
                const props = t.properties.filter(p => p.description);
                const opers = t.operations.filter(o => o.description);
                return {
                    [ATTR + "CleanName"]: t.type.cleanName,
                    [ATTR + "Culture"]: t.culture.name,
                    ...(t.description ? { Description: t.description } : {}),
                    ...(props.length === 0 ? {} : {
                        Properties: {
                            Property: props.map(p => ({ [ATTR + "Name"]: p.propertyRoute, [TEXT]: p.description })),
                        },
                    }),
                    ...(opers.length === 0 ? {} : {
                        Operations: {
                            Operation: opers.map(o => ({ [ATTR + "Key"]: o.operation.key, [TEXT]: o.description })),
                        },
                    }),
                };
            },
            find: async (key, culture) => {
                return await table(TypeHelpEntity)
                    .filter(t => t.type.cleanName == key && t.culture.is(culture)).firstOrNull() ?? undefined;
            },
            create: (key, culture) => {
                const ctor = resolveHelpedType(key);
                if (ctor == undefined)
                    return undefined; // the type no longer exists in this application
                return TypeHelpEntity.create({ type: ctor.toTypeEntity(), culture });
            },
            read: async (entity, root) => {
                const t = entity as TypeHelpEntity;
                const ctor = resolveHelpedType(t.type.cleanName);
                if (ctor == undefined)
                    return false;

                t.description = textOf(root["Description"]);

                // Only routes that STILL exist are kept — Signum's `properties.TryGetC(name)` filter, which
                // is also what keeps a renamed property from resurrecting as a stray row.
                const validRoutes = new Set(HelpLogic.publicRoutes(ctor).map(pr => pr.propertyString()));
                const byRoute = new Map(t.properties.map(p => [p.propertyRoute, p]));
                for (const item of arrayOf(root, "Properties", "Property")) {
                    const name = String(item["Name"] ?? "");
                    if (!validRoutes.has(name))
                        continue;
                    const existing = byRoute.get(name);
                    if (existing != undefined)
                        existing.description = textOf(item[TEXT]);
                    else
                        t.properties.push(TypeHelpEntity_Property.create({
                            typeHelp: t, propertyRoute: name, description: textOf(item[TEXT]),
                        }));
                }

                const symbolsByKey = new Map(OperationLogic.operationsForType(ctor).map(s => [s.key, s]));
                const byOperation = new Map(t.operations.map(o => [o.operation.key, o]));
                for (const item of arrayOf(root, "Operations", "Operation")) {
                    const key = String(item["Key"] ?? "");
                    const symbol = symbolsByKey.get(key);
                    if (symbol == undefined)
                        continue;
                    const existing = byOperation.get(key);
                    if (existing != undefined)
                        existing.description = textOf(item[TEXT]);
                    else
                        t.operations.push(TypeHelpEntity_Operation.create({
                            typeHelp: t, operation: symbol, description: textOf(item[TEXT]),
                        }));
                }

                return true;
            },
        },
        {
            element: "Query",
            folder: "Query",
            type: QueryHelpEntity,
            keyOf: e => (e as QueryHelpEntity).query.key,
            keyOfXml: root => String(root["Key"] ?? ""),
            write: e => {
                const q = e as QueryHelpEntity;
                const cols = q.columns.filter(c => c.description);
                return {
                    [ATTR + "Key"]: q.query.key,
                    [ATTR + "Culture"]: q.culture.name,
                    ...(q.description ? { Description: q.description } : {}),
                    ...(cols.length === 0 ? {} : {
                        Columns: {
                            Column: cols.map(c => ({ [ATTR + "Name"]: c.columnName, [TEXT]: c.description })),
                        },
                    }),
                };
            },
            find: async (key, culture) =>
                await table(QueryHelpEntity).filter(q => q.query.key == key && q.culture.is(culture)).firstOrNull() ?? undefined,
            create: (key, culture) => {
                const queryName = QueryLogic.tryGetQueryNameByKey(key);
                if (queryName == undefined)
                    return undefined;
                return QueryHelpEntity.create({ query: QueryLogic.getQueryEntity(queryName), culture });
            },
            read: async (entity, root) => {
                const q = entity as QueryHelpEntity;
                const queryName = QueryLogic.tryGetQueryNameByKey(q.query.key);
                if (queryName == undefined)
                    return false;

                q.description = textOf(root["Description"]);

                const validTokens = new Set(HelpLogic.queryColumnTokens(queryName).map(t => t.fullKey()));
                const byColumn = new Map(q.columns.map(c => [c.columnName, c]));
                for (const item of arrayOf(root, "Columns", "Column")) {
                    const name = String(item["Name"] ?? "");
                    if (!validTokens.has(name))
                        continue;
                    const existing = byColumn.get(name);
                    if (existing != undefined)
                        existing.description = textOf(item[TEXT]);
                    else
                        q.columns.push(QueryHelpEntity_Column.create({
                            queryHelp: q, columnName: name, description: textOf(item[TEXT]),
                        }));
                }

                return true;
            },
        },
    ];

    function kindOf(entity: IHelpEntity): HelpKind {
        const kind = kinds.find(k => entity instanceof k.type);
        if (kind == undefined)
            throw new Error(`'${entity.constructor.name}' is not a help entity`);
        return kind;
    }

    function kindByFolder(folder: string): HelpKind | undefined {
        return kinds.find(k => k.folder.toLowerCase() === folder.toLowerCase());
    }

    function resolveHelpedType(cleanName: string): Type<Entity> | undefined {
        return HelpLogic.allTypes().find(t => cleanTypeName(t) === cleanName);
    }

    // ---- export ------------------------------------------------------------------------------------

    /** Signum's `ExportToZipBytes` — the picked help entities (plus their images) as a zip. */
    export async function exportToZip(entities: IHelpEntity[]): Promise<Uint8Array> {
        const files: Record<string, Uint8Array> = {};
        const encoder = new TextEncoder();

        for (const entity of entities) {
            const kind = kindOf(entity);
            const key = removeInvalid(kind.keyOf(entity));
            const culture = cultureNameOf(entity);
            const folder = `${ROOT}/${culture}/${kind.folder}`;

            files[`${folder}/${key}.help`] = encoder.encode(toXml(kind, entity));

            for (const image of await imagesOf(entity))
                files[`${folder}/${key}/${image.fileName}`] = image.bytes;
        }

        return zipSync(files, { level: 6 });
    }

    function toXml(kind: HelpKind, entity: IHelpEntity): string {
        return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n`
            + builder.build({ [kind.element]: kind.write(entity) });
    }

    /** Signum's `GetImageContents` — `<id>.<fileName>` per image, so the id survives the round trip. */
    async function imagesOf(entity: IHelpEntity): Promise<{ fileName: string; bytes: Uint8Array }[]> {
        const images = await InlineImagesLogic.imagesOf(entity);
        const result: { fileName: string; bytes: Uint8Array }[] = [];
        for (const image of images) {
            const bytes = await FilePathEmbeddedLogic.readAllBytes(image.file);
            if (bytes != null)
                result.push({ fileName: `${String(image.id)}.${image.file.fileName}`, bytes });
        }
        return result;
    }

    // ---- import ------------------------------------------------------------------------------------

    /** Signum's `ImportPreviewFromZip` — what WOULD change, with nothing written. */
    export async function importPreview(zipBytes: Uint8Array): Promise<HelpImportPreviewModel> {
        const contents = readZip(zipBytes);

        for (const content of contents)
            await classify(content);

        const model = HelpImportPreviewModel.create({});
        model.lines = contents.map(c => HelpImportPreviewLineEmbedded.create({
            type: c.kind.type.toTypeEntity(),
            key: c.key,
            culture: cultureRow(c.cultureName),
            text: describe(c),
            exitingEntity: c.existing ?? null,
            action: c.action ?? "NoChange",
            // Signum pre-ticks the CREATEs only: an override is a decision, a create is not.
            apply: c.action === "Create",
        }));

        return model;
    }

    /** Signum's `ImportFromZip(bytes, model)` — apply the ticked lines and report on each. */
    export async function applyImport(zipBytes: Uint8Array, decisions: HelpImportPreviewModel): Promise<HelpImportReportModel> {
        const contents = readZip(zipBytes);

        for (const content of contents) {
            await classify(content);

            const line = decisions.lines.find(l =>
                l.key === content.key
                && l.culture.name === content.cultureName
                && l.type.cleanName === cleanTypeName(content.kind.type));

            content.action = line?.action ?? content.action;
            content.apply = line?.apply === true;
        }

        for (const content of contents)
            await apply(content);

        // Rows were written outside the operations' invalidation path in the failure branches, and the
        // caches key on culture, so drop them wholesale (Signum relies on the same GlobalLazy reset).
        HelpLogic.invalidate();

        const model = HelpImportReportModel.create({});
        model.lines = contents.map(c => HelpImportReportLineEmbedded.create({
            type: c.kind.type.toTypeEntity(),
            key: c.key,
            culture: cultureRow(c.cultureName),
            text: describe(c),
            exitingEntity: c.existing ?? null,
            action: c.action ?? "NoChange",
            status: c.status,
            actionError: c.importError ?? null,
        }));

        return model;
    }

    /** Decide Create / Override / NoChange for one file, writing nothing (Signum's Preview mode). */
    async function classify(content: HelpContent): Promise<void> {
        await ExecutionMode.global(async () => {
            const culture = cultureRow(content.cultureName);
            const existing = await content.kind.find(content.key, culture);

            if (existing == undefined) {
                content.action = content.kind.create(content.key, culture) == undefined ? "NoChange" : "Create";
                return;
            }

            content.existing = existing.toLite();

            // "Would applying this change anything?" — read the XML into a FRESH copy of the row and
            // compare the produced XML. Signum asks the same question through its `modified()` callback.
            const before = toXml(content.kind, existing);
            const probe = await Database.retrieve(content.kind.type, existing.id!) as unknown as IHelpEntity;
            const ok = await content.kind.read(probe, rootOf(content));
            const after = ok ? toXml(content.kind, probe) : before;

            content.action = after === before ? "NoChange" : "Override";
        });
    }

    async function apply(content: HelpContent): Promise<void> {
        if (content.action == undefined || content.action === "NoChange") {
            content.status = "NoChange";
            return;
        }

        if (!content.apply) {
            content.status = "Skipped";
            return;
        }

        try {
            // One transaction per line: a failing entry reports its error and leaves the others applied.
            await Transaction.forceNew(() => ExecutionMode.global(async () => {
                const culture = cultureRow(content.cultureName);

                const entity = content.existing != undefined
                    ? await Database.retrieve(content.kind.type, content.existing.id!) as unknown as IHelpEntity
                    : content.kind.create(content.key, culture);

                if (entity == undefined)
                    throw new Error(`'${content.key}' does not exist in this application`);

                if (!await content.kind.read(entity, rootOf(content)))
                    throw new Error(`'${content.key}' does not exist in this application`);

                await Saver.save([entity as unknown as Entity]);

                await importImages(content, entity);
            }));

            content.status = "Applied";
        } catch (e) {
            content.status = "Failed";
            content.importError = e instanceof Error ? e.message : String(e);
        }
    }

    /**
     * Re-create the entry's images under the SAME ids the exported HTML refers to (the zip names each file
     * `<id>.<name>`). An id that already exists is left alone — the description's `data-help-image-id`
     * already resolves.
     */
    async function importImages(content: HelpContent, entity: IHelpEntity): Promise<void> {
        for (const image of content.images) {
            const dot = image.fileName.indexOf(".");
            if (dot <= 0)
                continue;

            const id = image.fileName.substring(0, dot);
            const fileName = image.fileName.substring(dot + 1);

            const exists = await table(HelpImageEntity).filter(i => String(i.id) == id).firstOrNull();
            if (exists != null)
                continue;

            const row = HelpImageEntity.create({
                target: entity.toLite(),
                file: newImageFile(fileName, image.bytes),
            });
            // The id is part of the CONTENT (the HTML points at it), so it is carried over rather than
            // generated — altea's insert path writes an explicit id when `isNew` and an id is set (the same
            // property @altea/altea-time-machine's restore relies on).
            row.id = id;
            row.isNew = true;
            await Saver.save([row]);
        }
    }

    /** A FilePathEmbedded ready to be written to the help image store (Signum's `new FilePathEmbedded(…)`). */
    function newImageFile(fileName: string, bytes: Uint8Array): FilePathEmbedded {
        const file = FilePathEmbedded.create({
            fileType: HelpImageFileType.Image,
            fileName,
            binaryFile: bytes,
        });
        file.prepareForSave();
        return file;
    }

    // ---- the zip -----------------------------------------------------------------------------------

    /** Signum's `LoadContentsFromZip` — two passes: the `.help` files, then the images beside them. */
    function readZip(zipBytes: Uint8Array): HelpContent[] {
        const entries = unzipSync(zipBytes);
        const decoder = new TextDecoder();
        const byKey = new Map<string, HelpContent>();

        for (const [path, bytes] of Object.entries(entries)) {
            if (path.endsWith("/"))
                continue;

            const parts = path.split("/");
            if (parts.length < 4 || parts[0].toLowerCase() !== ROOT.toLowerCase())
                continue;

            const fileName = parts[parts.length - 1];
            if (!fileName.toLowerCase().endsWith(".help"))
                continue;

            const kind = kindByFolder(parts[2]);
            if (kind == undefined)
                continue;

            const key = fileName.substring(0, fileName.length - ".help".length);

            byKey.set(`${parts[1]}/${kind.folder}/${key}`, {
                kind,
                key,
                cultureName: parts[1],
                xml: decoder.decode(bytes),
                images: [],
                apply: false,
                status: "NoChange",
            });
        }

        for (const [path, bytes] of Object.entries(entries)) {
            if (path.endsWith("/") || path.toLowerCase().endsWith(".help"))
                continue;

            const parts = path.split("/");
            if (parts.length !== 5 || parts[0].toLowerCase() !== ROOT.toLowerCase())
                continue;

            const kind = kindByFolder(parts[2]);
            if (kind == undefined)
                continue;

            const content = byKey.get(`${parts[1]}/${kind.folder}/${parts[3]}`);
            if (content == undefined)
                throw new Error(`The zip has images for '${parts[3]}' but no '${parts[3]}.help' beside them.`);

            content.images.push({ fileName: parts[4], bytes });
        }

        return [...byKey.values()];
    }

    // ---- helpers -----------------------------------------------------------------------------------

    function rootOf(content: HelpContent): Record<string, unknown> {
        const parsed = parser.parse(content.xml) as Record<string, unknown>;
        const root = parsed[content.kind.element];
        if (root == undefined || typeof root !== "object")
            throw new Error(`'${content.key}.help' has no <${content.kind.element}> root`);
        return root as Record<string, unknown>;
    }

    /** fast-xml-parser gives one object for a single child and an array for several. */
    function arrayOf(root: Record<string, unknown>, container: string, item: string): Record<string, unknown>[] {
        const group = root[container] as Record<string, unknown> | undefined;
        if (group == undefined)
            return [];
        const value = group[item];
        if (value == undefined)
            return [];
        return (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
    }

    function textOf(value: unknown): string | null {
        if (value == undefined)
            return null;
        if (typeof value === "object" && value != null && TEXT in value)
            return String((value as Record<string, unknown>)[TEXT] ?? "") || null;
        const text = String(value);
        return text.length === 0 ? null : text;
    }

    function cultureNameOf(entity: IHelpEntity): string {
        return (entity as unknown as { culture: CultureInfoEntity }).culture.name;
    }

    function cultureRow(name: string): CultureInfoEntity {
        const culture = CultureInfoLogic.tryGetCulture(name);
        if (culture == undefined)
            throw new Error(`The zip has content for culture '${name}', which this application does not support`);
        return culture;
    }

    function describe(content: HelpContent): string {
        return `${content.kind.folder} ${content.key} (${content.cultureName})`;
    }

    /** Signum's `RemoveInvalid` — a key becomes a FILE NAME, so path characters have to go. */
    function removeInvalid(name: string): string {
        return name.replace(/[\\/:*?"<>|]/g, "");
    }
}
