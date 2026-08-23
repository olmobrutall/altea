import * as React from "react";
import type { ImageHandlerBase, ImageInfo } from "@altea/altea-html-editor/client/Extensions/ImageExtension/ImageHandlerBase";
import { FileImage } from "@altea/altea-files/client/Components/FileImage";
import { toFile } from "@altea/altea-files/client/Components/FileUploader";
import { FilePathEmbedded } from "@altea/altea-files/data/Files";
import { WhatsNewEntity_Attachment, WhatsNewFileType } from "../data/WhatsNew";

// Port of Signum.WhatsNew's `WhatsNewImageHandler` (Templates/WhatsNewHtmlEditor.tsx) — how an image pasted
// into a news description is stored, rendered and round-tripped through the saved HTML.
//
// Structurally this is @altea/altea-help's HelpImageHandler with a different owner, and it makes the same two
// accommodations:
//  - **`binaryFile` is a `Uint8Array` in altea and a base64 STRING in Signum.** The `<img>` attribute and
//    `ImageInfo.binaryFile` are base64 either way (they live in HTML), so the two conversions happen here.
//  - `pr.member.defaultFileTypeInfo` has no counterpart (altea has no reflected `@defaultFileType`), so the
//    file type is named directly and the size limit is this handler's own constant.
// And one of its own: a stored image is addressed through the ATTACHMENT ROW that holds it —
// `WhatsNewEntity.Attachment` is an MList of bare FilePathEmbeddeds in Signum, hence a `@part` row here, and
// altea addresses a download by its owner + route rather than by Signum's hand-set
// `entityId` / `rootType` / `propertyRoute` triple.

/** Signum's `maxSizeInBytes` came from the reflected DefaultFileType; altea states it (4 MB). */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export class WhatsNewImageHandler implements ImageHandlerBase {

    async uploadData(blob: Blob): Promise<ImageInfo> {
        const file = blob instanceof File
            ? blob
            : new File([blob], "pastedImage." + (blob.type.tryAfter("/") ?? "png"), { type: blob.type });

        const fpe = await toFile(file, {
            kind: "FilePathEmbedded",
            fileType: WhatsNewFileType.WhatsNewAttachmentFileType,
            maxSizeInBytes: MAX_IMAGE_BYTES,
        }) as FilePathEmbedded;

        return {
            binaryFile: fpe.binaryFile == null ? undefined : bytesToBase64(fpe.binaryFile),
            fileName: fpe.fileName,
        };
    }

    renderImage(info: ImageInfo): React.ReactElement {
        // A freshly pasted image still carries its bytes; a stored one carries only the id of the attachment
        // row that holds it, and its bytes come through the owner-addressed download route.
        if (info.binaryFile != undefined) {
            const file = FilePathEmbedded.create({
                fileType: WhatsNewFileType.WhatsNewAttachmentFileType,
                fileName: info.fileName ?? "image.png",
                binaryFile: base64ToBytes(info.binaryFile),
            });
            return <FileImage file={file} alt={info.fileName ?? ""} className="mw-100 whatsnew-image" />;
        }

        if (info.imageId != undefined) {
            const file = FilePathEmbedded.create({
                fileType: WhatsNewFileType.WhatsNewAttachmentFileType,
                fileName: info.fileName ?? "image.png",
            });
            file.setRouting(WhatsNewEntity_Attachment.name, info.imageId, "file");
            return <FileImage file={file} alt={info.fileName ?? ""} className="mw-100 whatsnew-image" />;
        }

        return <div className="alert alert-danger">{JSON.stringify(info)}</div>;
    }

    toElement(val: ImageInfo): HTMLElement | undefined {
        const img = document.createElement("img");

        if (val.binaryFile)
            img.setAttribute("data-binary-file", val.binaryFile);
        img.setAttribute("data-file-name", val.fileName ?? "");
        if (val.imageId)
            img.setAttribute("data-attachment-id", val.imageId);

        return img;
    }

    fromElement(element: HTMLElement): ImageInfo | undefined {
        if (element.tagName !== "IMG")
            return undefined;

        return {
            binaryFile: element.dataset["binaryFile"],
            fileName: element.dataset["fileName"],
            imageId: element.dataset["attachmentId"],
        };
    }
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    // Chunked, because `String.fromCharCode(...bytes)` blows the argument limit on a real image.
    for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
    const payload = base64.includes(",") ? base64.substring(base64.indexOf(",") + 1) : base64;
    return Uint8Array.from(atob(payload), c => c.charCodeAt(0));
}
