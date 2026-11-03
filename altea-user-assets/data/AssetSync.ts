import { reflect, init } from "@altea/altea/data/reflection";
import { Entity, MixinEntity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { entity, quoted, uniqueIndex } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import type { ExecuteSymbol } from "@altea/altea/data/operations";
import { msg } from "@altea/altea/data/utils/localization";
import type { IUserAssetEntity } from "./UserAssets";

// User-asset CODE SYNC: an asset with a sync folder is controlled by an XML file in the app's repository —
// see port/UserAssetCodeSync.md. The file IS the code version; nothing here stores a copy of it.

/** A directory under the app's asset root, grouping the assets it holds. Created by the sync. */
@entity("String", "Master", { lowPopulation: true })
export class SyncFolderEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ min: 1, max: 100 })
    name: string;

    @quoted toString(): string { return this.name; }
}

export namespace SyncFolderOperation {
    /** Only where saves write files: elsewhere a folder exists because its directory does. */
    export const Save: ExecuteSymbol<SyncFolderEntity> = init();
    export const SyncFromCode: ExecuteSymbol<SyncFolderEntity> = init();
}

export enum CodeSyncState {
    InSync,
    ModifiedInDb,
}

@reflect
export class CodeSyncMixin extends MixinEntity {
    syncFolder: Lite<SyncFolderEntity> | null;
    /** Null exactly when there is no sync folder. */
    codeSyncState: CodeSyncState | null;
}

export namespace CodeSyncOperation {
    /** Re-apply the asset's file, dropping whatever was changed in the database. */
    export const DiscardDbChanges: ExecuteSymbol<IUserAssetEntity> = init();
}

export const CodeSyncMessage = {
    ControlledByCode: msg("Controlled by code"),
    ModifiedInTheDatabase: msg("Modified in the database"),
    InSyncWithCode: msg("In sync with code"),
    APersonalAssetInASyncFolderWillBeOwnedByTheSameUserInEveryEnvironment: msg("A personal asset in a sync folder will be owned by the same user in every environment, where that user may not exist."),
    DownloadZip: msg("Download zip"),
    TheAssetHasNoSyncFolder: msg("The asset has no sync folder"),
    _0References1WhichHasNoSyncFolder: msg("{0} references {1}, which has no sync folder"),
    NoFileForThisAssetIn0: msg("There is no file for this asset in {0}"),
};
