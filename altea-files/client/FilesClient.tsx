import * as React from "react";
import type { IconProp } from "@fortawesome/fontawesome-svg-core";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { toAbsoluteUrl } from "@altea/altea/client/AppContext";
import type { Entity } from "@altea/altea/data/entity";
import { getTypeName } from "@altea/altea/client/Reflection";
import { FileEmbedded, FilePathEmbedded } from "../data/Files";

// Port of Signum.Files' FilesClient.tsx — the client entry point: the per-extension display info (icon +
// whether the browser can show it inline) and the URL builders the downloader uses.
//
// altea divergences:
//  - Signum registers a `FileDownloaderConfiguration` per file TYPE (FileEntity / FilePathEntity /
//    FileEmbedded / FilePathEmbedded). altea ports only the two EMBEDDED types, and their URLs are built from
//    the OWNING entity + property route (see server/FilesServer.server.ts), so the configuration collapses to
//    the two `fileUrl` helpers below.
//  - Signum's `FilesClient.start` also registers the FileLine / MultiFileLine as AutoLine defaults and the
//    ImageModal; altea's file lines are used explicitly (`<FileLine ctx=… />`), so `start` only registers the
//    entity views. MultiFile / image lines are not ported (no consumer yet).

export namespace FilesClient {

    export function start(cb: ClientBuilder): void {
        // Nothing to register per entity yet (both file holders are EMBEDDED, so they have no own view/route);
        // the parameter keeps the shape every altea module's `start(cb)` has, and is where a FileEntity view
        // would land if the standalone file entities get ported.
        void cb;
    }

    /** Signum's extensionInfo — how a file of a given extension is shown (icon + can the browser render it). */
    export interface ExtensionInfo {
        icon?: IconProp;
        color?: string;
        browserView?: boolean;
    }

    export const extensionInfo: { [extension: string]: ExtensionInfo } = {
        ["pdf"]: { icon: "file-pdf", color: "#d32f2f", browserView: true },
        ["png"]: { icon: "file-image", color: "#4caf50", browserView: true },
        ["jpg"]: { icon: "file-image", color: "#4caf50", browserView: true },
        ["jpeg"]: { icon: "file-image", color: "#4caf50", browserView: true },
        ["gif"]: { icon: "file-image", color: "#4caf50", browserView: true },
        ["webp"]: { icon: "file-image", color: "#4caf50", browserView: true },
        ["svg"]: { icon: "file-image", color: "#4caf50", browserView: true },
        ["txt"]: { icon: "file-lines", color: "#607d8b", browserView: true },
        ["csv"]: { icon: "file-csv", color: "#2e7d32" },
        ["xml"]: { icon: "file-code", color: "#607d8b", browserView: true },
        ["json"]: { icon: "file-code", color: "#607d8b", browserView: true },
        ["html"]: { icon: "file-code", color: "#e65100", browserView: true },
        ["zip"]: { icon: "file-zipper", color: "#795548" },
        ["doc"]: { icon: "file-word", color: "#1565c0" },
        ["docx"]: { icon: "file-word", color: "#1565c0" },
        ["xls"]: { icon: "file-excel", color: "#2e7d32" },
        ["xlsx"]: { icon: "file-excel", color: "#2e7d32" },
        ["ppt"]: { icon: "file-powerpoint", color: "#d84315" },
        ["pptx"]: { icon: "file-powerpoint", color: "#d84315" },
        ["mp3"]: { icon: "file-audio", color: "#6a1b9a" },
        ["mp4"]: { icon: "file-video", color: "#6a1b9a" },
    };

    export function infoFor(fileName: string | undefined): ExtensionInfo | undefined {
        const ext = fileName?.tryAfterLast(".")?.toLowerCase();
        return ext == null ? undefined : extensionInfo[ext];
    }

    /** The download URL of a FilePathEmbedded / FileEmbedded, addressed through its OWNER (see FilesServer). */
    export function fileUrl(file: FilePathEmbedded | FileEmbedded, container: Entity, propertyRoute: string, rowId?: string | number): string {
        const kind = file instanceof FilePathEmbedded ? "downloadEmbeddedFilePath" : "downloadEmbedded";
        const query = new URLSearchParams({ route: propertyRoute });
        if (rowId != null)
            query.set("rowId", String(rowId));

        return toAbsoluteUrl(`/api/files/${kind}/${getTypeName(container)}/${container.id}?${query.toString()}`);
    }
}
