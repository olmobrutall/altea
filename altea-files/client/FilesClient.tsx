import * as React from "react";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { toAbsoluteUrl } from "@altea/altea/client/AppContext";
import type { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { getTypeName } from "@altea/altea/client/Reflection";
import { FileEntity, FileEmbedded, FilePathEmbedded } from "../data/Files";

// Port of Signum.Files' FilesClient.tsx — see docs/port/Files.md.
//
// The client entry point: the per-extension display info (icon + whether the browser can show it inline)
// and the URL builders the downloader uses. An embedded file's URL is built from its OWNING entity +
// property route (see server/FilesServer.ts), which is why one `fileUrl` helper serves every holder.
//
// `start` registers only the entity VIEWS: the file lines are used explicitly (`<FileLine ctx=… />` /
// `<MultiFileLine …>` / `<FileImageLine …>`), never as AutoLine defaults.

export namespace FilesClient {

    export function start(cb: ClientBuilder): void {
        // The two file HOLDERS are embedded, so they have no own view or route. FileEntity is a row, and
        // gets no view either: the search page IS the list of shared files, and a file's contents are
        // reached by DOWNLOADING it, not by opening a form over its bytes.
        cb.configure(FileEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.fileName),
                ],
            }));
    }

    /** How a file of a given extension is shown: icon + colour, the content type to
     *  stamp on a blob URL built from bytes the client holds, and whether the browser can render it inline. */
    export interface ExtensionInfo {
        icon?: IconProp;
        color?: string;
        mimeType?: string;
        browserView?: boolean;
    }

    export const extensionInfo: { [extension: string]: ExtensionInfo } = {
        ["pdf"]: { icon: "file-pdf", color: "#d32f2f", mimeType: "application/pdf", browserView: true },
        ["png"]: { icon: "file-image", color: "#4caf50", mimeType: "image/png", browserView: true },
        ["jpg"]: { icon: "file-image", color: "#4caf50", mimeType: "image/jpeg", browserView: true },
        ["jpeg"]: { icon: "file-image", color: "#4caf50", mimeType: "image/jpeg", browserView: true },
        ["gif"]: { icon: "file-image", color: "#4caf50", mimeType: "image/gif", browserView: true },
        ["bmp"]: { icon: "file-image", color: "#4caf50", mimeType: "image/bmp", browserView: true },
        ["webp"]: { icon: "file-image", color: "#4caf50", mimeType: "image/webp", browserView: true },
        ["svg"]: { icon: "file-image", color: "#4caf50", mimeType: "image/svg+xml", browserView: true },
        ["txt"]: { icon: "file-lines", color: "#607d8b", mimeType: "text/plain", browserView: true },
        ["csv"]: { icon: "file-csv", color: "#2e7d32", mimeType: "text/csv" },
        ["xml"]: { icon: "file-code", color: "#607d8b", mimeType: "application/xml", browserView: true },
        ["json"]: { icon: "file-code", color: "#607d8b", mimeType: "application/json", browserView: true },
        ["html"]: { icon: "file-code", color: "#e65100", mimeType: "text/html", browserView: true },
        ["zip"]: { icon: "file-zipper", color: "#795548", mimeType: "application/zip" },
        ["doc"]: { icon: "file-word", color: "#1565c0", mimeType: "application/msword" },
        ["docx"]: { icon: "file-word", color: "#1565c0", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        ["xls"]: { icon: "file-excel", color: "#2e7d32", mimeType: "application/vnd.ms-excel" },
        ["xlsx"]: { icon: "file-excel", color: "#2e7d32", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        ["ppt"]: { icon: "file-powerpoint", color: "#d84315", mimeType: "application/vnd.ms-powerpoint" },
        ["pptx"]: { icon: "file-powerpoint", color: "#d84315", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
        ["mp3"]: { icon: "file-audio", color: "#6a1b9a", mimeType: "audio/mpeg", browserView: true },
        ["mp4"]: { icon: "file-video", color: "#6a1b9a", mimeType: "video/mp4", browserView: true },
    };

    export function infoFor(fileName: string | undefined): ExtensionInfo | undefined {
        const ext = fileName?.tryAfterLast(".")?.toLowerCase();
        return ext == null ? undefined : extensionInfo[ext];
    }

    /** The download URL of any of the three file shapes. `undefined` when the file has no address yet (an
     *  unsaved file: its bytes are still in hand, so the caller shows those instead).
     *
     *  A FileEntity is addressed by its OWN id; the two EMBEDDED shapes are addressed through their OWNER
     *  (see FilesServer), and there are two sources for that address, in order:
     *   1. the file's OWN routing fields, stamped by the server (FilePathEmbeddedLogic) — authoritative, and
     *      the only correct answer for a file the client did not load as part of a form (a collection row, a
     *      search result);
     *   2. an explicitly supplied owner + member path — the fallback for a FileEmbedded, which carries no
     *      routing fields, and for anything the server has not stamped.
     *
     *  The `hash` rides along but the server IGNORES it (the bytes are found through the owner): it is there
     *  to make the URL change when the file's bytes do, so the response can be cached for a month
     *  (FilesServer.maxAge) without ever serving a replaced file. */
    export function fileUrl(
        file: FilePathEmbedded | FileEmbedded | FileEntity | Lite<FileEntity>,
        container?: Entity,
        propertyRoute?: string,
        rowId?: string | number,
    ): string | undefined {

        // A FileEntity is its OWN row, so it needs neither an owner nor a route. A Lite works for the same
        // reason, which is what lets a search-result column offer a download without retrieving the bytes.
        if (file instanceof FileEntity)
            return file.id == null ? undefined : toAbsoluteUrl(`/api/files/downloadFile/${file.id}`);
        if (file instanceof Lite)
            return toAbsoluteUrl(`/api/files/downloadFile/${file.id}`);

        const kind = file instanceof FilePathEmbedded ? "downloadEmbeddedFilePath" : "downloadEmbedded";

        const address = file instanceof FilePathEmbedded && file.hasRouting()
            ? { rootType: file.rootType!, id: file.entityId!, route: file.propertyRoute!, rowId: undefined }
            : container?.id == null || propertyRoute == null ? undefined
                : { rootType: getTypeName(container), id: String(container.id), route: propertyRoute, rowId };

        if (address == null)
            return undefined;

        const query = new URLSearchParams({ route: address.route });
        if (address.rowId != null)
            query.set("rowId", String(address.rowId));
        // Only a FilePathEmbedded stores a hash; its base64 is percent-encoded by URLSearchParams.
        if (file instanceof FilePathEmbedded && file.hash != null)
            query.set("hash", file.hash);

        return toAbsoluteUrl(`/api/files/${kind}/${address.rootType}/${address.id}?${query.toString()}`);
    }
}
