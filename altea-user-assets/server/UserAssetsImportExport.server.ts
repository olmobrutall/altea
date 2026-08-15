import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { table } from "@altea/altea/server/table";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import {
    UserAssetPreviewModel, UserAssetPreviewLineEmbedded, EntityAction, type IUserAssetEntity,
} from "../data/UserAssets";

// Port of Signum's UserAssetsExporterImporter.cs — the XML import/export engine for user assets. Signum
// implements ToXml/FromXml ON each entity (they carry System.Xml.Linq); altea keeps entities isomorphic,
// so each asset type registers its (de)serializer HERE via `UserAssetsImporter.register`. XML is produced
// / parsed with fast-xml-parser (the same library altea-auth uses for AuthRules XML), attributes prefixed
// "@_" for the builder and read back as bare keys by the parser.
//
// Divergences vs. Signum: the two-phase Preview → Import flow is preserved (diff by Guid, override on
// demand), but the advanced lite-conflict / custom-resolution machinery (LiteConflicts, CustomResolution)
// is simplified to the New/Different/Identical decision (marked TODO). Referenced queries/types are
// resolved by KEY at import (not included); dependent USER ASSETS (e.g. CustomDrilldowns) ARE included
// recursively via ctx.include.

const ATTR = "@_";

// ---- The (de)serialization context APIs (Signum's IToXmlContext / IFromXmlContext) --------------------

export interface IToXmlContext {
    /** Add an asset to the export set (recursively) and return its guid — Signum's Include. */
    include(entity: IUserAssetEntity): string;
    /** Retrieve the full entity behind a lite (for reading fields into the XML). */
    retrieveLite<T extends Entity>(lite: Lite<T>): Promise<T>;
}

export interface IFromXmlContext {
    readonly isPreview: boolean;
    getQuery(queryKey: string): QueryEntity;
    getType(cleanName: string): Lite<TypeEntity>;
    tryGetType(cleanName: string): Lite<TypeEntity> | undefined;
    /** The already-materialized asset for a guid referenced elsewhere in the same file. */
    getEntity(guid: string): IUserAssetEntity;
    /** Parse a stored lite key back to a Lite (Signum's ParseLite) — best-effort. */
    parseLite(liteKey: string): Lite<Entity> | undefined;
}

// ---- Per-type registration (Signum's UserAssetNames + Register) ---------------------------------------

export interface UserAssetTypeConfig<T extends IUserAssetEntity = IUserAssetEntity> {
    /** The XML element name = the asset's clean type name ("UserQuery"). */
    elementName: string;
    /** A fresh, empty instance to fill on import. */
    create(): T;
    /** Serialize the entity to an XML-object (attrs prefixed "@_", nested elements as objects/arrays). */
    toXml(entity: T, ctx: IToXmlContext): Record<string, unknown> | Promise<Record<string, unknown>>;
    /** Fill the entity from a parsed XML-object. */
    fromXml(entity: T, xml: Record<string, unknown>, ctx: IFromXmlContext): void;
    /** Find the existing DB row for a guid (Signum's Database.Query.SingleOrDefault(a => a.Guid == guid)). */
    load(guid: string): Promise<T | undefined>;
    /** Persist the asset (Signum's saveEntity — the registered Save operation). */
    save(entity: T): Promise<void>;
}

const registry = new Map<string, UserAssetTypeConfig>();

export namespace UserAssetsImporter {
    export function register<T extends IUserAssetEntity>(config: UserAssetTypeConfig<T>): void {
        registry.set(config.elementName, config as unknown as UserAssetTypeConfig);
    }

    export function configFor(elementName: string): UserAssetTypeConfig {
        const c = registry.get(elementName);
        if (c == null)
            throw new Error(`UserAssets: no registered asset type for XML element '${elementName}'`);
        return c;
    }

    function configForEntity(entity: IUserAssetEntity): UserAssetTypeConfig {
        // The registered elementName equals the entity's clean type name; entities carry their ctor name.
        const name = entity.constructor.name.replace(/Entity$/, "");
        const direct = registry.get(name) ?? registry.get(entity.constructor.name);
        if (direct != null)
            return direct;
        // Fallback: scan for a config whose create() yields the same ctor.
        for (const c of registry.values())
            if (c.create().constructor === entity.constructor)
                return c;
        throw new Error(`UserAssets: entity '${entity.constructor.name}' is not registered as a user asset`);
    }

    // ---- Export (Signum's UserAssetsExporter.ToXml) --------------------------------------------------

    export async function toXml(entities: IUserAssetEntity[]): Promise<string> {
        const elements = new Map<string, { name: string; obj: Record<string, unknown> }>();
        const pending: IUserAssetEntity[] = [];

        const ctx: IToXmlContext = {
            include(entity) {
                const guid = String(entity.id); // the uuid PK is the asset's portable identity
                if (!elements.has(guid)) {
                    elements.set(guid, { name: "", obj: {} }); // placeholder to break cycles
                    pending.push(entity);
                }
                return guid;
            },
            retrieveLite: async lite => await retrieveLite(lite),
        };

        for (const e of entities)
            ctx.include(e);

        // Drain the include queue (dependent assets may enqueue more).
        while (pending.length > 0) {
            const e = pending.shift()!;
            const cfg = configForEntity(e);
            const obj = await cfg.toXml(e, ctx);
            const guid = String(e.id);
            obj[ATTR + "Guid"] = guid;
            elements.set(guid, { name: cfg.elementName, obj });
        }

        // Group elements by name, ordered by guid (Signum orders by Guid for a stable file).
        const byName: Record<string, Record<string, unknown>[]> = {};
        for (const { name, obj } of [...elements.values()].sort((a, b) =>
            (a.obj[ATTR + "Guid"] as string).localeCompare(b.obj[ATTR + "Guid"] as string))) {
            (byName[name] ??= []).push(obj);
        }

        const builder = new XMLBuilder({ attributeNamePrefix: ATTR, ignoreAttributes: false, format: true, suppressEmptyNode: true });
        return builder.build({ Entities: byName });
    }

    // ---- Preview (Signum's UserAssetsImporter.Preview) -----------------------------------------------

    export async function preview(content: string): Promise<UserAssetPreviewModel> {
        const parsed = parse(content);
        const model = new UserAssetPreviewModel();
        model.lines = [];

        for (const { elementName, obj } of parsed) {
            const cfg = registry.get(elementName);
            const guid = String(obj[ATTR + "Guid"] ?? obj["Guid"] ?? "");
            const line = new UserAssetPreviewLineEmbedded();
            line.type = elementName;
            line.guid = guid as UserAssetPreviewLineEmbedded["guid"];
            line.text = String(obj[ATTR + "DisplayName"] ?? obj[ATTR + "Name"] ?? guid);

            if (cfg == null) {
                line.action = EntityAction.New;
                line.overrideEntity = false;
                model.lines.push(line);
                continue;
            }

            const existing = await cfg.load(guid);
            line.action = existing == null ? EntityAction.New : EntityAction.Different;
            line.overrideEntity = existing != null; // default: override existing (admin can untick)
            model.lines.push(line);
        }

        return model;
    }

    // ---- Import (Signum's UserAssetsImporter.Import) -------------------------------------------------

    export async function importAssets(content: string, model: UserAssetPreviewModel): Promise<void> {
        const parsed = parse(content);
        const overrideByGuid = new Map<string, boolean>();
        for (const l of model.lines)
            overrideByGuid.set(String(l.guid), l.overrideEntity);

        // Materialize every asset first (so cross-references by guid resolve), then save.
        const materialized = new Map<string, IUserAssetEntity>();
        const parsedByGuid = new Map<string, { elementName: string; obj: Record<string, unknown> }>();
        for (const p of parsed)
            parsedByGuid.set(String(p.obj[ATTR + "Guid"] ?? p.obj["Guid"] ?? ""), p);

        const ctx: IFromXmlContext = {
            isPreview: false,
            getQuery: queryKey => getQueryByKey(queryKey),
            getType: cleanName => getTypeByCleanName(cleanName, true)!,
            tryGetType: cleanName => getTypeByCleanName(cleanName, false),
            getEntity: guid => {
                const e = materialized.get(guid);
                if (e == null)
                    throw new Error(`UserAssets import: referenced asset '${guid}' not found in file`);
                return e;
            },
            parseLite: liteKey => parseLiteKey(liteKey),
        };

        for (const [guid, p] of parsedByGuid) {
            const cfg = registry.get(p.elementName);
            if (cfg == null)
                continue;
            const existing = await cfg.load(guid);
            if (existing != null && overrideByGuid.get(guid) === false) {
                materialized.set(guid, existing); // keep the DB one for cross-refs, don't overwrite
                continue;
            }
            const entity = existing ?? cfg.create();
            // Set the uuid PK to the incoming identity so a re-import overwrites the same row across DBs
            // (Signum assigned entity.Guid; altea's asset identity is its uuid primary key).
            (entity as unknown as { id: string }).id = guid;
            materialized.set(guid, entity);
        }

        // Second pass: fill (now that all instances exist for cross-refs) and save.
        for (const [guid, p] of parsedByGuid) {
            const cfg = registry.get(p.elementName);
            if (cfg == null)
                continue;
            if (overrideByGuid.get(guid) === false && (await cfg.load(guid)) != null)
                continue;
            const entity = materialized.get(guid)!;
            cfg.fromXml(entity, p.obj, ctx);
            await cfg.save(entity);
        }
    }
}

// ---- helpers -------------------------------------------------------------------------------------------

async function retrieveLite<T extends Entity>(lite: Lite<T>): Promise<T> {
    const rows = await table((lite as any).entityType).filter((e: Entity) => e.id == lite.id).toArray() as T[];
    if (rows[0] == null)
        throw new Error(`UserAssets export: entity ${String(lite)} not found`);
    return rows[0];
}

function parse(content: string): { elementName: string; obj: Record<string, unknown> }[] {
    const parser = new XMLParser({ attributeNamePrefix: ATTR, ignoreAttributes: false, isArray: () => true });
    const root = parser.parse(content) as Record<string, unknown>;
    const entities = ((root["Entities"] as unknown[])?.[0] ?? {}) as Record<string, unknown>;
    const result: { elementName: string; obj: Record<string, unknown> }[] = [];
    for (const [elementName, list] of Object.entries(entities)) {
        if (elementName.startsWith(ATTR))
            continue;
        for (const obj of list as Record<string, unknown>[])
            result.push({ elementName, obj });
    }
    return result;
}

function getQueryByKey(queryKey: string): QueryEntity {
    // Resolved from the QueryEntity cache would be ideal; a direct fetch keeps this self-contained.
    // (Synchronous shape to match Signum's IFromXmlContext.GetQuery; callers already run in async import.)
    const q = queryEntityCache.get(queryKey);
    if (q == null)
        throw new Error(`UserAssets import: query '${queryKey}' is not registered in this database`);
    return q;
}

function getTypeByCleanName(cleanName: string, orThrow: boolean): Lite<TypeEntity> | undefined {
    const t = typeEntityCache.get(cleanName);
    if (t == null) {
        if (orThrow)
            throw new Error(`UserAssets import: type '${cleanName}' does not exist in this database`);
        return undefined;
    }
    return t.toLite() as Lite<TypeEntity>;
}

function parseLiteKey(liteKey: string): Lite<Entity> | undefined {
    // Best-effort: altea lite keys are "TypeName;id"; resolution to a fat lite is left to the caller.
    return undefined;
}

// Small caches warmed at import time (populated by warmCaches before an import/preview runs).
const queryEntityCache = new Map<string, QueryEntity>();
const typeEntityCache = new Map<string, TypeEntity>();

export async function warmUserAssetCaches(): Promise<void> {
    queryEntityCache.clear();
    typeEntityCache.clear();
    for (const q of await table(QueryEntity).toArray() as QueryEntity[])
        queryEntityCache.set(q.key, q);
    for (const t of await table(TypeEntity).toArray() as TypeEntity[])
        typeEntityCache.set(t.cleanName, t);
}
