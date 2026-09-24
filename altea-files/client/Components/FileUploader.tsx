import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { FileEntity, FileEmbedded, FileMessage, FilePathEmbedded, toComputerSize, fileTypeLimits } from "../../data/Files";
import type { FieldInfo } from "@altea/altea/data/reflection";
import type { FileTypeSymbol } from "../../data/Files";
import "./Files.css";

// Port of Signum.Files' Components/FileUploader.tsx — see port/Files.md.
//
// Pick files (click or drag & drop), read their bytes and hand back filled FileEmbedded / FilePathEmbedded
// values. The bytes ride the entity's own save, so this component only reads the files LOCALLY — there is
// no upload endpoint, no progress bar and no temporary-file state.
//
// `onFileLoaded` is called once per picked file IN ORDER: the reads are awaited one after the other, so a
// MultiFileLine appends the rows in the order the user picked them.

export interface FileUploaderProps {
    /** Fill and return the file value — a FilePathEmbedded needs the store its bytes will go to. */
    fileType?: FileTypeSymbol;
    kind: "FilePathEmbedded" | "FileEmbedded" | "FileEntity";
    onFileLoaded: (file: FilePathEmbedded | FileEmbedded | FileEntity, index: number, count: number) => void;
    accept?: string;
    multiple?: boolean;
    maxSizeInBytes?: number | null;
    dragAndDrop?: boolean;
    dragAndDropMessage?: string;
    buttonCss?: string;
    /** Extra class on the drop zone — the line's mandatory highlight. */
    fileDropCssClass?: string;
    divHtmlAttributes?: React.HTMLAttributes<HTMLDivElement>;
}

export function FileUploader(p: FileUploaderProps): React.JSX.Element {

    const [isLoading, setIsLoading] = React.useState(false);
    const [isOver, setIsOver] = React.useState(false);
    const [errors, setErrors] = React.useState<string[]>([]);

    const dragAndDrop = p.dragAndDrop ?? true;

    async function loadAll(files: FileList | null): Promise<void> {
        setErrors([]);
        setIsOver(false);

        if (files == null || files.length === 0)
            return;

        // A multi-file drop on a single-file line is REPORTED, not silently reduced to the last file.
        if (!p.multiple && files.length > 1) {
            setErrors([FileMessage.OnlyOneFileIsSupported.niceToString()]);
            return;
        }

        setIsLoading(true);
        try {
            // Sequential on purpose: `onFileLoaded` appends, so the caller's list must follow the pick order.
            for (let i = 0; i < files.length; i++) {
                try {
                    p.onFileLoaded(await toFile(files[i], p), i, files.length);
                } catch (e) {
                    setErrors(errs => [...errs, e instanceof Error ? e.message : String(e)]);
                }
            }
        } finally {
            setIsLoading(false);
        }
    }

    function handleDragOver(e: React.DragEvent<unknown>): void {
        e.stopPropagation();
        e.preventDefault();
        setIsOver(true);
    }

    function handleDragLeave(e: React.DragEvent<unknown>): void {
        e.stopPropagation();
        e.preventDefault();
        setIsOver(false);
    }

    // The real <input type="file"> sits transparently over the button (see Files.css) — no synthetic
    // .click(), so the button keeps native keyboard focus and the OS picker opens normally.
    const selectButton =
        <div className={classes("sf-upload btn btn-tertiary", p.buttonCss)}>
            <FontAwesomeIcon aria-hidden={true} icon="upload" className="me-1" />
            {FileMessage.SelectFile.niceToString()}
            <input type="file" accept={p.accept} multiple={p.multiple}
                onChange={e => {
                    const input = e.currentTarget;
                    void loadAll(input.files).then(() => { input.value = ""; });
                }} />
        </div>;

    return (
        <div {...p.divHtmlAttributes}>
            {isLoading ? <div className="sf-file-drop">{JavascriptMessage.loading.niceToString()}</div> :
                dragAndDrop ?
                    <div className={classes("sf-file-drop", p.fileDropCssClass, isOver ? "sf-file-drop-over" : undefined)}
                        onDragEnter={handleDragOver}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={e => {
                            e.stopPropagation();
                            e.preventDefault();
                            void loadAll(e.dataTransfer.files);
                        }}>
                        {selectButton}
                        &nbsp;{p.dragAndDropMessage ?? FileMessage.OrDragAFileHere.niceToString()}
                    </div> :
                    selectButton
            }
            {errors.map((e, i) => <p key={i} className="text-danger">{e}</p>)}
        </div>
    );
}

/** Read one picked file into the file holder the line is bound to. */
export async function toFile(
    file: File,
    options: { kind: "FilePathEmbedded" | "FileEmbedded" | "FileEntity"; fileType?: FileTypeSymbol; maxSizeInBytes?: number | null },
): Promise<FilePathEmbedded | FileEmbedded | FileEntity> {

    if (options.maxSizeInBytes != null && file.size > options.maxSizeInBytes)
        throw new Error(FileMessage.File0IsTooBigTheMaximumSizeIs1.niceToString(file.name, toComputerSize(options.maxSizeInBytes)));

    const bytes = new Uint8Array(await file.arrayBuffer());

    if (options.kind === "FileEmbedded") {
        const fe = new FileEmbedded();
        fe.fileName = file.name;
        fe.binaryFile = bytes;
        return fe;
    }

    // A FileEntity holds its bytes the same way a FileEmbedded does — the difference is that it is a ROW,
    // so it needs no store and no fileType either. Nothing more is needed here: the owner's save writes the
    // reachable graph in dependency order, so assigning this to a field persists it and fills its id, and
    // the server computes its hash in FileLogic's preSaving.
    if (options.kind === "FileEntity") {
        const fe = new FileEntity();
        fe.fileName = file.name;
        fe.binaryFile = bytes;
        return fe;
    }

    if (options.fileType == null)
        throw new Error("FileUploader: a FilePathEmbedded needs a `fileType` (the store its bytes go to)");

    const fpe = new FilePathEmbedded();
    fpe.fileName = file.name;
    fpe.binaryFile = bytes;
    fpe.fileType = options.fileType;
    fpe.prepareForSave(); // length + the forced extension; the SERVER fills hash + suffix
    return fpe;
}

/**
 * What an uploader for a field is configured with: the line's own props first, then the field's
 * `@defaultFileType` (the first of `fields` that has one — a collection before its row's file field, as
 * Signum puts the attribute on the MList), and the size / image limits of that type's store, which the
 * server ships in the metadata blob.
 */
export function uploadOptions(
    p: { fileType?: FileTypeSymbol; accept?: string; maxSizeInBytes?: number | null },
    ...fields: (FieldInfo | undefined)[]
): { fileType?: FileTypeSymbol; accept?: string; maxSizeInBytes?: number | null } {
    const fileType = p.fileType ?? fields.map(f => f?.defaultFileType?.()).find(t => t != null);
    const limits = fileType != null ? fileTypeLimits(fileType) : undefined;
    return {
        fileType,
        accept: p.accept ?? (limits?.onlyImages ? "image/*" : undefined),
        maxSizeInBytes: p.maxSizeInBytes !== undefined ? p.maxSizeInBytes : limits?.maxSizeInBytes,
    };
}
