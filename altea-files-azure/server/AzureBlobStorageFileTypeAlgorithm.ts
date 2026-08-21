import * as path from "node:path";
import {
    type BlobHTTPHeaders, type BlobGetPropertiesResponse, BlobSASPermissions, type ContainerClient,
    generateBlobSASQueryParameters, StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import { FileMessage } from "@altea/altea-files/data/Files";
import {
    calculateMD5Hash, FileTypeAlgorithmBase, mimeType, SuffixGenerators,
    type FileTypeAlgorithmBaseOptions, type IFilePath, type IFileTypeAlgorithm,
} from "@altea/altea-files/server/FileTypeAlgorithm.server";

// Port of Signum.Files.AzureBlobs' AzureBlobStorageFileTypeAlgorithm.cs — an IFileTypeAlgorithm whose store
// is an Azure Blob Storage container. Registered exactly like the local-folder one:
//
//   FileTypeLogic.register(MyFileType.Attachment, new AzureBlobStorageFileTypeAlgorithm({
//       getClient: () => containerClient,
//       createBlobContainerIfNotExists: true,
//   }));
//
// altea divergences, documented inline:
//  - `Azure.Storage.Blobs` (C#) -> `@azure/storage-blob` (the same SDK, for JS): BlobContainerClient becomes
//    ContainerClient, `blobClient.Upload(stream, headers)` becomes `blockBlobClient.upload(body, length,
//    { blobHTTPHeaders })`, `client.GetBlobs(new GetBlobsOptions { Prefix })` becomes `listBlobsFlat({ prefix })`.
//  - Signum reads the account key out of the client by COMPILED REFLECTION (an Expression over the private
//    `ClientConfiguration.SharedKeyCredential`) so the app needn't repeat its credentials just to sign a SAS
//    token. The JS SDK exposes the same thing publicly as `StorageClient.credential`, so `fullWebPath` reads
//    it straight off the client — same intent, no reflection needed.
//  - `SaveFile` / `SaveFileAsync` (Signum ships both, one sync one async) collapse into altea's TWO-PHASE
//    save: `prepareSuffix` (SYNC — validate, hash, assign the suffix, so the row can be INSERTed with it)
//    and `writePrepared` (ASYNC — upload the bytes on `Transaction.preRealCommit`, so a rollback leaves no
//    orphan blob). See @altea/altea-files' FilePathEmbeddedLogic.
//  - `RenameAlgorithm` is REFUSED, not silently ignored (see the constructor): the collision probe is a
//    network round-trip, and altea assigns the suffix in a SYNCHRONOUS hook before the INSERT, so a rename
//    decided later could not be written back to a row that already carries the old suffix. Signum defaults it
//    to null here anyway and says why on the field — "ExistBlob is too slow, consider using CalculateSuffix
//    with a GUID!" — which is exactly what the default `calculateSuffix` does.
//  - `readAllBytesSync` THROWS: there is no synchronous read of a remote blob. The one altea caller that
//    needs it is BigStringLogic (from the synchronous `retrieved` event), so a BigString column must not be
//    backed by this store.
//  - Signum's chunked-upload API (StartUpload / UploadChunk / FinishUpload / AbortUpload — stage blocks, then
//    commit a block list) is not ported, because altea-files has no chunk protocol at all: a file reaches the
//    server inside the entity graph. `stageBlock` / `commitBlockList` are what to reach for if it ever lands.
//  - `MoveFile` throws in Signum too (blob storage has no rename); kept as-is.
//  - `GetAsString` (download a blob as text) has no caller and is not ported.

/** Signum's BlobAction — is the blob served for viewing in the browser, or as a download? */
export enum BlobAction {
    Open,
    Download,
}

/** Signum's AzureWebDownload — how (and whether) a public URL to the blob is handed out. */
export enum AzureWebDownload {
    /** The container's own URL. Only useful for a PUBLIC container. */
    DirectUrl,
    /** A short-lived read-only Shared Access Signature appended to the blob URL. */
    SASToken,
    /** No public URL: the file is only reachable through altea's owner-addressed download route. */
    None,
}

/** Signum's AzureDefenderPollingOptions — how long to wait for Microsoft Defender's malware verdict. */
export interface AzureDefenderPollingOptions {
    /** Signum's TotalWaitTime, in milliseconds (default 5 minutes). */
    totalWaitTime?: number;
    /** Signum's PollInterval, in milliseconds (default 3 seconds). */
    pollInterval?: number;
}

/** Signum's MicrosoftDefenderMaliciousFileFoundException. */
export class MicrosoftDefenderMaliciousFileFoundError extends Error {
    constructor(fileName: string) {
        super(FileMessage.File0ContainsAThreatBy1.niceToString(fileName, "Microsoft Defender"));
        this.name = "MicrosoftDefenderMaliciousFileFoundError";
    }
}

export interface AzureBlobStorageFileTypeAlgorithmOptions extends FileTypeAlgorithmBaseOptions {
    /** Signum's GetClient — the container this file's bytes live in (a multi-tenant app picks per file). */
    getClient: (fp: IFilePath) => ContainerClient;
    /** Signum's WebDownload (default None). */
    webDownload?: () => AzureWebDownload;
    /** Signum's CalculateSuffix (default Safe.yearMonth_Guid_Filename — its GUID is what makes the refused
     *  RenameAlgorithm unnecessary). */
    calculateSuffix?: (fp: IFilePath) => string;
    /** Signum's WeakFileReference — the app does not own these blobs: never write, never delete. */
    weakFileReference?: boolean;
    /** Signum's CreateBlobContainerIfNotExists. */
    createBlobContainerIfNotExists?: boolean;
    /** Signum's GetBlobAction (default Download, or Open when `onlyImages` is set). */
    getBlobAction?: (fp: IFilePath) => BlobAction;
    /** Signum's SASTokenExpires, in milliseconds (default 15 minutes). */
    sasTokenExpires?: (fp: IFilePath) => number;
    /** Signum's GetCacheControl — the `Cache-Control` stamped on the blob. */
    getCacheControl?: (fp: IFilePath) => string | null;
    /** Signum's AzureDefenderPolling — when set, an upload waits for the malware verdict (see the header). */
    azureDefenderPolling?: (fp: IFilePath) => AzureDefenderPollingOptions | null;
    /** NOT SUPPORTED — see the header. Declared so that passing one FAILS instead of being ignored. */
    renameAlgorithm?: never;
}

export class AzureBlobStorageFileTypeAlgorithm extends FileTypeAlgorithmBase implements IFileTypeAlgorithm {

    readonly getClient: (fp: IFilePath) => ContainerClient;
    readonly webDownload: () => AzureWebDownload;
    readonly calculateSuffix: (fp: IFilePath) => string;
    readonly weakFileReference: boolean;
    readonly createBlobContainerIfNotExists: boolean;
    readonly sasTokenExpires: (fp: IFilePath) => number;
    readonly getCacheControl?: (fp: IFilePath) => string | null;
    readonly azureDefenderPolling?: (fp: IFilePath) => AzureDefenderPollingOptions | null;

    private readonly getBlobActionValue: (fp: IFilePath) => BlobAction;

    constructor(options: AzureBlobStorageFileTypeAlgorithmOptions) {
        super(options);

        if (options.renameAlgorithm != undefined)
            throw new Error("AzureBlobStorageFileTypeAlgorithm does not support a renameAlgorithm: altea"
                + " assigns the suffix synchronously, before the owning row is INSERTed, and probing Azure for a"
                + " colliding blob is a network round-trip. Use a calculateSuffix with a GUID in it (the"
                + " default) — which is what Signum recommends for this backend too.");

        this.getClient = options.getClient;
        this.webDownload = options.webDownload ?? (() => AzureWebDownload.None);
        this.calculateSuffix = options.calculateSuffix ?? SuffixGenerators.Safe.yearMonth_Guid_Filename;
        this.weakFileReference = options.weakFileReference ?? false;
        this.createBlobContainerIfNotExists = options.createBlobContainerIfNotExists ?? false;
        this.sasTokenExpires = options.sasTokenExpires ?? (() => 15 * 60 * 1000);
        this.getCacheControl = options.getCacheControl;
        this.azureDefenderPolling = options.azureDefenderPolling;

        // Signum's `override bool OnlyImages` setter: an image store serves its files INLINE.
        this.getBlobActionValue = options.getBlobAction
            ?? (this.onlyImages ? () => BlobAction.Open : () => BlobAction.Download);
    }

    /** Signum's GetBlobAction. */
    getBlobAction(fp: IFilePath): BlobAction {
        return this.getBlobActionValue(fp);
    }

    // ---- reading -------------------------------------------------------------------------------------

    /** Signum's GetProperties — the blob's metadata (length, content type, ETag, …). */
    async getProperties(fp: IFilePath): Promise<BlobGetPropertiesResponse> {
        using _prof = HeavyProfiler.log("AzureBlobStorage GetProperties", () => fp.suffix ?? "");

        return await this.getClient(fp).getBlobClient(this.assertSuffix(fp)).getProperties();
    }

    /** Signum's ReadAllBytes (and OpenRead — a Node caller wants the bytes, not a stream). */
    async readAllBytes(fp: IFilePath): Promise<Uint8Array> {
        using _prof = HeavyProfiler.log("AzureBlobStorage ReadAllBytes", () => fp.suffix ?? "");

        const suffix = this.assertSuffix(fp);
        try {
            const buffer = await this.getClient(fp).getBlobClient(suffix).downloadToBuffer();
            return new Uint8Array(buffer);
        } catch (e) {
            // Signum's `ex.Data["suffix"] = fp.Suffix` — say WHICH blob failed.
            throw describe(e, { suffix });
        }
    }

    /** There is no synchronous read of a remote blob — see the header. */
    readAllBytesSync(fp: IFilePath): Uint8Array {
        throw new Error(`'${fp.fileName}' lives in Azure Blob Storage, which cannot be read synchronously.`
            + " Use readAllBytes (async); a BigString column must not be backed by this store.");
    }

    // ---- writing -------------------------------------------------------------------------------------

    async saveFile(fp: IFilePath): Promise<void> {
        this.prepareSuffix(fp);
        await this.writePrepared(fp);
    }

    /** The SYNC half (Signum's CalculateSuffixWithRenames, minus the rename probe — see the header). */
    prepareSuffix(fp: IFilePath): void {
        if (this.weakFileReference)
            return;

        using _prof = HeavyProfiler.logNoStackTrace("CalculateSuffix");

        this.validateFile(fp);

        const bytes = fp.binaryFile;
        if (bytes == null)
            throw new Error(`FilePathEmbedded '${fp.fileName}' has no binaryFile to save`);

        fp.prepareForSave(calculateMD5Hash(bytes));

        const suffix = this.calculateSuffix(fp);
        if (!suffix)
            throw new Error("Suffix not set");

        fp.suffix = suffix.replace(/\\/g, "/").replace(/^\/+/, "");
    }

    /** The ASYNC half (Signum's SaveFileAsync body): create the container if asked, upload, then wait for
     *  Defender's verdict if that is configured. */
    async writePrepared(fp: IFilePath): Promise<void> {
        if (this.weakFileReference || fp.binaryFile == null)
            return;

        using _prof = HeavyProfiler.log("AzureBlobStorage SaveFile", () => fp.suffix ?? "");

        const client = this.getClient(fp);
        const suffix = this.assertSuffix(fp);
        const bytes = fp.binaryFile;

        await this.ensureContainerExists(client);

        try {
            await client.getBlockBlobClient(suffix).upload(bytes, bytes.length, {
                blobHTTPHeaders: this.blobHttpHeaders(fp, this.getBlobAction(fp)),
            });

            const polling = this.azureDefenderPolling?.(fp);
            if (polling != null)
                await checkForDefenderVerdict(client, suffix, fp.fileName, polling);

            fp.cleanBinaryFile();
        } catch (e) {
            throw describe(e, { suffix, accountName: client.accountName, containerName: client.containerName });
        }
    }

    /** Signum's UpdateHttpHeaders — re-stamp content type / disposition / cache control on a stored blob. */
    async updateHttpHeaders(fp: IFilePath): Promise<void> {
        await this.getClient(fp).getBlobClient(this.assertSuffix(fp))
            .setHTTPHeaders(this.blobHttpHeaders(fp, this.getBlobAction(fp)));
    }

    /** Signum's MoveFile — blob storage has no rename, and Signum throws here too. */
    async moveFile(from: IFilePath, _to: IFilePath, _createTargetFolder: boolean): Promise<void> {
        if (this.weakFileReference)
            return;

        throw new Error(`Moving '${from.fileName}' is not implemented for Azure Blob Storage`
            + " (a move would be a server-side copy followed by a delete).");
    }

    async deleteFiles(files: readonly IFilePath[]): Promise<void> {
        if (this.weakFileReference)
            return;

        using _prof = HeavyProfiler.log("AzureBlobStorage DeleteFiles");

        for (const fp of files)
            await this.getClient(fp).deleteBlob(this.assertSuffix(fp));
    }

    async deleteFilesIfExist(files: readonly IFilePath[]): Promise<void> {
        if (this.weakFileReference)
            return;

        using _prof = HeavyProfiler.log("AzureBlobStorage DeleteFilesIfExist");

        for (const fp of files) {
            if (fp.suffix == null)
                continue;
            await this.getClient(fp).getBlobClient(fp.suffix).deleteIfExists();
        }
    }

    // ---- addressing ----------------------------------------------------------------------------------

    /** Signum's GetFullPhysicalPath — a blob has none. */
    fullPhysicalPath(_fp: IFilePath): string | undefined {
        return undefined;
    }

    /** Signum's GetFullWebPath. */
    fullWebPath(fp: IFilePath): string | undefined {
        const download = this.webDownload();
        if (download === AzureWebDownload.None)
            return undefined;

        const client = this.getClient(fp);
        const suffix = this.assertSuffix(fp);

        if (download === AzureWebDownload.DirectUrl)
            return `${client.url}/${encodeSuffix(suffix)}`;

        using _prof = HeavyProfiler.logNoStackTrace("Create SAS Token");

        const credential = client.credential;
        if (!(credential instanceof StorageSharedKeyCredential))
            throw new Error("AzureWebDownload.SASToken needs the ContainerClient to have been built with a"
                + " StorageSharedKeyCredential (an account key): that key is what signs the token. A managed"
                + " identity / token credential can only sign a USER DELEGATION SAS, which needs a key fetched"
                + " from the service first and is therefore asynchronous.");

        const now = Date.now();
        const sas = generateBlobSASQueryParameters({
            containerName: client.containerName,
            // Signum's `Resource = "b"` (a blob, not the container) is implied by passing a blobName.
            blobName: suffix,
            permissions: BlobSASPermissions.from({ read: true }),
            // 5 minutes of backdating, as Signum does: it absorbs clock skew between us and the service.
            startsOn: new Date(now - 5 * 60 * 1000),
            expiresOn: new Date(now + this.sasTokenExpires(fp)),
        }, credential);

        return `${client.url}/${encodeSuffix(suffix)}?${sas.toString()}`;
    }

    // ---- internals -----------------------------------------------------------------------------------

    // Signum keeps the name of the last container it created, so the CreateIfNotExists round-trip happens
    // once per container instead of once per file.
    private containerAlreadyCreated?: string;

    private async ensureContainerExists(client: ContainerClient): Promise<void> {
        if (!this.createBlobContainerIfNotExists || this.containerAlreadyCreated === client.containerName)
            return;

        using _prof = HeavyProfiler.logNoStackTrace("AzureBlobStorage CreateIfNotExists");

        try {
            await client.createIfNotExists();
        } catch (e) {
            // Signum swallows ContainerAlreadyExists: two hosts racing to create it is not an error.
            if ((e as { code?: string }).code !== "ContainerAlreadyExists")
                throw e;
        }
        this.containerAlreadyCreated = client.containerName;
    }

    /** Signum's GetBlobHttpHeaders. A Download is always `application/octet-stream` + `attachment`, so the
     *  browser saves it; an Open gets the file's real content type + `inline`, so the browser shows it. */
    private blobHttpHeaders(fp: IFilePath, action: BlobAction): BlobHTTPHeaders {
        return {
            blobContentType: action === BlobAction.Download
                ? "application/octet-stream"
                : mimeType(fp.fileName) ?? "application/octet-stream",
            blobContentDisposition: action === BlobAction.Download ? "attachment" : "inline",
            blobCacheControl: this.getCacheControl?.(fp) ?? "",
        };
    }

    private assertSuffix(fp: IFilePath): string {
        if (fp.suffix == null)
            throw new Error(`FilePathEmbedded '${fp.fileName}' has no suffix (it was never saved)`);
        return fp.suffix;
    }
}

/** Signum's `BlobExtensions.ExistsBlob`. Kept even though the rename loop that used it is gone: it is the one
 *  question a caller may still want to ask, and Signum's prefix listing is cheaper than a 404-per-probe. */
export async function existsBlob(client: ContainerClient, blobName: string): Promise<boolean> {
    const prefix = blobName.includes("/") ? blobName.slice(0, blobName.lastIndexOf("/")) : "";
    for await (const blob of client.listBlobsFlat({ prefix }))
        if (blob.name === blobName)
            return true;
    return false;
}

/**
 * Signum's CheckBlobStorageFileForWindowsDefenderLogs. Microsoft Defender for Storage scans an uploaded blob
 * and writes its verdict as a blob TAG; this polls for that tag and DELETES the blob if the verdict is bad —
 * or never arrives. The point is that an upload must not be reported as successful while a file Defender has
 * not cleared is sitting in the container.
 */
async function checkForDefenderVerdict(
    client: ContainerClient,
    suffix: string,
    fileName: string,
    options: AzureDefenderPollingOptions,
): Promise<void> {
    const blobClient = client.getBlobClient(suffix);
    const pollInterval = options.pollInterval ?? 3_000;
    let remaining = options.totalWaitTime ?? 5 * 60 * 1000;

    try {
        while (remaining > 0) {
            remaining -= pollInterval;

            const status = (await blobClient.getTags()).tags["Malware Scanning scan result"];
            if (status === "No threats found")
                return;
            if (status === "Malicious")
                throw new MicrosoftDefenderMaliciousFileFoundError(path.basename(fileName));
            if (status != undefined)
                throw new Error(`Unexpected Microsoft Defender scan result '${status}' for '${suffix}'`);

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        // Signum's loop cannot exit any other way, so a verdict that never arrives ends up in the catch
        // below exactly like a bad one — and the blob goes. Made explicit here.
        throw new Error(`Microsoft Defender did not report a scan result for '${suffix}' in time`);
    } catch (e) {
        await blobClient.deleteIfExists();
        throw e;
    }
}

/** Signum's `ex.Data.Add(...)` — attach the identifying context to the error being rethrown. */
function describe(error: unknown, data: Record<string, string | undefined>): unknown {
    if (error instanceof Error)
        Object.assign(error, { alteaData: { ...(error as { alteaData?: object }).alteaData, ...data } });
    return error;
}

/** A suffix is a PATH (`2026-08/<guid>/name.png`): each segment is encoded, the separators are not. */
function encodeSuffix(suffix: string): string {
    return suffix.split("/").map(encodeURIComponent).join("/");
}
