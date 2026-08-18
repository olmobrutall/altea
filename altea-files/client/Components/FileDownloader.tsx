import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import type { Entity } from "@altea/altea/data/entity";
import { FileEmbedded, FilePathEmbedded, FileMessage, toComputerSize } from "../../data/Files";
import { FilesClient } from "../FilesClient";

// Port of Signum.Files' Components/FileDownloader.tsx — renders a stored file as a link that VIEWS it (when the
// browser can) plus a save button. Two sources of bytes:
//   • a file still in memory (`binaryFile`, e.g. just picked by the uploader) → a blob URL,
//   • a saved file → the owner-addressed download URL (FilesClient.fileUrl → /api/files/download…).
//
// altea divergences: Signum's `FileDownloaderConfiguration` registry per file type collapses to the two
// embedded types (see FilesClient), and `entityOrLite` is just the file value (altea has no standalone file
// entities to fetch). The owner + property route props are a FALLBACK: a saved FilePathEmbedded carries its
// own address (the server stamps rootType/entityId/propertyRoute on it), which `FilesClient.fileUrl` prefers.

export type DownloadBehaviour = "SaveAs" | "View" | "ViewOrSave" | "None";

export interface FileDownloaderProps {
    file: FilePathEmbedded | FileEmbedded;
    /** The entity that HOLDS the file + the route to it. Only needed when the file carries no routing of its
     *  own — a FileEmbedded, or a FilePathEmbedded the server has not stamped yet. */
    containerEntity?: Entity;
    propertyRoute?: string;
    rowId?: string | number;
    download?: DownloadBehaviour;
    showFileIcon?: boolean;
    hideFileName?: boolean;
    htmlAttributes?: React.HTMLAttributes<HTMLDivElement>;
    children?: React.ReactNode;
}

export function FileDownloader(p: FileDownloaderProps): React.JSX.Element {

    const file = p.file;
    const fileName = file.fileName;
    const info = FilesClient.infoFor(fileName);
    const download = p.download ?? "ViewOrSave";

    const url = React.useMemo(() => {
        if (file.binaryFile != null)
            return blobUrl(file.binaryFile, fileName);

        return FilesClient.fileUrl(file, p.containerEntity, p.propertyRoute, p.rowId);
    }, [file, file.binaryFile, fileName, p.containerEntity?.id, p.propertyRoute, p.rowId]);

    // Revoke the blob URL when it is replaced (a picked file that is saved / removed).
    React.useEffect(() => () => { if (url?.startsWith("blob:")) URL.revokeObjectURL(url); }, [url]);

    const label = p.hideFileName ? null : file.toString();

    const children = p.children ?? <>
        {(p.showFileIcon ?? true) &&
            <FontAwesomeIcon className="me-1" icon={info?.icon ?? "file"} color={info?.color ?? "grey"} />}
        {label}
    </>;

    if (url == null)
        return <div {...p.htmlAttributes}><span title={FileMessage.DownloadFile.niceToString()}>{children}</span></div>;

    return (
        <div {...p.htmlAttributes}>
            {/* View (a new tab, so the browser decides how to render) — or save directly when it cannot show it. */}
            <a href={url} title={file.toString()} target="_blank" rel="noreferrer"
                download={download === "SaveAs" || (download === "ViewOrSave" && !info?.browserView) ? fileName : undefined}>
                {children}
            </a>
            {download === "ViewOrSave" &&
                <a href={url} download={fileName} className="sf-view sf-line-button ms-1"
                    title={FileMessage.DownloadFile.niceToString()}>
                    <FontAwesomeIcon icon="download" />
                </a>
            }
        </div>
    );
}

/** Signum's `downloadBase64` / `viewBase64` — a URL for bytes the client already holds. */
export function blobUrl(bytes: Uint8Array, fileName: string): string {
    const info = FilesClient.infoFor(fileName);
    // The extension's content type decides whether the browser renders the blob or offers to save it; an
    // unknown extension gets none, which the browser treats as a download.
    // `new Blob([...])` wants a real ArrayBuffer view; a Uint8Array is one.
    return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: info?.mimeType }));
}

/** The file's size for a label / tooltip (Signum's toComputerSize, re-exported from the data layer). */
export { toComputerSize };
