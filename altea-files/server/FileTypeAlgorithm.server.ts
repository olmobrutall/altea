import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Clock } from "@altea/altea/data/utils/clock";
import { FileMessage, toComputerSize, type FilePathEmbedded } from "../data/Files";

// Port of Signum.Files' FileTypeAlgorithm.cs + the FileTypeAlgorithmBase validation and SuffixGenerators
// (FileTypeLogic.cs). A file-type ALGORITHM decides where a file's bytes live and how the row's `suffix`
// (the store-relative path) is generated, and it is the only thing that touches the storage backend.
//
// altea divergences, documented inline:
//  - Only the LOCAL FOLDER backend is ported (Signum's FileTypeAlgorithm). The Azure Blob / S3 backends are
//    separate Signum packages; the interface below is the seam they would plug into.
//  - Signum's chunked-upload API (StartUpload / UploadChunk / FinishUpload / AbortUpload) is NOT ported: a
//    file reaches the server inside the entity graph (the `binaryFile` field), so there is no chunk protocol.
//  - Signum computes the hash in the BinaryFile setter (CryptorEngine.CalculateMD5Hash); altea has no crypto
//    in the isomorphic layer, so `saveFile` computes it here (`calculateMD5Hash`) and stamps it via
//    `prepareForSave`.
//  - `WeakFileReference` (a file the app does not own) and `RenameAlgorithm` are kept — they are pure policy.

// ---- Hash (Signum's CryptorEngine.CalculateMD5Hash) ------------------------------------------------------

/** The base64 MD5 of a file's bytes — Signum computes it in the `BinaryFile` setter, altea on the server (the
 *  isomorphic layer has no crypto). It is the file's CACHE IDENTITY, not just metadata: it rides the download
 *  URL (`FilesClient.fileUrl`) and becomes the response ETag (`FilesServer`), so replacing a file's bytes
 *  changes its URL *and* fails revalidation — which is what lets a download response be cached for a month
 *  (Signum's FilePathLogic.MaxAge) instead of an hour. */
export function calculateMD5Hash(bytes: Uint8Array): string {
    return createHash("md5").update(bytes).digest("base64");
}

/** Signum's IFilePath — what an algorithm needs from the row it is storing (FilePathEmbedded implements it). */
export type IFilePath = FilePathEmbedded;

export interface IFileTypeAlgorithm {
    onlyImages: boolean;
    maxSizeInBytes: number | null;

    /** Write the bytes to the store, filling `suffix` (+ hash / length) on the row. */
    saveFile(fp: IFilePath): Promise<void>;
    /** SYNC half of a save: validate + assign `suffix` / hash / length, WITHOUT touching the disk — so the
     *  row can be INSERTed with its suffix while the bytes are written just before commit (Signum computes the
     *  suffix synchronously inside SaveFileAsync for the same reason). */
    prepareSuffix(fp: IFilePath): void;
    /** ASYNC half: write the (already prepared) bytes and clear them off the row. */
    writePrepared(fp: IFilePath): Promise<void>;
    validateFile(fp: IFilePath): void;
    deleteFiles(files: readonly IFilePath[]): Promise<void>;
    deleteFilesIfExist(files: readonly IFilePath[]): Promise<void>;
    readAllBytes(fp: IFilePath): Promise<Uint8Array>;
    /** Signum's `ReadAllBytes` is sync throughout; altea made the storage interface async (a remote backend
     *  needs it), but a SYNC hook sometimes has no choice — `EntityEvents.retrieved` is synchronous, and
     *  BigStringLogic has to substitute the file's text there. The local-folder backend can oblige; a future
     *  Azure / S3 backend must throw here and the caller has to move to an async seam. */
    readAllBytesSync(fp: IFilePath): Uint8Array;
    moveFile(from: IFilePath, to: IFilePath, createTargetFolder: boolean): Promise<void>;
    /** The absolute path of the file in the store (undefined for a backend without one). */
    fullPhysicalPath(fp: IFilePath): string | undefined;
    /** The public URL of the file, when the store is web-served (Signum's GetFullWebPath). */
    fullWebPath(fp: IFilePath): string | undefined;
}

// ---- Suffix generators (Signum's SuffixGenerators) -------------------------------------------------------

export namespace SuffixGenerators {
    /** No GUID — the resulting path IS guessable. Use only for public/domain files (icons, …). */
    export namespace UNSAFE {
        export const fileName = (fp: IFilePath): string => path.basename(fp.fileName);
        export const year_FileName = (fp: IFilePath): string => path.join(String(year()), path.basename(fp.fileName));
        export const year_Month_FileName = (fp: IFilePath): string => path.join(String(year()), String(month()), path.basename(fp.fileName));
    }

    /** With a GUID in the path, so the stored file name cannot be guessed. */
    export namespace Safe {
        export const year_GuidExtension = (fp: IFilePath): string => path.join(String(year()), randomUUID() + path.extname(fp.fileName));
        export const year_Month_GuidExtension = (fp: IFilePath): string => path.join(String(year()), String(month()), randomUUID() + path.extname(fp.fileName));
        export const yearMonth_Guid_Filename = (fp: IFilePath): string =>
            path.join(`${year()}-${String(month()).padStart(2, "0")}`, randomUUID(), path.basename(fp.fileName));
    }

    function year(): number { return Clock.now.year; }
    function month(): number { return Clock.now.month; }
}

// ---- The local-folder algorithm (Signum's FileTypeAlgorithm) ---------------------------------------------

export interface FileTypeAlgorithmOptions {
    /** Absolute (or cwd-relative) folder the files live in — Signum's GetPhisicalPrefix. */
    physicalPrefix: (fp: IFilePath) => string;
    /** The public URL prefix when the folder is web-served — Signum's GetWebPrefix. */
    webPrefix?: (fp: IFilePath) => string;
    /** How the store-relative path is built (default: Safe.yearMonth_Guid_Filename). */
    calculateSuffix?: (fp: IFilePath) => string;
    /** The app does not own these files: never write, never delete (Signum's WeakFileReference). */
    weakFileReference?: boolean;
    /** Remove the containing folder when it is left empty by a delete. */
    deleteEmptyFolderOnDelete?: boolean;
    /** Rename instead of overwriting when the target exists (Signum's RenameAlgorithm; null = overwrite). */
    renameAlgorithm?: ((suffix: string, num: number) => string) | null;
    onlyImages?: boolean;
    maxSizeInBytes?: number | null;
    onValidateFile?: (fp: IFilePath) => void;
}

export class FileTypeAlgorithm implements IFileTypeAlgorithm {

    readonly physicalPrefix: (fp: IFilePath) => string;
    readonly webPrefix?: (fp: IFilePath) => string;
    readonly calculateSuffix: (fp: IFilePath) => string;
    readonly weakFileReference: boolean;
    readonly deleteEmptyFolderOnDelete: boolean;
    readonly renameAlgorithm: ((suffix: string, num: number) => string) | null;
    onlyImages: boolean;
    maxSizeInBytes: number | null;
    readonly onValidateFile?: (fp: IFilePath) => void;

    constructor(options: FileTypeAlgorithmOptions) {
        this.physicalPrefix = options.physicalPrefix;
        this.webPrefix = options.webPrefix;
        this.calculateSuffix = options.calculateSuffix ?? SuffixGenerators.Safe.yearMonth_Guid_Filename;
        this.weakFileReference = options.weakFileReference ?? false;
        this.deleteEmptyFolderOnDelete = options.deleteEmptyFolderOnDelete ?? true;
        this.renameAlgorithm = options.renameAlgorithm ?? null;
        this.onlyImages = options.onlyImages ?? false;
        this.maxSizeInBytes = options.maxSizeInBytes ?? null;
        this.onValidateFile = options.onValidateFile;
    }

    /** Signum's `DefaultRenameAlgorithm` — "name(2).ext" next to the original. */
    static readonly defaultRenameAlgorithm = (suffix: string, num: number): string =>
        path.join(path.dirname(suffix), `${path.basename(suffix, path.extname(suffix))}(${num})${path.extname(suffix)}`);

    async saveFile(fp: IFilePath): Promise<void> {
        if (this.weakFileReference)
            return;

        this.prepareSuffix(fp);
        await this.writePrepared(fp);
    }

    prepareSuffix(fp: IFilePath): void {
        if (this.weakFileReference)
            return;

        this.validateFile(fp);

        const bytes = fp.binaryFile;
        if (bytes == null)
            throw new Error(`FilePathEmbedded '${fp.fileName}' has no binaryFile to save`);

        // Signum's BinaryFile setter computed length + MD5 hash; do it here (crypto is server-only).
        fp.prepareForSave(calculateMD5Hash(bytes));
        this.calculateSuffixWithRenames(fp);
    }

    async writePrepared(fp: IFilePath): Promise<void> {
        if (this.weakFileReference || fp.binaryFile == null)
            return;

        const full = this.fullPhysicalPath(fp)!;
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, fp.binaryFile);
        fp.cleanBinaryFile();
    }

    validateFile(fp: IFilePath): void {
        if (this.onlyImages) {
            const mime = mimeType(fp.fileName);
            if (mime == null || !mime.startsWith("image/"))
                throw new Error(FileMessage.TheFile0IsNotA1.niceToString(fp.fileName, "image/*"));
        }

        if (this.maxSizeInBytes != null && (fp.binaryFile?.length ?? 0) > this.maxSizeInBytes)
            throw new Error(FileMessage.File0IsTooBigTheMaximumSizeIs1.niceToString(fp.fileName, toComputerSize(this.maxSizeInBytes)));

        this.onValidateFile?.(fp);
    }

    async deleteFiles(files: readonly IFilePath[]): Promise<void> {
        if (this.weakFileReference)
            return;

        for (const fp of files) {
            const full = this.fullPhysicalPath(fp);
            if (full == null)
                continue;
            await fsp.unlink(full);
            await this.deleteEmptyFolder(full);
        }
    }

    async deleteFilesIfExist(files: readonly IFilePath[]): Promise<void> {
        if (this.weakFileReference)
            return;

        for (const fp of files) {
            const full = this.fullPhysicalPath(fp);
            if (full == null || !fs.existsSync(full))
                continue;
            await fsp.unlink(full);
            await this.deleteEmptyFolder(full);
        }
    }

    async readAllBytes(fp: IFilePath): Promise<Uint8Array> {
        return new Uint8Array(await fsp.readFile(this.assertPhysicalPath(fp)));
    }

    readAllBytesSync(fp: IFilePath): Uint8Array {
        return new Uint8Array(fs.readFileSync(this.assertPhysicalPath(fp)));
    }

    private assertPhysicalPath(fp: IFilePath): string {
        const full = this.fullPhysicalPath(fp);
        if (full == null)
            throw new Error(`File '${fp.fileName}' has no physical path`);
        return full;
    }

    async moveFile(from: IFilePath, to: IFilePath, createTargetFolder: boolean): Promise<void> {
        if (this.weakFileReference)
            return;

        const target = this.fullPhysicalPath(to)!;
        if (createTargetFolder)
            await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.rename(this.fullPhysicalPath(from)!, target);
    }

    fullPhysicalPath(fp: IFilePath): string | undefined {
        return fp.suffix == null ? undefined : path.resolve(this.physicalPrefix(fp), fp.suffix);
    }

    fullWebPath(fp: IFilePath): string | undefined {
        if (this.webPrefix == null || fp.suffix == null)
            return undefined;
        return this.webPrefix(fp).replace(/\/$/, "") + "/" + fp.suffix.split(path.sep).join("/");
    }

    // Signum's CalculateSufixWithRenames: generate the suffix and, when a rename algorithm is configured,
    // keep bumping it until the target file does not exist.
    private calculateSuffixWithRenames(fp: IFilePath): void {
        fp.suffix = this.calculateSuffix(fp).replace(/^[\\/]+/, "");

        if (this.renameAlgorithm == null)
            return;

        for (let num = 2; fs.existsSync(this.fullPhysicalPath(fp)!); num++) {
            fp.suffix = this.renameAlgorithm(fp.suffix!, num);
            if (num > 1000)
                throw new Error(`Unable to find a free file name for '${fp.fileName}'`);
        }
    }

    private async deleteEmptyFolder(fullPath: string): Promise<void> {
        if (!this.deleteEmptyFolderOnDelete)
            return;
        const dir = path.dirname(fullPath);
        try {
            if ((await fsp.readdir(dir)).length === 0)
                await fsp.rmdir(dir);
        } catch {
            /* the folder is gone or not empty — nothing to clean */
        }
    }
}

// ---- Content types (a small stand-in for Signum's 694-line FileTypeContentTypes.cs) ----------------------

const mimeByExtension: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".bmp": "image/bmp", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".xml": "application/xml",
    ".json": "application/json", ".html": "text/html", ".htm": "text/html", ".css": "text/css",
    ".js": "text/javascript", ".zip": "application/zip", ".7z": "application/x-7z-compressed",
    ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".dat": "application/octet-stream",
};

/** Signum's `MimeMapping.GetMimeType` — the content type for a file name, by extension. */
export function mimeType(fileName: string): string | undefined {
    return mimeByExtension[path.extname(fileName).toLowerCase()];
}
