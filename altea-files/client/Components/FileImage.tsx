import * as React from "react";
import type { Entity } from "@altea/altea/data/entity";
import { ajaxGetRaw, type AjaxOptions } from "@altea/altea/client/Services";
import { FileEmbedded, FileMessage, FilePathEmbedded } from "../../data/Files";
import { FilesClient } from "../FilesClient";

// Port of Signum.Files' Components/FileImage.tsx — an <img> over a file, from whichever source it has:
//   • bytes still in memory (just picked by the uploader, or a FileEmbedded read with its row) → a blob URL,
//   • a stored file → its owner-addressed download URL, fetched through the app's own ajax so the session
//     cookie / request filters apply (a bare `src=` would work for the cookie, but skips them).
//
// altea divergences:
//  - Signum resolves the URL through the per-type `configurations` registry and supports a Lite (fetched by
//    FetchAndRemember in FileImageLine); altea has only the two EMBEDDED holders. Their URL comes from
//    `FilesClient.fileUrl`, which prefers the routing the SERVER stamped on the file and falls back to the
//    owner + property route props below.
//  - Signum's in-memory case is `"data:image/jpeg;base64," + file.binaryFile` (its binaryFile IS base64, and
//    the mime is hardcoded); altea holds real bytes, so it makes a properly-typed blob URL instead.
//  - `fullWebPath` (a file served directly by the web server) is not ported — see FileTypeAlgorithm.

export interface FileImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
    file?: FilePathEmbedded | FileEmbedded | null;
    /** The entity that HOLDS the file + the route to it — a FALLBACK, only consulted when the file carries no
     *  routing of its own (a FileEmbedded, or a FilePathEmbedded the server has not stamped yet). */
    containerEntity?: Entity;
    propertyRoute?: string;
    rowId?: string | number;
    /** Shown while there is no file at all (Signum's placeholderSrc). */
    placeholderSrc?: string;
    ajaxOptions?: Omit<AjaxOptions, "url">;
}

export function FileImage(p: FileImageProps): React.JSX.Element {

    const { file, containerEntity, propertyRoute, rowId, placeholderSrc, ajaxOptions, ...rest } = p;

    const [objectUrl, setObjectUrl] = React.useState<string | undefined>(undefined);

    // The bytes we already have, if any — a blob URL is synchronous, so it needs no state.
    const inMemoryUrl = React.useMemo(() => {
        const bytes = file?.binaryFile;
        return bytes == null || bytes.length === 0 ? undefined : blobUrlFor(bytes, file!.fileName);
    }, [file, file?.binaryFile]);

    React.useEffect(() => () => { if (inMemoryUrl != null) URL.revokeObjectURL(inMemoryUrl); }, [inMemoryUrl]);

    // Otherwise fetch the stored bytes once. `cache: "default"` on purpose: the download response carries an
    // ETag + a long max-age keyed on the file's hash (FilesServer), so a revisit is a 304 or a cache hit.
    React.useEffect(() => {
        if (file == null || inMemoryUrl != null)
            return;

        const fetchUrl = FilesClient.fileUrl(file, containerEntity, propertyRoute, rowId);
        if (fetchUrl == null)
            return;

        let url: string | undefined = undefined;
        let cancelled = false;

        void ajaxGetRaw({ url: fetchUrl, cache: "default", ...ajaxOptions })
            .then(resp => resp.blob())
            .then(blob => {
                if (cancelled)
                    return;
                url = URL.createObjectURL(blob);
                setObjectUrl(url);
            });

        return () => {
            cancelled = true;
            if (url != null)
                URL.revokeObjectURL(url);
            setObjectUrl(undefined);
        };
    }, [file, inMemoryUrl, containerEntity?.id, propertyRoute, rowId]);

    const src = file == null ? placeholderSrc : inMemoryUrl ?? objectUrl;

    return <img {...rest} src={src} alt={p.alt ?? FileMessage.FileImage.niceToString()} />;
}

/** A blob URL for bytes the client already holds, typed by the file's extension so the browser renders it. */
function blobUrlFor(bytes: Uint8Array, fileName: string): string {
    const info = FilesClient.infoFor(fileName);
    // `new Blob([...])` wants a real ArrayBuffer view; a Uint8Array is one.
    return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: info?.mimeType }));
}
