import {
    CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand,
    PutObjectCommand, type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { HeavyProfiler } from "@altea/altea/server/profiler/heavyProfiler";
import {
    calculateMD5Hash, FileTypeAlgorithmBase, mimeType, SuffixGenerators,
    type FileTypeAlgorithmBaseOptions, type IFilePath, type IFileTypeAlgorithm,
} from "@altea/altea-files/server/FileTypeAlgorithm.server";

// Port of Signum.Files.S3's S3FileTypeAlgorithm.cs — an IFileTypeAlgorithm whose store is an S3 bucket (or
// anything speaking S3: MinIO, Ceph, an OpenShift OBC). Registered like the local-folder one:
//
//   const client = toS3Client({ endpoint: "http://localhost:9000", accessKey: …, secretKey: … })!;
//   FileTypeLogic.register(MyFileType.Attachment, new S3FileTypeAlgorithm({
//       client,
//       endpoint: "http://localhost:9000",
//       getBucketNameOrSubDirectory: () => "eastwind-attachments",
//       createBucketIfNotExists: true,
//   }));
//
// Signum's TWO addressing modes are kept as they are, because they are the reason this class is not just
// "bucket + key":
//   • bucket mode        — `getBucketNameOrSubDirectory` names the BUCKET, the key is the suffix.
//   • shared-bucket mode — `sharedBucketName` is the one bucket everybody shares and
//                          `getBucketNameOrSubDirectory` becomes a key PREFIX (a per-tenant folder).
// Note what that means for the stored row: `suffix` holds the key WITHOUT the prefix, so moving a tenant
// between modes does not rewrite its rows (`getBucketAndKey` re-derives the full key on every access).
//
// altea divergences, documented inline:
//  - `AWSSDK.S3` (C#) -> `@aws-sdk/client-s3` (v3, for JS): every `client.XxxAsync(...)` becomes
//    `client.send(new XxxCommand({...}))`, and `GetObjectResponse.ResponseStream` becomes
//    `response.Body.transformToByteArray()`.
//  - `SaveFile` / `SaveFileAsync` (Signum ships both) collapse into altea's TWO-PHASE save: `prepareSuffix`
//    (SYNC — validate, hash, assign the key, so the row can be INSERTed with it) and `writePrepared` (ASYNC —
//    PUT the bytes on `Transaction.preRealCommit`, so a rollback leaves no orphan object). See
//    @altea/altea-files' FilePathEmbeddedLogic.
//  - `RenameAlgorithm` is REFUSED, not silently ignored (see the constructor): the collision probe is a
//    network round-trip and altea assigns the key in a SYNCHRONOUS hook before the INSERT, so a rename decided
//    later could not be written back to a row that already carries the old key. Signum defaults it to null
//    here too; the default `calculateKey` puts a GUID in the path, which is what makes it unnecessary.
//  - `GetFullWebPath` with `PreSignedUrl` cannot be served by the SYNC `fullWebPath`, because SigV4
//    presigning is asynchronous in the v3 SDK — so it lives in `presignedUrl()` and `fullWebPath` says so
//    rather than quietly returning nothing. `DirectUrl` is unaffected. Signum's `https:` -> `http:` fixup is
//    not needed: v3 signs against the endpoint's own scheme.
//  - `readAllBytesSync` THROWS: there is no synchronous read of a remote object. The one altea caller that
//    needs it is BigStringLogic (from the synchronous `retrieved` event), so a BigString column must not be
//    backed by this store.
//  - Signum's chunked-upload API (StartUpload / UploadChunk / FinishUpload / AbortUpload — an S3 multipart
//    upload) is not ported, because altea-files has no chunk protocol at all: a file reaches the server inside
//    the entity graph. `CreateMultipartUploadCommand` & friends are what to reach for if it ever lands.
//  - `MoveFile` throws in Signum too (S3 has no rename); kept as-is.
//  - `DoesS3BucketExistV2Async` becomes a `HeadBucketCommand` (what it does under the covers).

/** Signum's S3WebDownload — how (and whether) a public URL to the object is handed out. */
export enum S3WebDownload {
    /** A short-lived SigV4-signed GET URL. Asynchronous — see `presignedUrl`. */
    PreSignedUrl,
    /** The plain object URL. Only useful for a PUBLIC bucket. */
    DirectUrl,
    /** No public URL: the file is only reachable through altea's owner-addressed download route. */
    None,
}

export interface S3FileTypeAlgorithmOptions extends FileTypeAlgorithmBaseOptions {
    /** Signum's `IAmazonS3 Client` (see `toS3Client`). */
    client: S3Client;
    /** The one shared bucket, in shared-bucket mode (Signum's SharedBucketName). Null for bucket mode. */
    sharedBucketName?: string | null;
    /** Signum's GetBucketNameOrSubDirectory — the BUCKET in bucket mode, the key PREFIX in shared mode. */
    getBucketNameOrSubDirectory: (fp: IFilePath) => string;
    /** The service URL, used ONLY to build a DirectUrl. Signum reads it back off `AmazonS3Config.ServiceURL`;
     *  in the v3 SDK the resolved endpoint is an async provider, so a synchronous DirectUrl needs the value
     *  that was configured. Omit for real AWS (the virtual-hosted URL is derived from the bucket name). */
    endpoint?: string | null;
    /** Signum's WebDownload (default None). */
    webDownload?: () => S3WebDownload;
    /** Signum's CalculateKey (default Safe.yearMonth_Guid_Filename — its GUID is what makes the refused
     *  RenameAlgorithm unnecessary). */
    calculateKey?: (fp: IFilePath) => string;
    /** Signum's WeakFileReference — the app does not own these objects: never write, never delete. */
    weakFileReference?: boolean;
    /** Signum's CreateBucketIfNotExists. */
    createBucketIfNotExists?: boolean;
    /** How long a presigned URL stays valid, in SECONDS (Signum hard-codes 15 minutes). */
    preSignedUrlExpiresInSeconds?: number;
    /** NOT SUPPORTED — see the header. Declared so that passing one FAILS instead of being ignored. */
    renameAlgorithm?: never;
}

export class S3FileTypeAlgorithm extends FileTypeAlgorithmBase implements IFileTypeAlgorithm {

    readonly client: S3Client;
    readonly sharedBucketName: string | null;
    readonly getBucketNameOrSubDirectory: (fp: IFilePath) => string;
    readonly endpoint: string | null;
    readonly webDownload: () => S3WebDownload;
    readonly calculateKey: (fp: IFilePath) => string;
    readonly weakFileReference: boolean;
    readonly createBucketIfNotExists: boolean;
    readonly preSignedUrlExpiresInSeconds: number;

    constructor(options: S3FileTypeAlgorithmOptions) {
        super(options);

        if (options.renameAlgorithm != undefined)
            throw new Error("S3FileTypeAlgorithm does not support a renameAlgorithm: altea assigns the key"
                + " synchronously, before the owning row is INSERTed, and probing S3 for a colliding object is a"
                + " network round-trip. Use a calculateKey with a GUID in it (the default) — which is what"
                + " Signum recommends for this backend too.");

        this.client = options.client;
        this.sharedBucketName = options.sharedBucketName ?? null;
        this.getBucketNameOrSubDirectory = options.getBucketNameOrSubDirectory;
        this.endpoint = options.endpoint ?? null;
        this.webDownload = options.webDownload ?? (() => S3WebDownload.None);
        this.calculateKey = options.calculateKey ?? SuffixGenerators.Safe.yearMonth_Guid_Filename;
        this.weakFileReference = options.weakFileReference ?? false;
        this.createBucketIfNotExists = options.createBucketIfNotExists ?? false;
        this.preSignedUrlExpiresInSeconds = options.preSignedUrlExpiresInSeconds ?? 15 * 60;
    }

    /** Signum's GetBucketAndKey — resolve the two addressing modes (see the header). */
    getBucketAndKey(fp: IFilePath): { bucket: string; key: string } {
        const suffix = this.assertSuffix(fp);

        if (this.sharedBucketName)
            return { bucket: this.sharedBucketName, key: `${this.getBucketNameOrSubDirectory(fp)}/${suffix}` };

        return { bucket: this.getBucketNameOrSubDirectory(fp), key: suffix };
    }

    // ---- reading -------------------------------------------------------------------------------------

    /** Signum's ReadAllBytes (and OpenRead — a Node caller wants the bytes, not a stream). */
    async readAllBytes(fp: IFilePath): Promise<Uint8Array> {
        using _prof = HeavyProfiler.log("S3 ReadAllBytes", () => fp.suffix ?? "");

        const { bucket, key } = this.getBucketAndKey(fp);
        try {
            const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            if (response.Body == undefined)
                throw new Error("S3 returned no body");
            return await response.Body.transformToByteArray();
        } catch (e) {
            // Signum's `ex.Data["suffix"] = fp.Suffix` — say WHICH object failed.
            throw describe(e, { suffix: fp.suffix ?? undefined, key, bucketName: bucket });
        }
    }

    /** There is no synchronous read of a remote object — see the header. */
    readAllBytesSync(fp: IFilePath): Uint8Array {
        throw new Error(`'${fp.fileName}' lives in S3, which cannot be read synchronously. Use readAllBytes`
            + " (async); a BigString column must not be backed by this store.");
    }

    /** Signum's ExistsObject — a HEAD, so a missing object is a 404 rather than a download. */
    async existsObject(bucket: string, key: string): Promise<boolean> {
        using _prof = HeavyProfiler.log("S3 ExistsObject", () => key);

        try {
            await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
            return true;
        } catch (e) {
            if (isNotFound(e))
                return false;
            throw e;
        }
    }

    // ---- writing -------------------------------------------------------------------------------------

    async saveFile(fp: IFilePath): Promise<void> {
        this.prepareSuffix(fp);
        await this.writePrepared(fp);
    }

    /** The SYNC half (Signum's CalculateKeyWithRenames, minus the rename probe — see the header). */
    prepareSuffix(fp: IFilePath): void {
        if (this.weakFileReference)
            return;

        using _prof = HeavyProfiler.logNoStackTrace("CalculateKey");

        this.validateFile(fp);

        const bytes = fp.binaryFile;
        if (bytes == null)
            throw new Error(`FilePathEmbedded '${fp.fileName}' has no binaryFile to save`);

        fp.prepareForSave(calculateMD5Hash(bytes));

        const key = this.calculateKey(fp);
        if (!key)
            throw new Error("Key not set");

        fp.suffix = key.replace(/\\/g, "/").replace(/^\/+/, "");
    }

    /** The ASYNC half (Signum's SaveFileAsync body): create the bucket if asked, then PUT the object. */
    async writePrepared(fp: IFilePath): Promise<void> {
        if (this.weakFileReference || fp.binaryFile == null)
            return;

        using _prof = HeavyProfiler.log("S3 SaveFile", () => fp.suffix ?? "");

        const { bucket, key } = this.getBucketAndKey(fp);
        const bytes = fp.binaryFile;

        await this.ensureBucketExists(bucket);

        try {
            await this.client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: bytes,
                ContentType: mimeType(fp.fileName) ?? "application/octet-stream",
            }));

            fp.cleanBinaryFile();
        } catch (e) {
            throw describe(e, { suffix: fp.suffix ?? undefined, key, bucketName: bucket });
        }
    }

    /** Signum's MoveFile — S3 has no rename, and Signum throws here too. */
    async moveFile(from: IFilePath, _to: IFilePath, _createTargetFolder: boolean): Promise<void> {
        if (this.weakFileReference)
            return;

        throw new Error(`Moving '${from.fileName}' is not implemented for S3`
            + " (a move would be a server-side copy followed by a delete).");
    }

    async deleteFiles(files: readonly IFilePath[]): Promise<void> {
        if (this.weakFileReference)
            return;

        using _prof = HeavyProfiler.log("S3 DeleteFiles");

        for (const fp of files) {
            const { bucket, key } = this.getBucketAndKey(fp);
            await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        }
    }

    async deleteFilesIfExist(files: readonly IFilePath[]): Promise<void> {
        if (this.weakFileReference)
            return;

        using _prof = HeavyProfiler.log("S3 DeleteFilesIfExist");

        for (const fp of files) {
            if (fp.suffix == null)
                continue;

            const { bucket, key } = this.getBucketAndKey(fp);
            try {
                await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
            } catch (e) {
                // Signum swallows everything here (`try { … } catch { }`); narrow it to the one case that
                // legitimately means "already gone", so a permission problem is not hidden as a no-op.
                if (!isNotFound(e))
                    throw e;
            }
        }
    }

    // ---- addressing ----------------------------------------------------------------------------------

    /** Signum's GetFullPhysicalPath — an object has none. */
    fullPhysicalPath(_fp: IFilePath): string | undefined {
        return undefined;
    }

    /** Signum's GetFullWebPath, minus the presigned branch (see the header and `presignedUrl`). */
    fullWebPath(fp: IFilePath): string | undefined {
        const download = this.webDownload();
        if (download === S3WebDownload.None)
            return undefined;

        if (download === S3WebDownload.PreSignedUrl)
            throw new Error("S3WebDownload.PreSignedUrl cannot be served synchronously: SigV4 presigning is"
                + " asynchronous in the v3 SDK. Call presignedUrl(fp) instead.");

        return this.directUrl(fp);
    }

    /** The `DirectUrl` half of Signum's GetFullWebPath: path-style against a configured endpoint, else the
     *  AWS virtual-hosted form. */
    directUrl(fp: IFilePath): string {
        const { bucket, key } = this.getBucketAndKey(fp);

        const endpoint = this.endpoint?.replace(/\/+$/, "");
        return endpoint
            ? `${endpoint}/${bucket}/${encodeKey(key)}`
            : `https://${bucket}.s3.amazonaws.com/${encodeKey(key)}`;
    }

    /** The `PreSignedUrl` half of Signum's GetFullWebPath, as its own async method (see the header). */
    async presignedUrl(fp: IFilePath): Promise<string> {
        const { bucket, key } = this.getBucketAndKey(fp);

        return await getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }),
            { expiresIn: this.preSignedUrlExpiresInSeconds });
    }

    // ---- internals -----------------------------------------------------------------------------------

    // Signum remembers only the last bucket it created, so the existence round-trip happens once per bucket
    // instead of once per file.
    private lastCreatedBucket?: string;

    private async ensureBucketExists(bucket: string): Promise<void> {
        if (!this.createBucketIfNotExists || this.lastCreatedBucket === bucket)
            return;

        using _prof = HeavyProfiler.logNoStackTrace("S3 CreateBucketIfNotExists");

        try {
            if (!await this.existsBucket(bucket))
                await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
        } catch (e) {
            // Signum swallows BucketAlreadyOwnedByYou / BucketAlreadyExists: two hosts racing to create it
            // is not an error.
            const name = (e as { name?: string }).name;
            if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists")
                throw e;
        }
        this.lastCreatedBucket = bucket;
    }

    /** Signum's `AmazonS3Util.DoesS3BucketExistV2Async`. */
    private async existsBucket(bucket: string): Promise<boolean> {
        try {
            await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
            return true;
        } catch (e) {
            if (isNotFound(e))
                return false;
            throw e;
        }
    }

    private assertSuffix(fp: IFilePath): string {
        if (fp.suffix == null)
            throw new Error(`FilePathEmbedded '${fp.fileName}' has no suffix (it was never saved)`);
        return fp.suffix;
    }
}

/** Signum's `catch (AmazonS3Exception ex) when (ex.StatusCode == HttpStatusCode.NotFound)`. S3 answers a HEAD
 *  of a missing key with a bare 404 and no error code, which is why the status is what gets checked. */
function isNotFound(error: unknown): boolean {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e.$metadata?.httpStatusCode === 404 || e.name === "NotFound" || e.name === "NoSuchKey"
        || e.name === "NoSuchBucket";
}

/** Signum's `ex.Data.Add(...)` — attach the identifying context to the error being rethrown. */
function describe(error: unknown, data: Record<string, string | undefined>): unknown {
    if (error instanceof Error)
        Object.assign(error, { alteaData: { ...(error as { alteaData?: object }).alteaData, ...data } });
    return error;
}

/** A key is a PATH (`tenant/2026-08/<guid>/name.png`): each segment is encoded, the separators are not. */
function encodeKey(key: string): string {
    return key.split("/").map(encodeURIComponent).join("/");
}
