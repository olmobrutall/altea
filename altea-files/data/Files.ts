import { reflect, init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { EmbeddedEntity, Entity } from "@altea/altea/data/entity";
import { Symbol } from "@altea/altea/data/symbol";
import { column, entity, format, stringLengthValidator, fieldValidation, ticksColumn } from "@altea/altea/data/decorators";
import { type long, toLong } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { notNullValidator } from "@altea/altea/data/validators";

// Port of Signum.Files' file model (FileTypeSymbol.cs, FilePathEmbedded.cs, FileEmbedded.cs, FileEntity.cs,
// Signum.Files.ts). Signum offers four ways to hold a file, along two axes — where the BYTES live, and
// whether the file is its own ROW:
//
//                    │ bytes in the row            │ bytes in a store
//   ─────────────────┼─────────────────────────────┼──────────────────────────────
//    embedded        │ FileEmbedded                │ FilePathEmbedded
//    its own row     │ FileEntity                  │ FilePathEntity  (NOT ported)
//
//   • FileEmbedded     — the bytes live IN the row (a blob column). Simple, no storage config, no cleanup.
//   • FilePathEmbedded — the bytes live in a STORE (a folder, Azure, S3) and the row keeps the metadata +
//                        the `suffix` that locates them. Needs a FileTypeSymbol whose algorithm decides where.
//   • FileEntity       — FileEmbedded's contents in a table of its OWN, so several owners can reference the
//                        same file and a file can outlive any one of them (Signum's EntityKind.SharedPart).
//                        That is the only reason to prefer it: a field holding one is an ordinary reference.
//
// `FilePathEntity` is still not ported — it is FileEntity's store-backed sibling, and nothing needs the
// combination (a shared file whose bytes are in a store) yet. It would need FilePathEmbeddedLogic's whole
// save/delete cascade a second time, addressed by row rather than by owner.
//
// altea divergences, documented inline:
//  - Signum's `byte[] BinaryFile` → a `Uint8Array` field (altea's "Blob" → bytea / varbinary(MAX)).
//  - Signum keeps `BinaryFile` / `EntityId` / `MListRowId` / `PropertyRoute` / `RootType` as `[Ignore]`
//    (in-memory only) fields; altea marks them `@column(false)` — not mapped, but still SERIALIZED, which is
//    the point: `binaryFile` carries an upload client → server, and the routing trio carries the file's
//    ADDRESS server → client. `MListRowId` is the one that does not survive the port: altea has no MList, so
//    a file inside a collection sits on a `@part` ROW ENTITY with an id of its own — that row IS the route
//    root, and `entityId` is its id.
//  - The C# property SETTERS (FileName forcing an extension; BinaryFile computing Hash + FileLength) run in
//    `prepareForSave` here (altea entities are plain field bags) — called by the server's save hook.
//  - `FilePathEntity` (the standalone, referencable file row) and the Azure/S3 backends are NOT ported:
//    nothing in altea references them yet. (`BigStringMixin` — the other FilePathEmbedded consumer — IS
//    ported: see data/BigString.ts + server/BigStringLogic.server.ts.)

// Signum's FileTypeSymbol (FileTypeSymbol.cs) — names a STORE + policy (where files go, size/type limits).
// The algorithm behind each symbol is registered server-side (FileTypeLogic.register).
@reflect
@entity("SystemString", "Master")
export class FileTypeSymbol extends Symbol {
}

// Signum's FileEmbedded (FileEmbedded.cs) — a file kept inside the row.
@reflect
export class FileEmbedded extends EmbeddedEntity {
    @stringLengthValidator({ min: 3, max: 200 })
    fileName: string = "";

    binaryFile: Uint8Array = new Uint8Array(0);

    toString(): string {
        return `${this.fileName} - ${toComputerSize(this.binaryFile?.length ?? 0)}`;
    }
}

// Signum's FileEntity (FileEntity.cs) — FileEmbedded's contents as a row of its own, so it can be SHARED.
//
// altea divergences:
//  - **Signum's `ImmutableEntity` base is not ported, but its guarantee is.** That base works by overriding
//    the property `Set` interception (a set on a saved row is silently swallowed), which altea has no
//    counterpart for — altea entities are plain field bags. What actually protects the data is Signum's
//    OTHER half, `PreSaving` throwing when a non-new ImmutableEntity is SelfModified, and that ports
//    exactly: FileLogic hangs it on `entityEvents(FileEntity).preSaving`. So editing a saved file's bytes
//    fails LOUDLY here where Signum's setter fails silently — the same rule, reported better. The reason
//    for the rule is the sharing: a file row may have several owners, so mutating it would change the file
//    under every one of them. Replace the REFERENCE instead.
//  - `hash` is filled server-side (the isomorphic layer has no crypto), like FilePathEmbedded's — see
//    `prepareForSave`. Signum computes it in the `BinaryFile` setter.
//  - the `FileEntity(string path)` constructor (read a file off disk) has no counterpart: it is
//    `File.ReadAllBytes`, i.e. server-only, and this layer is isomorphic.
//  - `ToXML` is not ported. Its one Signum caller is WordTemplate's `SyncFromXml`, and
//    @altea/altea-office-template holds a `FileEmbedded` with XML of its own.
@reflect
@entity("SharedPart", "Transactional")
// Signum's `[TicksColumn(false)]`: an immutable row cannot be concurrently edited, so a stamp would guard
// nothing. (A SharedPart would otherwise get one — it is reached by reference, not through one owner.)
@ticksColumn(false)
export class FileEntity extends Entity {
    // Signum's [StringLengthValidator(Min = 3, Max = 254)] — note 254, where FileEmbedded's is 200.
    @stringLengthValidator({ min: 3, max: 254 })
    fileName: string = "";

    // Signum's `[NotNullValidator(DisabledInModelBinder = true)] string Hash { get; private set; }`.
    //
    // Declared NON-nullable, so the column is NOT NULL as Signum's is — the value is derived from the
    // bytes, so a row without one would be a row whose hash disagrees with its contents. But it is filled
    // SERVER-side (FileLogic's preSaving), so an explicit `disabled: env => env !== "Saving"` replaces the
    // implicit always-on NotNull: a client never sends it, and the check belongs at the moment the server
    // has had its chance. Exactly the shape altea-tree's engine-maintained columns use.
    @notNullValidator({ disabled: env => env !== "Saving" })
    hash: string;

    binaryFile: Uint8Array = new Uint8Array(0);

    /** The server's save hook (FileLogic) calls this with the computed hash — Signum's BinaryFile setter. */
    prepareForSave(hash: string): void {
        this.hash = hash;
    }

    toString(): string {
        return `${this.fileName} - ${toComputerSize(this.binaryFile?.length ?? 0)}`;
    }
}

// Signum's FilePathEmbedded (FilePathEmbedded.cs) — a file kept in a store: the metadata that stays in the
// row (name / hash / length / suffix / file type) plus the transient `binaryFile` an upload carries.
@reflect
export class FilePathEmbedded extends EmbeddedEntity {
    // Signum's [StringLengthValidator(1, 260), FileNameValidator].
    @fieldValidation<FilePathEmbedded>(f => hasInvalidFileNameChars(f.fileName)
        ? FileMessage.TheNameOfTheFileMustNotContainPercent1.niceToString(invalidFileNameChars) : null)
    @stringLengthValidator({ min: 1, max: 260 })
    fileName: string = "";

    hash: string | null = null;

    // Signum's `[Ignore]` routing trio (EntityId / RootType / PropertyRoute — see the header note on
    // MListRowId). NOT columns: they are re-derived server-side every time the file is read (the `retrieved`
    // hook) and after its owner is saved (the `saved` hook), by FilePathEmbeddedLogic, which knows the schema
    // position of every FilePathEmbedded field.
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

    // Signum's [StringLengthValidator(1, 1024)] — the store-relative path the algorithm generated. Null until
    // the file is actually saved (the save hook fills it).
    @stringLengthValidator({ min: 1, max: 1024 })
    suffix: string | null = null;

    fileType: FileTypeSymbol;

    // Signum's `[Ignore] byte[] BinaryFile`: NOT a column (the bytes live in the store), but it IS serialized
    // so a client upload can carry them to the server, which writes them and clears this.
    @column(false)
    binaryFile: Uint8Array | null = null;

    /** Signum's `FilePathEmbedded.BinaryFile` setter + the FileName setter (altea has no property setters):
     *  derive length + hash from the bytes and force an extension. Called by the server save hook and by any
     *  code that fills `binaryFile` by hand. `hash` is filled server-side (no crypto in the isomorphic layer). */
    prepareForSave(hash?: string): void {
        if (forceExtensionIfEmpty && this.fileName && !hasExtension(this.fileName))
            this.fileName = this.fileName + forceExtensionIfEmpty;

        if (this.binaryFile != null) {
            this.fileLength = toLong(this.binaryFile.length);
            if (hash != null)
                this.hash = hash;
        }
    }

    /** Signum's CleanBinaryFile — drop the transient bytes once the store has them. */
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
        return `${this.fileName} - ${toComputerSize(this.fileLength as unknown as number)}`;
    }
}

/** Signum's `FilePathEmbedded.ForceExtensionIfEmpty` (a static knob, default ".dat"). */
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

/** Signum's `StringExtensions.ToComputerSize` — 1.5 MB, 900 Bytes, … (used by the file toStrings). */
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

// Signum's FileMessage (Signum.Files.ts / resx) — only the members altea's port uses.
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

// Signum's `[AutoInit] static class FilePermission` (FilesController's download gate is anonymous in Signum;
// altea keeps the route authenticated, so no permission symbol is declared).
export namespace FileTypeSymbols {
    /** A store for files uploaded through the app's generic file line — registered by the app (eastwind's
     *  starter) with a folder algorithm. Declared here so a shared component can reference it. */
    export const Default: FileTypeSymbol = init();
}

// The database schema this package's tables live in — altea's counterpart of Signum's
// `[assembly: AssemblySchemaName("files")]`. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("files");
