import "@altea/altea/server"; // installs save()/delete()
import "@altea/altea/server/fluentOperations";
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery";
import { zipSync } from "fflate";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import type { Schema } from "@altea/altea/server/schema/schema";
import { table } from "@altea/altea/server/table";
import { Graph } from "@altea/altea/server/graph";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import { Transaction } from "@altea/altea/server/connection/transaction";
import { PermissionLogic } from "@altea/altea/server/permissionLogic";
import { CustomType, attachmentDisposition, type WebBuilder } from "@altea/altea/server/webApi";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { isGraphModified } from "@altea/altea/data/changes";
import { Statics, type IContextVariable } from "@altea/altea/data/utils/context";
import type { Entity, Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { UserAssetPermission, type IUserAssetEntity } from "../data/UserAssets";
import {
    CodeSyncMessage, CodeSyncMixin, CodeSyncOperation, CodeSyncState, SyncFolderEntity, SyncFolderOperation,
} from "../data/AssetSync";
import { UserAssetsImporter, parseAssets, warmUserAssetCaches, type UserAssetTypeConfig } from "./UserAssetsImportExport";
import { AssetSyncFiles, safeFileName, type AssetExport, type AssetFile } from "./AssetSyncFiles";

// User-asset CODE SYNC — see port/UserAssetCodeSync.md.

export interface AssetSyncOptions {
    /** The asset root: one directory per sync folder. */
    root: string;
    /** Development: a save writes the asset's file. Otherwise a save marks the asset ModifiedInDb. */
    writeFiles: boolean;
}

export interface AssetSyncReport {
    created: string[];
    updated: string[];
    unchanged: string[];
    /** ModifiedInDb, but identical to the file: back to InSync. */
    reset: string[];
    /** ModifiedInDb and different from the file: the database version was kept. */
    kept: string[];
    deleted: string[];
    /** The file is gone but the asset was ModifiedInDb: its sync folder was cleared. */
    detached: string[];
}

interface SyncedType {
    type: Type<Entity>;
    config: UserAssetTypeConfig;
}

let syncingVar: IContextVariable<boolean> | undefined;
function syncing(): IContextVariable<boolean> {
    return syncingVar ??= Statics.newContextVariable<boolean>();
}

export namespace AssetSyncLogic {
    let options: AssetSyncOptions | undefined;
    let files: AssetSyncFiles;
    let syncedTypes: SyncedType[] = [];

    export function isStarted(): boolean {
        return options != undefined;
    }

    /** The asset types are collected when the schema completes, so this may run before the asset modules. */
    export function start(sb: SchemaBuilder, opts: AssetSyncOptions): void {
        if (sb.alreadyDefined(start))
            return;

        options = opts;
        files = new AssetSyncFiles(opts.root);

        const folders = sb.include(SyncFolderEntity)
            .withQuery()
            .withExecute(SyncFolderOperation.SyncFromCode, {
                canBeNew: false,
                canBeModified: false,
                avoidImplicitSave: true,
                execute: async folder => { await syncFromCode({ folders: [folder.name] }); },
            });

        if (opts.writeFiles) {
            folders.withSave(SyncFolderOperation.Save);
            sb.schema.entityEvents(SyncFolderEntity).saved.push(folder => {
                Transaction.preRealCommit(() => files.ensureFolder(folder.name));
            });
        }

        sb.schema.schemaCompleted.push(registerAssetTypes);

        if (sb.webBuilder)
            startServer(sb.webBuilder);
    }

    function registerAssetTypes(schema: Schema): void {
        const configs = UserAssetsImporter.configs();
        syncedTypes = [...schema.tables.keys()]
            .filter(type => MixinDeclarations.isDeclared(type, CodeSyncMixin))
            .flatMap(type => {
                const config = configs.find(c => c.create().getType() === type);
                return config == undefined ? [] : [{ type: type as Type<Entity>, config }];
            });

        for (const { type, config } of syncedTypes) {
            const events = schema.entityEvents(type);
            events.saving.push(entity => onSaving(entity as IUserAssetEntity));
            events.saved.push(entity => onSaved(entity as IUserAssetEntity, config));
            events.preUnsafeDelete.push(async query => {
                if (!options!.writeFiles || syncing().getValue() === true)
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
                execute: async e => { await discardDbChanges(e as IUserAssetEntity); },
            }).register();
            for (const { type } of syncedTypes.slice(1))
                OperationLogic.registerForType(CodeSyncOperation.DiscardDbChanges, type);
        }
    }

    // ---- Saving ----------------------------------------------------------------------------------------

    function onSaving(entity: IUserAssetEntity): void {
        if (syncing().getValue() === true)
            return;
        const m = entity.mixin(CodeSyncMixin);
        m.codeSyncState = m.syncFolder == null ? null
            : options!.writeFiles ? CodeSyncState.InSync
            : CodeSyncState.ModifiedInDb;
    }

    // After the write, so every row of the asset already has its id when it is exported. The file goes
    // in just before the commit: one that cannot be written rolls the save back.
    async function onSaved(entity: IUserAssetEntity, config: UserAssetTypeConfig): Promise<void> {
        if (!options!.writeFiles || syncing().getValue() === true)
            return;

        const guid = String(entity.id);
        const folderLite = entity.mixin(CodeSyncMixin).syncFolder;
        if (folderLite == null) {
            Transaction.preRealCommit(() => files.remove(guid));
            return;
        }

        const folder = (await folderLite.retrieve()).name;
        const baseName = files.baseNameFor(folder, guid, entity.toString(), config.elementName);
        const exported = await exportAsset(entity, baseName);
        Transaction.preRealCommit(() => files.write(guid, folder, baseName, exported));
    }

    async function exportAsset(entity: IUserAssetEntity, baseName: string): Promise<AssetExport> {
        const sidecars = new Map<string, Uint8Array>();
        const xml = await UserAssetsImporter.toAssetXml(entity, AssetSyncFiles.writer(baseName, sidecars), referenced => {
            if (!isSynced(referenced))
                throw new Error(CodeSyncMessage._0References1WhichHasNoSyncFolder.niceToString(entity.toString(), referenced.toString()));
        });
        return { xml, sidecars };
    }

    function isSynced(asset: IUserAssetEntity): boolean {
        return MixinDeclarations.isDeclared(asset.getType(), CodeSyncMixin) && asset.mixin(CodeSyncMixin).syncFolder != null;
    }

    /**
     * Whether writing the row now would reproduce the file: the same XML and the same sidecar bytes.
     * Applying the file and asking `isGraphModified` would not do, because a serializer that rebuilds a
     * collection's rows reports a change every time.
     */
    async function isSameAsFile(entity: IUserAssetEntity, file: AssetFile): Promise<boolean> {
        const sidecars = new Map<string, Uint8Array>();
        let unsynced = false;
        const xml = await UserAssetsImporter.toAssetXml(entity, AssetSyncFiles.writer(file.baseName, sidecars), referenced => {
            unsynced ||= !isSynced(referenced);
        });
        if (unsynced || !sameXml(parseAssets(xml)[0]?.obj, file.obj))
            return false;
        for (const [rel, bytes] of sidecars)
            if (!sameBytes(files.readSidecar(file.folder, rel), bytes))
                return false;
        return true;
    }

    function stamp(m: CodeSyncMixin, folder: Lite<SyncFolderEntity>): void {
        if (!m.syncFolder?.is(folder))
            m.syncFolder = folder;
        if (m.codeSyncState !== CodeSyncState.InSync)
            m.codeSyncState = CodeSyncState.InSync;
    }

    // ---- Code → database -------------------------------------------------------------------------------

    /**
     * Bring the database in line with the files. Every folder is parsed, so a reference into another
     * folder resolves, but only `folders` (default: all) is applied.
     */
    export async function syncFromCode(opts: { folders?: string[] } = {}): Promise<AssetSyncReport> {
        assertStarted();
        await warmUserAssetCaches();
        const report: AssetSyncReport = { created: [], updated: [], unchanged: [], reset: [], kept: [], deleted: [], detached: [] };

        const assetFiles = files.scan();
        const present = new Set(files.folders());
        if (present.size == 0)
            throw new Error(`${options!.root} has no sync folders. A missing checkout would delete every synced asset, so nothing was synced.`);
        for (const f of opts.folders ?? [])
            if (!present.has(f))
                throw new Error(`There is no '${f}' directory in ${options!.root}`);
        const scope = new Set(opts.folders ?? present);

        await syncing().withValue(true, () => Transaction.create(async () => {
            const folders = await ensureFolders([...present]);
            const { materialized, existing } = await materialize(assetFiles);
            const ctx = await UserAssetsImporter.fromXmlContext(false, materialized);

            const toSave: { entity: IUserAssetEntity; config: UserAssetTypeConfig; label: string; bucket: string[] }[] = [];
            for (const file of assetFiles.filter(f => scope.has(f.folder))) {
                const config = UserAssetsImporter.configFor(file.elementName);
                const entity = materialized.get(file.guid)!;
                const label = `${file.folder}/${file.baseName}`;
                const before = existing.get(file.guid);
                const folder = folders.get(file.folder)!;
                const m = entity.mixin(CodeSyncMixin);

                if (before != undefined) {
                    if (await isSameAsFile(before, file)) {
                        const wasModified = m.codeSyncState === CodeSyncState.ModifiedInDb;
                        if (m.syncFolder?.is(folder) && m.codeSyncState === CodeSyncState.InSync) {
                            report.unchanged.push(label);
                            continue;
                        }
                        stamp(m, folder);
                        toSave.push({ entity, config, label, bucket: wasModified ? report.reset : report.updated });
                        continue;
                    }
                    if (m.codeSyncState === CodeSyncState.ModifiedInDb) {
                        report.kept.push(label);
                        continue;
                    }
                }

                await config.fromXml(entity, file.obj, { ...ctx, binary: files.reader(file.folder) });
                stamp(m, folder);
                toSave.push({ entity, config, label, bucket: before == undefined ? report.created : report.updated });
            }

            // Filled first, saved after: a new asset is often saved as a REFERENCE of another one first.
            for (const s of toSave) {
                if (s.entity.isNew || isGraphModified(s.entity))
                    await s.config.save(s.entity);
                s.bucket.push(s.label);
            }

            await removeMissing(assetFiles, present, scope, opts.folders == undefined, report);
        }));

        return report;
    }

    /** One asset back to its file, whatever its state. */
    async function discardDbChanges(entity: IUserAssetEntity): Promise<void> {
        assertStarted();
        await warmUserAssetCaches();
        const guid = String(entity.id);
        const assetFiles = files.scan();
        const file = assetFiles.find(f => f.guid === guid);
        const folderName = (await entity.mixin(CodeSyncMixin).syncFolder!.retrieve()).name;
        if (file == undefined)
            throw new Error(CodeSyncMessage.NoFileForThisAssetIn0.niceToString(folderName));

        await syncing().withValue(true, () => Transaction.create(async () => {
            const folders = await ensureFolders([file.folder]);
            const { materialized } = await materialize(assetFiles);
            materialized.set(guid, entity);
            const ctx = await UserAssetsImporter.fromXmlContext(false, materialized);
            await UserAssetsImporter.configFor(file.elementName).fromXml(entity, file.obj, { ...ctx, binary: files.reader(file.folder) });
            const m = entity.mixin(CodeSyncMixin);
            m.syncFolder = folders.get(file.folder)!;
            m.codeSyncState = CodeSyncState.InSync;
            await entity.save();
        }));
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

    // Every file's asset, loaded or new, so a reference to any of them resolves.
    async function materialize(assetFiles: AssetFile[]): Promise<{ materialized: Map<string, IUserAssetEntity>; existing: Map<string, IUserAssetEntity> }> {
        const materialized = new Map<string, IUserAssetEntity>();
        const existing = new Map<string, IUserAssetEntity>();
        for (const file of assetFiles) {
            const config = UserAssetsImporter.configFor(file.elementName);
            const loaded = await config.load(file.guid);
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
    async function removeMissing(assetFiles: AssetFile[], present: Set<string>, scope: Set<string>, syncAll: boolean, report: AssetSyncReport): Promise<void> {
        const inFiles = new Set(assetFiles.map(f => f.guid));
        const folderNames = new Map((await table(SyncFolderEntity).toArray() as SyncFolderEntity[]).map(f => [String(f.id), f.name]));

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
                if (m.codeSyncState === CodeSyncState.ModifiedInDb) {
                    m.syncFolder = null;
                    m.codeSyncState = null;
                    await row.save();
                    report.detached.push(label);
                } else {
                    await row.delete();
                    report.deleted.push(label);
                }
            }
        }
    }

    // ---- Production → repository -----------------------------------------------------------------------

    /** Every asset of the folder, written as the development writer would: `<folder>/<name>.<Type>.xml` + sidecars. */
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
                const exported = await exportAsset(row, baseName);
                entries[`${name}/${baseName}.xml`] = encoder.encode(exported.xml.endsWith("\n") ? exported.xml : exported.xml + "\n");
                for (const [rel, bytes] of exported.sidecars)
                    entries[`${name}/${rel}`] = bytes;
            }
        }

        return { name: `${name}.zip`, bytes: zipSync(entries) };
    }

    function startServer(ws: WebBuilder): void {
        ws.get("/api/assetSync/zip/:folderId",
            { params: CustomType<{ folderId: string }>() },
            async (req, res) => {
                if (!(await PermissionLogic.isAuthorized(UserAssetPermission.UserAssetsToXML)))
                    throw new UnauthorizedAccessException(`Not authorized for '${UserAssetPermission.UserAssetsToXML.key}'`);
                const folder = await table(SyncFolderEntity).filter(f => f.id == SyncFolderEntity.parseId(req.params.folderId)).single();
                const zip = await zipFolder(folder.toLite());
                res.setHeader("Content-Disposition", attachmentDisposition(zip.name));
                res.type("application/zip").send(Buffer.from(zip.bytes));
            });
    }

    function assertStarted(): void {
        if (options == undefined)
            throw new Error("AssetSyncLogic.start was not called");
    }
}

// Attribute order is not significant; element order is.
function sameXml(a: unknown, b: unknown): boolean {
    if (a === b)
        return true;
    if (Array.isArray(a) || Array.isArray(b))
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameXml(x, b[i]));
    if (a == null || b == null || typeof a !== "object" || typeof b !== "object")
        return a != null && b != null && String(a) === String(b);
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every(k => sameXml((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
    return a != undefined && a.length === b.length && a.every((x, i) => x === b[i]);
}
