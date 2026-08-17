import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { FileEmbedded, FileMessage, FilePathEmbedded, toComputerSize } from "../../data/Files";
import type { FileTypeSymbol } from "../../data/Files";

// Port of Signum.Files' Components/FileUploader.tsx — pick a file (click or drag & drop), read its bytes and
// hand back a filled FileEmbedded / FilePathEmbedded. The bytes ride the entity to the server, which writes
// them to the store (FilePathEmbedded) or the row (FileEmbedded).
//
// altea divergences: Signum uploads through its own `/api/files/upload…` endpoints (with a chunked variant for
// big files) and shows per-file progress; altea carries the bytes INSIDE the entity graph (base64 —
// serializer's BlobSerializer), so this component only reads the file locally. Multi-file upload and the
// image-specific variants are not ported (no consumer yet).

export interface FileUploaderProps {
    /** Fill and return the file value — a FilePathEmbedded needs the store its bytes will go to. */
    fileType?: FileTypeSymbol;
    kind: "FilePathEmbedded" | "FileEmbedded";
    onFileLoaded: (file: FilePathEmbedded | FileEmbedded) => void;
    accept?: string;
    maxSizeInBytes?: number | null;
    dragAndDrop?: boolean;
    dragAndDropMessage?: string;
    buttonCss?: string;
    divHtmlAttributes?: React.HTMLAttributes<HTMLDivElement>;
}

export function FileUploader(p: FileUploaderProps): React.JSX.Element {

    const [isOver, setIsOver] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>(undefined);
    const inputRef = React.useRef<HTMLInputElement>(null);

    async function handleFiles(files: FileList | null): Promise<void> {
        setError(undefined);

        if (files == null || files.length === 0)
            return;

        if (files.length > 1) {
            setError(FileMessage.OnlyOneFileIsSupported.niceToString());
            return;
        }

        const file = files[0];

        if (p.maxSizeInBytes != null && file.size > p.maxSizeInBytes) {
            setError(FileMessage.File0IsTooBigTheMaximumSizeIs1.niceToString(file.name, toComputerSize(p.maxSizeInBytes)));
            return;
        }

        const bytes = new Uint8Array(await file.arrayBuffer());

        if (p.kind === "FileEmbedded") {
            const fe = new FileEmbedded();
            fe.fileName = file.name;
            fe.binaryFile = bytes;
            p.onFileLoaded(fe);
        } else {
            if (p.fileType == null)
                throw new Error("FileUploader: a FilePathEmbedded needs a `fileType` (the store its bytes go to)");
            const fpe = new FilePathEmbedded();
            fpe.fileName = file.name;
            fpe.binaryFile = bytes;
            fpe.fileType = p.fileType;
            fpe.prepareForSave(); // length + the forced extension; the SERVER fills hash + suffix
            p.onFileLoaded(fpe);
        }
    }

    return (
        <div {...p.divHtmlAttributes}
            onDragOver={p.dragAndDrop === false ? undefined : e => { e.preventDefault(); setIsOver(true); }}
            onDragLeave={p.dragAndDrop === false ? undefined : () => setIsOver(false)}
            onDrop={p.dragAndDrop === false ? undefined : e => {
                e.preventDefault();
                setIsOver(false);
                void handleFiles(e.dataTransfer.files);
            }}>

            <input ref={inputRef} type="file" accept={p.accept} style={{ display: "none" }}
                onChange={e => { void handleFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />

            <button type="button" className={p.buttonCss ?? "btn btn-sm btn-tertiary"}
                onClick={() => inputRef.current?.click()}>
                <FontAwesomeIcon icon="upload" className="me-1" />{FileMessage.SelectFile.niceToString()}
            </button>

            {p.dragAndDrop !== false &&
                <span className={classes("ms-2 small", isOver ? "text-primary fw-bold" : "text-muted")}>
                    {p.dragAndDropMessage ?? FileMessage.DropFileHere.niceToString()}
                </span>}

            {error && <div className="text-danger small mt-1">{error}</div>}
        </div>
    );
}
