import type { uuid } from "@altea/altea/data/basics";

// Wire DTOs of the asset-sync panel and widget — see port/UserAssetCodeSync.md.

/** Always computed by applying the file onto a copy of the row; never stored. */
export type AssetComparison = "Identical" | "DiffersFromCode" | "NotInCode" | "NotInDatabase";

export interface AssetSyncStatus {
    /** The asset's XML element name, which is its clean type name. */
    type: string;
    guid: uuid;
    name: string;
    folder: string;
    comparison: AssetComparison;
    keepOnSync: boolean;
}

export interface AssetSyncInfo {
    writeFiles: boolean;
    folders: string[];
}

export interface AssetSyncDiff {
    database: string | null;
    file: string | null;
}

export interface AssetSyncReport {
    created: string[];
    updated: string[];
    unchanged: string[];
    /** Kept on sync, but identical to the file: the flag is cleared. */
    reset: string[];
    /** Kept on sync and different from the file: the database version stays. */
    kept: string[];
    deleted: string[];
    /** Kept on sync with no file: left as it is. */
    notInCode: string[];
}
