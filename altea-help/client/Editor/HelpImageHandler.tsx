import * as React from "react";
import type { ImageHandlerBase, ImageInfo } from "@altea/altea-html-editor/client/Extensions/ImageExtension/ImageHandlerBase";
import { FileImage } from "@altea/altea-files/client/Components/FileImage";
import { toFile } from "@altea/altea-files/client/Components/FileUploader";
import { FilePathEmbedded } from "@altea/altea-files/data/Files";
import { HelpImageEntity, HelpImageFileType } from "../../data/Help";

// Port of Signum.Help's Editor/HelpImageNode.tsx — the `ImageHandlerBase` altea-html-editor's
// ImageExtension asks for: how a dropped/pasted blob becomes a stored image, how it renders inside the
// editor, and how it round-trips through an `<img>` in the saved HTML.
//
// This is the seam altea-html-editor's own header pointed at ("altea has no built-in implementation —
// Signum's lives in Signum.Help, which is not ported"). It is ported now.
//
// altea divergences:
//  - **`binaryFile` is a `Uint8Array` in altea and a base64 STRING in Signum.** The `<img>` attribute and
//    `ImageInfo.binaryFile` are base64 either way (they live in HTML), so the two conversions happen
//    here — which is also where the server-side `InlineImagesLogic` decodes it back.
//  - `pr.member.defaultFileTypeInfo` has no counterpart: altea has no `@defaultFileType` reflection, so
//    the file type is named directly (`HelpImageFileType.Image`) and the size limit is this handler's own
//    constant rather than a reflected one.
//  - `FileImage` takes the file plus its ROUTING (altea addresses a download by its owner + route, never
//    by a raw suffix — see altea-files), so a stored image passes the owning entity id and route rather
//    than Signum's `entityId` / `rootType` / `propertyRoute` triple set by hand.

/** Signum's `maxSizeInBytes` came from the reflected DefaultFileType; altea states it (4 MB). */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export class HelpImageHandler implements ImageHandlerBase {

    async uploadData(blob: Blob): Promise<ImageInfo> {
        const file = blob instanceof File
            ? blob
            : new File([blob], "pastedImage." + (blob.type.tryAfter("/") ?? "png"), { type: blob.type });

        const fpe = await toFile(file, {
            kind: "FilePathEmbedded",
            fileType: HelpImageFileType.Image,
            maxSizeInBytes: MAX_IMAGE_BYTES,
        }) as FilePathEmbedded;

        return {
            binaryFile: fpe.binaryFile == null ? undefined : bytesToBase64(fpe.binaryFile),
            fileName: fpe.fileName,
        };
    }

    renderImage(info: ImageInfo): React.ReactElement {
        // A freshly pasted image still carries its bytes; a stored one carries only its id, and its bytes
        // are fetched through the owner-addressed download route.
        if (info.binaryFile != undefined) {
            const file = FilePathEmbedded.create({
                fileType: HelpImageFileType.Image,
                fileName: info.fileName ?? "image.png",
                binaryFile: base64ToBytes(info.binaryFile),
            });
            return <FileImage file={file} alt={info.fileName ?? ""} />;
        }

        if (info.imageId != undefined) {
            const file = FilePathEmbedded.create({
                fileType: HelpImageFileType.Image,
                fileName: info.fileName ?? "image.png",
            });
            file.setRouting(HelpImageEntity.name, info.imageId, "file");
            return <FileImage file={file} alt={info.fileName ?? ""} />;
        }

        return <div className="alert alert-danger">{JSON.stringify(info)}</div>;
    }

    toElement(val: ImageInfo): HTMLElement | undefined {
        const img = document.createElement("img");

        if (val.binaryFile)
            img.setAttribute("data-binary-file", val.binaryFile);
        img.setAttribute("data-file-name", val.fileName ?? "");
        if (val.imageId)
            img.setAttribute("data-help-image-id", val.imageId);

        return img;
    }

    fromElement(element: HTMLElement): ImageInfo | undefined {
        if (element.tagName !== "IMG")
            return undefined;

        return {
            binaryFile: element.dataset["binaryFile"],
            fileName: element.dataset["fileName"],
            imageId: element.dataset["helpImageId"],
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
