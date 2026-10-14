import "@altea/altea/server"; // installs save()/delete()
import "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import { unzipSync, zipSync } from "fflate";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { ResetLazy } from "@altea/altea/server/resetLazy";
import { retrieve } from "@altea/altea/server/Database";
import { EntityNotFoundException } from "@altea/altea/server/exceptions";
import type { Schema } from "@altea/altea/server/schema/schema";
import { table } from "@altea/altea/server/table";
import { Graph } from "@altea/altea/server/graph";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { getTypeInfo } from "@altea/altea/data/reflection";
import { PropertyRouteTranslationLogic, type InstanceTranslationLookup } from "@altea/altea/server/propertyRouteTranslation";
import { cleanModified, isGraphModified } from "@altea/altea/data/changes";
import { Statics, type IContextVariable } from "@altea/altea/data/utils/context";
import { Entity, type Type } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import type { uuid } from "@altea/altea/data/basics";
import {
    UserAssetPreviewModel, UserAssetPreviewLineEmbedded, EntityAction, type IUserAssetEntity,
} from "../data/UserAssets";
import { CodeSyncMessage, CodeSyncMixin, CodeSyncOperation, SyncFolderEntity, SyncFolderOperation } from "../data/AssetSync";
import type { AssetSyncDiff, AssetSyncReport, AssetSyncStatus } from "../data/AssetSyncDtos";
import {
    UserAssetsImporter, warmUserAssetCaches, type BinaryStore, type IFromXmlContext, type UserAssetTypeConfig,
} from "./UserAssetsImportExport";
import { AssetSyncFiles, ZipAssets, safeFileName, type AssetExport, type AssetFile } from "./AssetSyncFiles";
import { AssetSyncServer } from "./AssetSyncServer";
import { TranslationQueue } from "./TranslationXml";

// User-asset CODE SYNC — see port/UserAssetCodeSync.md.

export interface AssetSyncOptions {
    /** The asset root: one directory per sync folder. */
    root: string;
    /** Whether a save also writes the asset's file. Defaults to `AUTO_SAVE_ASSET_FILES=true`: an opt-in for a
     *  checkout working against its OWN database, never for a server or a shared database. */
    writeFiles?: boolean;
}

interface SyncedType {
    type: Type<Entity>;
    config: UserAssetTypeConfig;
}

/** Where a set of asset files comes from: the asset root, or an uploaded zip. */
interface AssetSource {
    assets: AssetFile[];
    reader(folder: string): BinaryStore;
}

const pendingWritesKey = "assetSync.pendingWrites";

let syncingVar: IContextVariable<boolean> | undefined;
function syncing(): IContextVariable<boolean> {
    return syncingVar ??= Statics.newContextVariable<boolean>();
}

export namespace AssetSyncLogic {
    let root: string | undefined;
    let writeFiles = false;
    let files: AssetSyncFiles;
    let syncedTypes: SyncedType[] = [];
    let builder: SchemaBuilder | undefined;
    // Every synced row's id → its element name: what a comparison stubs a bare-guid reference with. Read once
    // (one query per synced type) and kept until a synced row changes, instead of on every comparison.
    let syncedIds: ResetLazy<Map<string, string>> | undefined;

    export function isStarted(): boolean {
        return root != undefined;
    }

    export function writesFiles(): boolean {
        return writeFiles;
    }

    /** The asset types are collected when the schema completes, so this may run before the asset modules. */
    export function start(sb: SchemaBuilder, opts: AssetSyncOptions): void {
        if (sb.alreadyDefined(start))
            return;

        root = opts.root;
        builder = sb;
        writeFiles = opts.writeFiles ?? process.env["AUTO_SAVE_ASSET_FILES"] === "true";
        files = new AssetSyncFiles(opts.root);

        sb.include(SyncFolderEntity)
            .withSave(SyncFolderOperation.Save)
            .withQuery()
            .withExecute(SyncFolderOperation.SyncFromCode, {
                canBeNew: false,
                canBeModified: false,
                avoidImplicitSave: true,
                execute: async folder => { await syncFromCode({ folders: [folder.name] }); },
            });

        // Elsewhere the folder is only a row until its files are committed and deployed.
        if (writeFiles)
            sb.schema.entityEvents(SyncFolderEntity).saved.push(folder => {
                Transaction.preRealCommit(() => files.ensureFolder(folder.name));
            });

        sb.schema.schemaCompleted.push(registerAssetTypes);

        // A translation edited in the UI is part of its asset's file, so the file is rewritten; it is NOT
        // kept on sync — like an upload, it reaches the code or the next sync replaces it.
        PropertyRouteTranslationLogic.instanceTranslationsChanged.push(async instances => {
            if (!writeFiles || syncing().getValue() === true)
                return;
            for (const lite of instances) {
                const owner = await ownerAsset(lite);
                if (owner != undefined)
                    writeOnCommit(owner.id, owner.config);
            }
        });

        if (sb.webBuilder)
            AssetSyncServer.start(sb.webBuilder);
    }

    /** The folder directories under the asset root. */
    export function folderDirectories(): string[] {
        assertStarted();
        return files.folders();
    }

    function registerAssetTypes(schema: Schema): void {
        const configs = UserAssetsImporter.configs();
        syncedTypes = [...schema.tables.keys()]
            .filter(type => MixinDeclarations.isDeclared(type, CodeSyncMixin))
            .flatMap(type => {
                const config = configs.find(c => c.create().getType() === type);
                return config == undefined ? [] : [{ type: type as Type<Entity>, config }];
            });

        syncedIds = builder!.globalLazy(async () => {
            const result = new Map<string, string>();
            for (const { type, config } of syncedTypes)
                for (const id of await table(type).filter(e => e.mixin(CodeSyncMixin).syncFolder != null).map(e => e.id).toArray())
                    result.set(String(id), config.elementName);
            return result;
        }, { invalidateWith: syncedTypes.map(t => t.type), name: "AssetSync synced ids" });

        for (const { type, config } of syncedTypes) {
            const events = schema.entityEvents(type);
            events.saving.push(async entity => {
                if (syncing().getValue() === true)
                    return;
                await rememberFolderChange(entity as IUserAssetEntity, type);
                onSaving(entity as IUserAssetEntity);
            });
            events.saved.push(async entity => {
                if (syncing().getValue() === true)
                    return;
                await cascadeFolderChange(entity as IUserAssetEntity);
                if (writeFiles)
                    writeOnCommit(String(entity.id), config, entity as IUserAssetEntity);
            });
            events.preUnsafeDelete.push(async query => {
                if (!writeFiles || syncing().getValue() === true)
                    return;
                const ids = await query.map(e => e.id).toArray();
                const remove = (): void => { for (const id of ids) files.remove(String(id)); };
                // A delete outside a transaction commits on its own, right after this.
                if (Transaction.hasTransaction())
                    Transaction.preRealCommit(remove);
                else
                    remove();
            });
        }

        // One implementation per symbol: it is registered on the first type and every other one joins it.
        if (syncedTypes.length > 0) {
            new Graph.Execute<Entity>(syncedTypes[0]!.type, CodeSyncOperation.DiscardDbChanges, {
                canBeNew: false,
                canBeModified: false,
                avoidImplicitSave: true,
                canExecute: e => e.mixin(CodeSyncMixin).syncFolder == null ? CodeSyncMessage.TheAssetHasNoSyncFolder.niceToString() : null,
                execute: async e => { await applyFile(String(e.id)); },
            }).register();
            for (const { type } of syncedTypes.slice(1))
                OperationLogic.registerForType(CodeSyncOperation.DiscardDbChanges, type);
        }
    }

    // ---- Saving ----------------------------------------------------------------------------------------

    // Where the save also writes the file, the file carries the change; elsewhere the change only exists
    // in this database, and the next sync must not overwrite it.
    function onSaving(entity: IUserAssetEntity): void {
        if (syncing().getValue() === true)
            return;
        const m = entity.mixin(CodeSyncMixin);
        const keep = m.syncFolder != null && !writeFiles;
        if (m.keepOnSync !== keep)
            m.keepOnSync = keep;
    }

    // After the write, so every row of the asset already has its id when it is exported. The file goes in
    // just before the commit: one that cannot be written rolls the save back.
    /**
     * Written once per asset per transaction, just before the commit: by then the asset's children and
     * its translations, saved after it, are in. `entity` undefined means "reload it" (a translation edit).
     */
    function writeOnCommit(guid: string, config: UserAssetTypeConfig, entity?: IUserAssetEntity): void {
        const userData = Transaction.userData();
        let pending = userData[pendingWritesKey] as Map<string, { config: UserAssetTypeConfig; entity?: IUserAssetEntity }> | undefined;
        if (pending == undefined) {
            userData[pendingWritesKey] = pending = new Map();
            const writes = pending;
            Transaction.preRealCommit(async () => {
                const translations = await PropertyRouteTranslationLogic.loadInstanceTranslations();
                for (const [id, w] of writes) {
                    const asset = w.entity ?? await w.config.load(id);
                    const folderLite = asset?.mixin(CodeSyncMixin).syncFolder;
                    if (asset == undefined || folderLite == null) {
                        files.remove(id);
                        continue;
                    }
                    const folder = (await folderLite.retrieve()).name;
                    const baseName = files.baseNameFor(folder, id, asset.toString(), w.config.elementName);
                    files.write(id, folder, baseName, await exportAsset(asset, baseName, true, translations));
                }
            });
        }
        if (entity != undefined || !pending.has(guid))
            pending.set(guid, { config, entity });
    }

    async function exportAsset(entity: IUserAssetEntity, baseName: string, strict: boolean, translations?: InstanceTranslationLookup): Promise<AssetExport> {
        const sidecars = new Map<string, Uint8Array>();
        const referenced: unknown[] = [];
        const xml = await UserAssetsImporter.toAssetXml(entity, AssetSyncFiles.writer(baseName, sidecars), r => referenced.push(r), translations);
        if (strict)
            for (const r of await syncableAssets(referenced))
                if (r.mixin(CodeSyncMixin).syncFolder == null)
                    throw new Error(CodeSyncMessage._0References1WhichHasNoSyncFolder.niceToString(entity.toString(), r.toString()));
        return { xml: xml.endsWith("\n") ? xml : xml + "\n", sidecars };
    }

    /** The assets an asset references — what its export writes as Guids. */
    async function referencedAssets(entity: IUserAssetEntity): Promise<IUserAssetEntity[]> {
        const referenced: unknown[] = [];
        await UserAssetsImporter.toAssetXml(entity, AssetSyncFiles.writer("_", new Map()), r => referenced.push(r));
        return await syncableAssets(referenced);
    }

    // A serializer may hand `include` a thin lite or a non-asset (a workflow's schedule rule); only assets
    // that can have a sync folder count.
    async function syncableAssets(values: unknown[]): Promise<IUserAssetEntity[]> {
        const result = new Map<string, IUserAssetEntity>();
        for (const v of values) {
            const e = v instanceof Lite ? await v.retrieve() : v;
            if (e instanceof Entity && MixinDeclarations.isDeclared(e.getType(), CodeSyncMixin))
                result.set(`${e.getType().name};${String(e.id)}`, e as IUserAssetEntity);
        }
        return [...result.values()];
    }

    // ---- From a row (a translated instance) to its asset ------------------------------------------------

    const ownerResolvers = new Map<Type<Entity>, (lite: Lite<Entity>) => Promise<Lite<Entity> | undefined>>();

    /** For a part with no `@backReference` to follow (a dashboard part's content): who holds it. */
    export function registerOwnerResolver<T extends Entity>(type: Type<T>, owner: (lite: Lite<T>) => Promise<Lite<Entity> | undefined>): void {
        ownerResolvers.set(type, owner as (lite: Lite<Entity>) => Promise<Lite<Entity> | undefined>);
    }

    async function ownerAsset(lite: Lite<Entity>): Promise<{ id: string; config: UserAssetTypeConfig } | undefined> {
        let current: Lite<Entity> | undefined = lite;
        while (current != undefined) {
            const type: Type<Entity> = current.entityType;
            const synced = syncedTypes.find(t => t.type === type);
            if (synced != undefined)
                return { id: String(current.id), config: synced.config };
            const resolver = ownerResolvers.get(type);
            if (resolver != undefined) {
                current = await resolver(current);
                continue;
            }
            const back = getTypeInfo(type)?.backReferenceField;
            if (back == null)
                return undefined;
            // A row already deleted (an orphaned translation being cleaned) has no asset left to rewrite.
            const id = current.id;
            const row = (await table(type).filter(e => e.id == id).toArray())[0] as unknown as Record<string, Lite<Entity> | undefined> | undefined;
            current = row?.[back.name];
        }
        return undefined;
    }

    // ---- A container's folder moves its children ------------------------------------------------------

    const folderChanges = new WeakMap<IUserAssetEntity, Lite<SyncFolderEntity> | null>();

    // Read in `saving`, while the row still holds the previous folder.
    async function rememberFolderChange(entity: IUserAssetEntity, type: Type<Entity>): Promise<void> {
        const id = entity.id;
        const previous = entity.isNew ? null
            : await table(type).filter(e => e.id == id).map(e => e.mixin(CodeSyncMixin).syncFolder).singleOrNull() ?? null;
        if (!sameFolder(previous, entity.mixin(CodeSyncMixin).syncFolder))
            folderChanges.set(entity, previous);
    }

    /**
     * When a container (a toolbar, a dashboard…) changes folder, the assets it references follow it if they
     * had NO folder or the PREVIOUS one; one in a third folder keeps it. Clearing the folder clears the ones
     * that had the previous folder. Each child is saved normally, so its own children follow in turn.
     */
    async function cascadeFolderChange(entity: IUserAssetEntity): Promise<void> {
        if (!folderChanges.has(entity))
            return;
        const previous = folderChanges.get(entity)!;
        folderChanges.delete(entity);
        const current = entity.mixin(CodeSyncMixin).syncFolder;

        for (const child of await referencedAssets(entity)) {
            const m = child.mixin(CodeSyncMixin);
            const follows = m.syncFolder == null ? current != null : sameFolder(m.syncFolder, previous) && !sameFolder(m.syncFolder, current);
            if (!follows)
                continue;
            m.syncFolder = current;
            await configOf(child).save(child);
        }
    }

    function sameFolder(a: Lite<SyncFolderEntity> | null, b: Lite<SyncFolderEntity> | null): boolean {
        return a == null || b == null ? a == b : a.is(b);
    }

    function configOf(asset: IUserAssetEntity): UserAssetTypeConfig {
        return syncedTypes.find(t => t.type === asset.getType())!.config;
    }

    // ---- The comparison ---------------------------------------------------------------------------------

    /**
     * Whether applying the file would change the row: it is applied onto a fresh COPY and `isGraphModified`
     * is asked. That compares meaning, not XML text, so a change in the XML format (a renamed attribute the
     * importer still reads) is not a difference, and a field the XML does not carry keeps the row's value.
     */
    async function differsFromFile(guid: string, file: AssetFile, ctx: IFromXmlContext, source: AssetSource): Promise<boolean> {
        const config = UserAssetsImporter.configFor(file.elementName);
        const copy = await loadRow(config, guid);
        if (copy == undefined)
            return true;
        const translations = new TranslationQueue();
        await config.fromXml(copy, file.obj, { ...ctx, binary: source.reader(file.folder), translations });
        return isGraphModified(copy) || await translations.differs();
    }

    /**
     * The import context for a COMPARISON: a referenced asset resolves to an identity-only stub, clean and not
     * new, so the comparison walks no further than the asset itself and is not affected by what else changes.
     */
    async function comparisonContext(fileEntries: { guid: string; elementName: string }[]): Promise<IFromXmlContext> {
        const stubs = new Map<string, IUserAssetEntity>();
        const stub = (config: UserAssetTypeConfig, id: unknown): void => {
            const s = config.create();
            s.id = id as Entity["id"];
            s.isNew = false;
            cleanModified(s);
            stubs.set(String(id), s);
        };
        for (const [id, elementName] of await syncedIds!.value())
            stub(UserAssetsImporter.configFor(elementName), id);
        for (const f of fileEntries)
            if (!stubs.has(f.guid))
                stub(UserAssetsImporter.configFor(f.elementName), f.guid);
        return await UserAssetsImporter.fromXmlContext(true, stubs);
    }

    function folderSource(): AssetSource {
        return { assets: files.scan(), reader: folder => files.reader(folder) };
    }

    /**
     * Every file and every synced row — WITHOUT comparing the ones on both sides (`comparison: null`): that
     * applies the file onto a copy of the row, which is the expensive part, so it is {@link statusOf}, asked
     * per asset (the panel asks for all of them at once). Only a row with no file is known here (NotInCode).
     */
    export async function status(folder?: string): Promise<AssetSyncStatus[]> {
        assertStarted();
        const folderNames = await folderNamesById();
        const result: AssetSyncStatus[] = [];

        const rows = new Map<string, { type: string; name: string; folder: string; keepOnSync: boolean }>();
        for (const { type, config } of syncedTypes)
            for (const r of await table(type).filter(e => e.mixin(CodeSyncMixin).syncFolder != null)
                .map(e => ({ lite: e.toLite(), syncFolder: e.mixin(CodeSyncMixin).syncFolder, keepOnSync: e.mixin(CodeSyncMixin).keepOnSync }))
                .toArray())
                rows.set(String(r.lite.id), { type: config.elementName, name: r.lite.toString(), folder: folderNames.get(String(r.syncFolder!.id))!, keepOnSync: r.keepOnSync });

        for (const file of files.scan()) {
            const r = rows.get(file.guid);
            rows.delete(file.guid);
            if (folder == undefined || file.folder === folder)
                result.push(line(file.elementName, file.guid, r?.name ?? file.baseName.replace(/\.[^.]+$/, ""), file.folder, null, r?.keepOnSync ?? false));
        }

        for (const [guid, r] of rows)
            if (folder == undefined || r.folder === folder)
                result.push(line(r.type, guid, r.name, r.folder, "NotInCode", r.keepOnSync));

        return result.sort((a, b) => a.folder.localeCompare(b.folder) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    }

    function line(type: string, guid: string, name: string, folder: string, comparison: AssetSyncStatus["comparison"], keepOnSync: boolean): AssetSyncStatus {
        return { type, guid: guid as uuid, name, folder, comparison, keepOnSync };
    }

    /** ONE asset's line, compared: its file (if any) applied onto a copy of its row (if any). The caller
     *  names the TYPE, so the row is one lookup — from the cache, for a cached type — not a probe per type. */
    export async function statusOf(elementName: string, guid: string): Promise<AssetSyncStatus | null> {
        assertStarted();
        const synced = syncedTypes.find(t => t.config.elementName === elementName);
        if (synced == undefined)
            throw new Error(`'${elementName}' is not a synced asset type`);
        const file = files.read(guid);
        const row = await loadRow(synced.config, guid);
        const r = row == undefined ? undefined : { row, config: synced.config };
        const m = r?.row.mixin(CodeSyncMixin);
        if (file == undefined) {
            if (r == undefined || m!.syncFolder == null)
                return null;
            const folder = (await m!.syncFolder.retrieve()).name;
            return line(r.config.elementName, guid, r.row.toString(), folder, "NotInCode", m!.keepOnSync);
        }

        if (r == undefined)
            return line(file.elementName, guid, file.baseName.replace(/\.[^.]+$/, ""), file.folder, "NotInDatabase", false);

        const moved = m!.syncFolder == null || (await m!.syncFolder.retrieve()).name !== file.folder;
        let differs = moved;
        if (!differs) {
            await warmUserAssetCaches();
            const ctx = await comparisonContext(files.entries());
            differs = await differsFromFile(guid, file, ctx, { assets: [file], reader: folder => files.reader(folder) });
        }
        return line(file.elementName, guid, r.row.toString(), file.folder, differs ? "DiffersFromCode" : "Identical", m!.keepOnSync);
    }

    export async function diff(guid: string): Promise<AssetSyncDiff> {
        assertStarted();
        const at = files.locate(guid);
        const r = await loadAny(guid);
        const baseName = at?.baseName ?? (r == undefined ? guid : `${safeFileName(r.row.toString()) || guid}.${r.config.elementName}`);
        return {
            database: r == undefined ? null : (await exportAsset(r.row, baseName, false)).xml,
            file: at == undefined ? null : files.readXml(at.folder, at.baseName),
        };
    }

    // ---- Code → database -------------------------------------------------------------------------------

    /**
     * Bring the database in line with the files. Every folder is parsed, so a reference into another
     * folder resolves, but only `folders` (default: all) is applied.
     */
    export async function syncFromCode(opts: { folders?: string[] } = {}): Promise<AssetSyncReport> {
        assertStarted();
        await warmUserAssetCaches();
        const report: AssetSyncReport = { created: [], updated: [], unchanged: [], reset: [], kept: [], deleted: [], notInCode: [] };

        const source = folderSource();
        const present = new Set(files.folders());
        if (present.size == 0)
            throw new Error(`${root} has no sync folders. A missing checkout would delete every synced asset, so nothing was synced.`);
        for (const f of opts.folders ?? [])
            if (!present.has(f))
                throw new Error(`There is no '${f}' directory in ${root}`);
        const scope = new Set(opts.folders ?? present);

        await syncing().withValue(true, () => Transaction.create(async () => {
            const folders = await ensureFolders([...present]);
            const inScope = source.assets.filter(f => scope.has(f.folder));

            // Classified BEFORE anything is applied, so no comparison sees another asset's pending change.
            const compareCtx = await comparisonContext(source.assets);
            const differs = new Map<string, boolean>();
            for (const file of inScope)
                differs.set(file.guid, await differsFromFile(file.guid, file, compareCtx, source));

            const { materialized, existing } = await materialize(source.assets);
            const ctx = await UserAssetsImporter.fromXmlContext(false, materialized);

            const toSave: { entity: IUserAssetEntity; config: UserAssetTypeConfig; label: string; bucket: string[] }[] = [];
            for (const file of inScope) {
                const config = UserAssetsImporter.configFor(file.elementName);
                const entity = materialized.get(file.guid)!;
                const label = `${file.folder}/${file.baseName}`;
                const folder = folders.get(file.folder)!;
                const m = entity.mixin(CodeSyncMixin);

                if (existing.has(file.guid)) {
                    if (!differs.get(file.guid)) {
                        if (m.syncFolder?.is(folder) && !m.keepOnSync) {
                            report.unchanged.push(label);
                            continue;
                        }
                        const bucket = m.keepOnSync ? report.reset : report.updated;
                        stamp(m, folder, false);
                        toSave.push({ entity, config, label, bucket });
                        continue;
                    }
                    if (m.keepOnSync) {
                        report.kept.push(label);
                        continue;
                    }
                }

                await config.fromXml(entity, file.obj, { ...ctx, binary: source.reader(file.folder) });
                stamp(m, folder, false);
                toSave.push({ entity, config, label, bucket: existing.has(file.guid) ? report.updated : report.created });
            }

            // Filled first, saved after: a new asset is often saved as a REFERENCE of another one first.
            for (const s of toSave) {
                if (s.entity.isNew || isGraphModified(s.entity))
                    await s.config.save(s.entity);
                s.bucket.push(s.label);
            }

            await ctx.translations.save();
            await removeMissing(source.assets, present, scope, opts.folders == undefined, report);
        }));

        return report;
    }

    /** One asset back to its file, whether it is kept on sync or not. */
    export async function applyFile(guid: string): Promise<void> {
        assertStarted();
        await warmUserAssetCaches();
        const source = folderSource();
        const file = source.assets.find(f => f.guid === guid);
        if (file == undefined)
            throw new Error(CodeSyncMessage.NoFileForThisAssetIn0.niceToString(root!));

        await syncing().withValue(true, () => Transaction.create(async () => {
            const folders = await ensureFolders([file.folder]);
            const { materialized } = await materialize(source.assets);
            const entity = materialized.get(guid)!;
            const ctx = await UserAssetsImporter.fromXmlContext(false, materialized);
            const config = UserAssetsImporter.configFor(file.elementName);
            await config.fromXml(entity, file.obj, { ...ctx, binary: source.reader(file.folder) });
            stamp(entity.mixin(CodeSyncMixin), folders.get(file.folder)!, false);
            await config.save(entity);
            await ctx.translations.save();
        }));
    }

    export async function setKeepOnSync(guid: string, keepOnSync: boolean): Promise<void> {
        const r = await loadAny(guid);
        if (r == undefined)
            throw new Error(`No asset ${guid}`);
        await syncing().withValue(true, async () => {
            r.row.mixin(CodeSyncMixin).keepOnSync = keepOnSync;
            await r.config.save(r.row);
        });
    }

    function stamp(m: CodeSyncMixin, folder: Lite<SyncFolderEntity>, keepOnSync: boolean): void {
        if (!m.syncFolder?.is(folder))
            m.syncFolder = folder;
        if (m.keepOnSync !== keepOnSync)
            m.keepOnSync = keepOnSync;
    }

    async function ensureFolders(names: string[]): Promise<Map<string, Lite<SyncFolderEntity>>> {
        const result = new Map<string, Lite<SyncFolderEntity>>();
        for (const f of await table(SyncFolderEntity).toArray() as SyncFolderEntity[])
            result.set(f.name, f.toLite());
        for (const name of names)
            if (!result.has(name)) {
                const f = SyncFolderEntity.create({ name });
                await f.save();
                result.set(name, f.toLite());
            }
        return result;
    }

    async function folderNamesById(): Promise<Map<string, string>> {
        return new Map((await table(SyncFolderEntity).toArray() as SyncFolderEntity[]).map(f => [String(f.id), f.name]));
    }

    // One asset's row, through `Database.retrieve` — served from memory for a cached type (every synced type is
    // master data a lazy watches, so in practice all of them), where `config.load` is always a query.
    async function loadRow(config: UserAssetTypeConfig, guid: string): Promise<IUserAssetEntity | undefined> {
        const synced = syncedTypes.find(t => t.config === config);
        if (synced == undefined)
            return await config.load(guid);
        try {
            return await retrieve(synced.type, guid as Entity["id"]) as unknown as IUserAssetEntity;
        } catch (e) {
            if (e instanceof EntityNotFoundException)
                return undefined;
            throw e;
        }
    }

    async function loadAny(guid: string, elementName?: string): Promise<{ row: IUserAssetEntity; config: UserAssetTypeConfig } | undefined> {
        for (const { config } of syncedTypes) {
            if (elementName != undefined && config.elementName !== elementName)
                continue;
            const row = await config.load(guid);
            if (row != undefined)
                return { row, config };
        }
        return undefined;
    }

    // Every asset of `assets`, loaded or new, plus every other synced row, so a reference to any of them resolves.
    async function materialize(assets: AssetFile[]): Promise<{ materialized: Map<string, IUserAssetEntity>; existing: Map<string, IUserAssetEntity> }> {
        const materialized = new Map<string, IUserAssetEntity>();
        const existing = new Map<string, IUserAssetEntity>();
        for (const { type } of syncedTypes)
            for (const row of await table(type).filter(e => e.mixin(CodeSyncMixin).syncFolder != null).toArray() as IUserAssetEntity[])
                materialized.set(String(row.id), row);
        for (const file of assets) {
            const config = UserAssetsImporter.configFor(file.elementName);
            const loaded = materialized.get(file.guid) ?? await config.load(file.guid);
            if (loaded != undefined)
                existing.set(file.guid, loaded);
            const entity = loaded ?? config.create();
            if (loaded == undefined)
                entity.id = file.guid as Entity["id"];
            materialized.set(file.guid, entity);
        }
        return { materialized, existing };
    }

    // Containers first (a toolbar before the dashboard it shows), hence the reversed registration order.
    async function removeMissing(assets: AssetFile[], present: Set<string>, scope: Set<string>, syncAll: boolean, report: AssetSyncReport): Promise<void> {
        const inFiles = new Set(assets.map(f => f.guid));
        const folderNames = await folderNamesById();

        for (const { type } of [...syncedTypes].reverse()) {
            const rows = await table(type)
                .filter(e => e.mixin(CodeSyncMixin).syncFolder != null)
                .toArray() as IUserAssetEntity[];

            for (const row of rows) {
                const m = row.mixin(CodeSyncMixin);
                const folder = folderNames.get(String(m.syncFolder!.id))!;
                // A folder whose last file was removed has no directory (git keeps no empty one): a full
                // sync treats it as empty.
                if (inFiles.has(String(row.id)) || !(scope.has(folder) || syncAll && !present.has(folder)))
                    continue;

                const label = `${folder}/${row.toString()}`;
                if (m.keepOnSync) {
                    report.notInCode.push(label);
                } else {
                    await row.delete();
                    report.deleted.push(label);
                }
            }
        }
    }

    // ---- Development: database → files ------------------------------------------------------------------

    /** Write the row's file, whatever is on disk. */
    export async function writeFile(guid: string): Promise<void> {
        assertWritesFiles();
        const r = await loadAny(guid);
        if (r == undefined)
            throw new Error(`No asset ${guid}`);
        const folderLite = r.row.mixin(CodeSyncMixin).syncFolder;
        if (folderLite == null)
            throw new Error(CodeSyncMessage.TheAssetHasNoSyncFolder.niceToString());
        const folder = (await folderLite.retrieve()).name;
        const baseName = files.baseNameFor(folder, guid, r.row.toString(), r.config.elementName);
        files.write(guid, folder, baseName, await exportAsset(r.row, baseName, true));
        if (r.row.mixin(CodeSyncMixin).keepOnSync)
            await syncing().withValue(true, async () => {
                r.row.mixin(CodeSyncMixin).keepOnSync = false;
                await r.config.save(r.row);
            });
    }

    /** Re-export every asset IDENTICAL to its file, so the files take the current XML format. */
    export async function rewriteFiles(): Promise<string[]> {
        assertWritesFiles();
        const rewritten: string[] = [];
        for (const s of (await status()).filter(s => s.comparison === "Identical")) {
            const at = files.locate(s.guid)!;
            const r = (await loadAny(s.guid, s.type))!;
            const exported = await exportAsset(r.row, at.baseName, false);
            if (exported.xml !== files.readXml(at.folder, at.baseName)) {
                files.write(s.guid, at.folder, at.baseName, exported);
                rewritten.push(`${at.folder}/${at.baseName}`);
            }
        }
        return rewritten;
    }

    function assertWritesFiles(): void {
        assertStarted();
        if (!writeFiles)
            throw new Error(CodeSyncMessage.FilesAreNotWrittenHere.niceToString());
    }

    // ---- Zip: database → zip, zip → database ------------------------------------------------------------

    /** Every asset of the folder as the DATABASE has it, written as the development writer would. */
    export async function zipFolder(folder: Lite<SyncFolderEntity>): Promise<{ name: string; bytes: Uint8Array }> {
        assertStarted();
        const name = (await folder.retrieve()).name;
        const entries: Record<string, Uint8Array> = {};
        const encoder = new TextEncoder();

        for (const { type, config } of syncedTypes) {
            const rows = await table(type)
                .filter(e => e.mixin(CodeSyncMixin).syncFolder!.is(folder))
                .toArray() as IUserAssetEntity[];
            for (const row of rows) {
                // The name the deployed file already has, so unzipping over the folder replaces it.
                const deployed = files.locate(String(row.id));
                let baseName = deployed?.folder === name ? deployed.baseName : `${safeFileName(row.toString()) || String(row.id)}.${config.elementName}`;
                if (deployed?.folder !== name && entries[`${name}/${baseName}.xml`] != undefined)
                    baseName = `${safeFileName(row.toString()) || "asset"}.${String(row.id).slice(0, 8)}.${config.elementName}`;
                const exported = await exportAsset(row, baseName, false);
                entries[`${name}/${baseName}.xml`] = encoder.encode(exported.xml);
                for (const [rel, bytes] of exported.sidecars)
                    entries[`${name}/${rel}`] = bytes;
            }
        }

        return { name: `${name}.zip`, bytes: zipSync(entries) };
    }

    function zipSource(bytes: Uint8Array): AssetSource {
        const zip = new ZipAssets(unzipSync(bytes));
        return { assets: zip.assets, reader: folder => zip.reader(folder) };
    }

    /** New / Different / Identical against the DATABASE, as the one-file import previews. */
    export async function previewZip(bytes: Uint8Array): Promise<UserAssetPreviewModel> {
        assertStarted();
        await warmUserAssetCaches();
        const source = zipSource(bytes);
        const ctx = await comparisonContext(source.assets);
        const model = UserAssetPreviewModel.create({ lines: [] });
        for (const file of source.assets) {
            const exists = await loadAny(file.guid, file.elementName) != undefined;
            const action = !exists ? EntityAction.New
                : await differsFromFile(file.guid, file, ctx, source) ? EntityAction.Different
                : EntityAction.Identical;
            model.lines.push(UserAssetPreviewLineEmbedded.create({
                type: file.elementName,
                guid: file.guid as uuid,
                text: `${file.folder}/${file.baseName}`,
                action,
                overrideEntity: action === EntityAction.Different,
            }));
        }
        return model;
    }

    /**
     * Apply a zip to the DATABASE, like a sync from it: the assets take the zip's folders and are NOT kept
     * on sync (unless asked), so the next deployment brings them back in line with the code. Files are
     * written only where a save would write them.
     */
    export async function importZip(bytes: Uint8Array, model: UserAssetPreviewModel, keepOnSync: boolean): Promise<void> {
        assertStarted();
        await warmUserAssetCaches();
        const source = zipSource(bytes);
        const lines = new Map(model.lines.map(l => [String(l.guid), l]));

        await syncing().withValue(true, () => Transaction.create(async () => {
            const folders = await ensureFolders([...new Set(source.assets.map(a => a.folder))]);
            const { materialized, existing } = await materialize(source.assets);
            const ctx = await UserAssetsImporter.fromXmlContext(false, materialized);

            const toSave: { entity: IUserAssetEntity; config: UserAssetTypeConfig }[] = [];
            for (const file of source.assets) {
                const l = lines.get(file.guid);
                const config = UserAssetsImporter.configFor(file.elementName);
                const entity = materialized.get(file.guid)!;
                const apply = !existing.has(file.guid) || l?.action === EntityAction.Different && l.overrideEntity;
                if (apply)
                    await config.fromXml(entity, file.obj, { ...ctx, binary: source.reader(file.folder) });
                if (apply || l?.action === EntityAction.Identical) {
                    stamp(entity.mixin(CodeSyncMixin), folders.get(file.folder)!, keepOnSync);
                    toSave.push({ entity, config });
                }
            }

            for (const s of toSave)
                if (s.entity.isNew || isGraphModified(s.entity))
                    await s.config.save(s.entity);
            await ctx.translations.save();
            if (writeFiles)
                for (const s of toSave)
                    writeOnCommit(String(s.entity.id), s.config, s.entity);
        }));
    }

    function assertStarted(): void {
        if (root == undefined)
            throw new Error("AssetSyncLogic.start was not called");
    }
}
