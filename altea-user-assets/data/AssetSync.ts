import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, MixinEntity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { entity, isReadOnly, quoted, uniqueIndex } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import type { ExecuteSymbol } from "@altea/altea/data/operations";
import { msg } from "@altea/altea/data/utils/localization";
import type { IUserAssetEntity } from "./UserAssets";

// User-asset CODE SYNC: an asset with a sync folder is controlled by an XML file in the app's repository —
// see port/UserAssetCodeSync.md. The file IS the code version; nothing here stores a copy of it.

/** A directory under the app's asset root, grouping the assets it holds. Created by the sync. */
@entity("String", "Master", { lowPopulation: true })
export class SyncFolderEntity extends Entity {
    /** The directory's name. Not renamable: the files of the assets it holds live under it. */
    @uniqueIndex
    @stringLengthValidator({ min: 1, max: 100 })
    @isReadOnly<SyncFolderEntity>(f => f.isNew ? undefined : true)
    name: string;

    @quoted toString(): string { return this.name; }
}

export namespace SyncFolderOperation {
    export const Save: ExecuteSymbol<SyncFolderEntity> = init();
    export const SyncFromCode: ExecuteSymbol<SyncFolderEntity> = init();
}

@reflect
export class CodeSyncMixin extends MixinEntity {
    syncFolder: Lite<SyncFolderEntity> | null;
    /** An intent, not a state: the sync must not overwrite or delete this asset. Whether it differs from
     *  its file is always computed, never stored. */
    keepOnSync: boolean = false;
}

export namespace CodeSyncOperation {
    /** Re-apply the asset's file, dropping whatever was changed in the database. */
    export const DiscardDbChanges: ExecuteSymbol<IUserAssetEntity> = init();
}

export const CodeSyncMessage = {
    ControlledByCode: msg("Controlled by code"),
    AssetSync: msg("Asset sync"),
    KeepOnSync: msg("Keep on sync"),
    Identical: msg("Identical to code"),
    DiffersFromCode: msg("Differs from code"),
    NotInCode: msg("Not in code"),
    NotInTheDatabase: msg("Not in the database"),
    WillBeOverwrittenOnTheNextSync: msg("will be overwritten on the next sync"),
    WillBeDeletedOnTheNextSync: msg("will be deleted on the next sync"),
    WillBeCreatedOnTheNextSync: msg("will be created on the next sync"),
    KeptOnTheNextSync: msg("kept on the next sync"),
    APersonalAssetInASyncFolderWillBeOwnedByTheSameUserInEveryEnvironment: msg("A personal asset in a sync folder will be owned by the same user in every environment, where that user may not exist."),
    DownloadZip: msg("Download zip"),
    SyncFromCode: msg("Sync from code"),
    ApplyFile: msg("Apply file"),
    WriteFile: msg("Write file"),
    RewriteFiles: msg("Rewrite files"),
    ShowDifferences: msg("Show differences"),
    Database: msg("Database"),
    File: msg("File"),
    KeepThroughTheNextSync: msg("Keep through the next sync"),
    ChangesHereAreNotWrittenToFiles: msg("Changes here are not written to files: download the folder zip to bring them to code."),
    TheAssetHasNoSyncFolder: msg("The asset has no sync folder"),
    _0References1WhichHasNoSyncFolder: msg("{0} references {1}, which has no sync folder"),
    NoFileForThisAssetIn0: msg("There is no file for this asset in {0}"),
    FilesAreNotWrittenHere: msg("Files are not written here (AUTO_SAVE_ASSET_FILES is off)"),
    Created: msg("Created"),
    Updated: msg("Updated"),
    Unchanged: msg("Unchanged"),
    NoLongerKept: msg("No longer kept (identical to code)"),
    Kept: msg("Kept"),
    Deleted: msg("Deleted"),
    Rewritten: msg("Rewritten"),
};
