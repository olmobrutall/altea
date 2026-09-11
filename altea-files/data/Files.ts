import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { EmbeddedEntity } from "@altea/altea/data/entity";
import { ImmutableEntity } from "@altea/altea/data/immutableEntity";
import { Symbol } from "@altea/altea/data/symbol";
import { column, entity, format, ticksColumn } from "@altea/altea/data/decorators";
import { stringLengthValidator, validate, notNullValidator } from "@altea/altea/data/validators";
import { type long, toLong } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";

// Port of Signum.Files' FileTypeSymbol.cs + FilePathEmbedded.cs + FileEmbedded.cs + FileEntity.cs — see
// port/Files.md.
//
// Three ways to hold a file, along two axes — where the BYTES live, and whether the file is its own ROW:
//
//                    │ bytes in the row            │ bytes in a store
//   ─────────────────┼─────────────────────────────┼──────────────────────────────
//    embedded        │ FileEmbedded                │ FilePathEmbedded
//    its own row     │ FileEntity                  │ (not ported)
//
//   • FileEmbedded     — the bytes live IN the row (a blob column). Simple, no storage config, no cleanup.
//   • FilePathEmbedded — the bytes live in a STORE (a folder, Azure, S3) and the row keeps the metadata +
//                        the `suffix` that locates them. Needs a FileTypeSymbol whose algorithm decides where.
//   • FileEntity       — FileEmbedded's contents in a table of its OWN, so several owners can reference the
//                        same file and a file can outlive any one of them. That is the only reason to prefer
//                        it: a field holding one is an ordinary reference.
//
// `binaryFile` / `entityId` / `propertyRoute` / `rootType` are `@column(false)` — not mapped, but still
// SERIALIZED, which is the point: `binaryFile` carries an upload client → server, and the routing trio
// carries the file's ADDRESS server → client. The C# property SETTERS (fileName forcing an extension;
// binaryFile computing hash + fileLength) run in `prepareForSave`, called by the server's save hook.

// Names a STORE + policy (where files go, size/type limits).
// The algorithm behind each symbol is registered server-side (FileTypeLogic.register).
@reflect
@entity("SystemString", "Master")
export class FileTypeSymbol extends Symbol {
}

// A file kept inside the row.
@reflect
export class FileEmbedded extends EmbeddedEntity {
    @stringLengthValidator({ min: 3, max: 200 })
    fileName: string = "";

    binaryFile: Uint8Array = new Uint8Array(0);

    toString(): string {
        return `${this.fileName} - ${toComputerSize(this.binaryFile?.length ?? 0)}`;
    }
}

// FileEmbedded's contents as a row of its own, so it can be SHARED.
//
// It derives from `ImmutableEntity` (@altea/altea/data/immutableEntity), so a saved file's row cannot be
// re-saved changed and `allowChange` / `allowChanges()` are the escape hatch. The reason is the sharing: a
// file row may have several owners, so mutating it would change the file under every one of them —
// replace the REFERENCE instead.
//
// `hash` is filled server-side (`prepareForSave`), since the isomorphic layer has no crypto. There is no
// path constructor for the same reason: reading a file off disk is server-only.
@reflect
@entity("SharedPart", "Transactional")
// An immutable row cannot be concurrently edited, so a stamp would guard
// nothing. (A SharedPart would otherwise get one — it is reached by reference, not through one owner.)
@ticksColumn(false)
export class FileEntity extends ImmutableEntity {
    // 254, where FileEmbedded's is 200 — both are the lengths a Signum database's columns have.
    @stringLengthValidator({ min: 3, max: 254 })
    fileName: string = "";

    // Declared NON-nullable, so the column is NOT NULL: the value is derived from the bytes, so a row
    // without one would be a row whose hash disagrees with its contents. But it is filled SERVER-side
    // (FileLogic's preSaving), so an explicit `disabled: env => env !== "Saving"` replaces the implicit
    // always-on NotNull — a client never sends it, and the check belongs at the moment the server has had
    // its chance. Exactly the shape altea-tree's engine-maintained columns use.
    @notNullValidator({ disabled: env => env !== "Saving" })
    hash: string;

    binaryFile: Uint8Array = new Uint8Array(0);

    /** The server's save hook (FileLogic) calls this with the computed hash. */
    prepareForSave(hash: string): void {
        this.hash = hash;
    }

    toString(): string {
        return `${this.fileName} - ${toComputerSize(this.binaryFile?.length ?? 0)}`;
    }
}

// A file kept in a store: the metadata that stays in the
// row (name / hash / length / suffix / file type) plus the transient `binaryFile` an upload carries.
@reflect
export class FilePathEmbedded extends EmbeddedEntity {
    @validate<FilePathEmbedded>(f => hasInvalidFileNameChars(f.fileName)
        ? FileMessage.TheNameOfTheFileMustNotContainPercent1.niceToString(invalidFileNameChars) : null)
    @stringLengthValidator({ min: 1, max: 260 })
    fileName: string = "";

    hash: string | null = null;

    // The routing trio. NOT columns: they are re-derived server-side every time the file is read and
    // after its owner is saved, by FilePathEmbeddedLogic, which knows the schema position of every
    // FilePathEmbedded field.
    //
    // They exist for the DOWNLOAD, and they are a security feature, not a convenience: a file is fetched by
    // naming its OWNER (`/api/files/downloadEmbeddedFilePath/<rootType>/<entityId>?route=<propertyRoute>`), so
    // the server re-reads it through the ordinary GATED retrieve — type auth and row-level conditions decide,
    // and the stored `suffix` never appears in a URL. That only works if the client knows the owner and the
    // route, and the trustworthy source for both is the SERVER: a client that has to infer them (walk up its
    // form context, guess a member path) gets it wrong for a file on a collection row or one shown outside
    // the form that loaded it — and a wrong address is either a broken download or a request for somebody
    // else's row.
    @column(false)
    entityId: string | null = null;

    @column(false)
    rootType: string | null = null;

    @column(false)
    propertyRoute: string | null = null;

    @format("N0")
    fileLength: long = toLong(0);

    // The store-relative path the algorithm generated. Null until the file is actually saved (the save
    // hook fills it).
    @stringLengthValidator({ min: 1, max: 1024 })
    @notNullValidator({ disabled: env => env !== "Saving" })
    suffix: string;

    fileType: FileTypeSymbol;

    // NOT a column (the bytes live in the store), but it IS serialized
    // so a client upload can carry them to the server, which writes them and clears this.
    @column(false)
    binaryFile: Uint8Array | null = null;

    /** Derive length + hash from the bytes and force an extension — what a C# property setter would do.
     *  Called by the server save hook and by any code that fills `binaryFile` by hand; `hash` comes from the
     *  server, since the isomorphic layer has no crypto. */
    prepareForSave(hash?: string): void {
        if (forceExtensionIfEmpty && this.fileName && !hasExtension(this.fileName))
            this.fileName = this.fileName + forceExtensionIfEmpty;

        if (this.binaryFile != null) {
            this.fileLength = toLong(this.binaryFile.length);
            if (hash != null)
                this.hash = hash;
        }
    }

    /** Drop the transient bytes once the store has them. */
    cleanBinaryFile(): void {
        this.binaryFile = null;
    }

    /** Stamp where this file hangs (FilePathEmbeddedLogic, on retrieve and after save). */
    setRouting(rootType: string, entityId: string | null, propertyRoute: string): void {
        this.rootType = rootType;
        this.entityId = entityId;
        this.propertyRoute = propertyRoute;
    }

    /** True once the server has said where this file lives, so it can be downloaded by address. */
    hasRouting(): boolean {
        return this.rootType != null && this.entityId != null && this.propertyRoute != null;
    }

    toString(): string {
        return `${this.fileName} - ${toComputerSize(this.fileLength)}`;
    }
}

export let forceExtensionIfEmpty: string | null = ".dat";
export function setForceExtensionIfEmpty(value: string | null): void {
    forceExtensionIfEmpty = value;
}

const invalidFileNameChars = `\\/:*?"<>|`;

function hasInvalidFileNameChars(fileName: string | null): boolean {
    return fileName != null && [...invalidFileNameChars].some(c => fileName.includes(c));
}

function hasExtension(fileName: string): boolean {
    const dot = fileName.lastIndexOf(".");
    return dot > 0 && dot > fileName.lastIndexOf("/") && dot < fileName.length - 1;
}

/** 1.5 MB, 900 Bytes, … (used by the file toStrings). */
export function toComputerSize(bytes: number): string {
    const units = ["Bytes", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${i === 0 ? value : value.toFixed(2)} ${units[i]}`;
}

export const FileMessage = {
    DownloadFile: msg("Download file"),
    ErrorSavingFile: msg("Error saving file"),
    FileTypes: msg("File Types"),
    Open: msg(),
    OpeningHasNotDefaultImplementationFor0: msg("Opening has not default implementation for {0}"),
    WriteHere: msg("Write here"),
    RemoveFile: msg("Remove file"),
    SelectFile: msg("Select file"),
    ViewFile: msg("View"),
    OnlyOneFileIsSupported: msg("Only one file is supported"),
    TheFile0IsNotA1: msg("The file {0} is not a {1}"),
    File0IsTooBigTheMaximumSizeIs1: msg("File {0} is too big, the maximum size is {1}"),
    TheNameOfTheFileMustNotContainPercent1: msg("The name of the file must not contain the characters {0}"),
    FileImageMustHaveExtension: msg("File image must have an extension"),
    OrDragAFileHere: msg("or drag a file here"),
    AddMoreFiles: msg("Add more files"),
    FileImage: msg("File image"),
    /** A remote store's malware scan flagged the file (see @altea/altea-files-azure's Defender polling). */
    File0ContainsAThreatBy1: msg("File {0} contains a threat detected by {1}"),
};

// No download PERMISSION symbol: every download route is authenticated and gated by the owner's own read
// rules, so there is nothing left for one to gate.
export namespace FileTypeSymbols {
    /** A store for files uploaded through the app's generic file line — registered by the app (eastwind's
     *  starter) with a folder algorithm. Declared here so a shared component can reference it. */
    export const Default: FileTypeSymbol = init();
}

// The database schema this package's tables live in. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("files");
