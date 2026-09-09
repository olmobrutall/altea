import * as React from "react";
import type { FileEmbedded, FilePathEmbedded } from "@altea/altea-files/data/Files";
import { FilesClient } from "@altea/altea-files/client/FilesClient";
import { ajaxGetRaw } from "@altea/altea/client/Services";
import { ImageAttachmentEntity, type IAttachmentGeneratorEntity } from "../../data/EmailTemplate";
import type { EmailMessageEntity } from "../../data/EmailMessage";

// Port of Signum.Mailing's Templates/CidImages.ts.
//
// An INLINE attachment is referenced from the body as `<img src="cid:logo">`. The `cid:` protocol is
// understood by mail clients only, so every preview in the app has to re-point those images at bytes the
// browser can actually load — otherwise a template that looks right in Outlook shows broken images here.
//
// Two sources, which is why there are two entry points:
//  - a TEMPLATE preview (EmailTemplate / EmailMasterTemplate): the ImageAttachment rows travel WITH the
//    entity, so the bytes are already in hand;
//  - a MESSAGE preview: the attachment is a stored FilePathEmbedded, whose download route needs the
//    Authorization header — so a bare `src=` cannot fetch it and it goes through the app's own ajax.
//
// altea divergences from Signum:
//  - `binaryFile` is a `Uint8Array`, not base64, so an in-hand file becomes a **blob:** url rather than
//    Signum's `data:` url. A blob url has to be REVOKED, which is what `useObjectUrls` is for — Signum
//    needs the lifecycle only in EmailMessage (where it writes the same Map inline) and altea needs it in
//    all four callers, so the hook is shared instead of copied.
//  - an attachment is a `@part` ROW wrapping the generator in a `@valueField`, not an `MList` element, so
//    the callers pass `attachments.map(a => a.attachment)` where Signum passes `a.element`.

/** Signum's `forEachCidImage` — visit every `<img src="cid:…">` in the rendered document. */
export function forEachCidImage(doc: Document, action: (img: HTMLImageElement, contentId: string) => void): void {
    doc.body.querySelectorAll("img").forEach(img => {
        const src = img.getAttribute("src");
        if (src != null && src.startsWith("cid:"))
            action(img, src.after("cid:"));
    });
}

/**
 * A url for bytes already in hand — Signum's `dataUrl`, as a **blob:** url (see the header). The caller
 * OWNS the returned url and must revoke it; every caller here does so through `useObjectUrls`.
 */
export function objectUrlFor(file: FileEmbedded | FilePathEmbedded): string {
    const mimeType = FilesClient.extensionInfo[file.fileName?.tryAfterLast(".")?.toLowerCase()!]?.mimeType
        ?? "application/octet-stream";

    return URL.createObjectURL(new Blob([file.binaryFile! as BlobPart], { type: mimeType }));
}

/**
 * A per-component cache of the blob urls the two replacers hand out, keyed by content id, revoked when the
 * component unmounts. Signum keeps this Map inline in EmailMessage and needs no equivalent for the template
 * previews (its `data:` urls own nothing); altea's blob urls do, so all four previews share this.
 */
export function useObjectUrls(): React.RefObject<Map<string, string>> {
    const objectUrls = React.useRef(new Map<string, string>());

    React.useEffect(() => () => {
        objectUrls.current.forEach(url => URL.revokeObjectURL(url));
        objectUrls.current.clear();
    }, []);

    return objectUrls;
}

/**
 * Signum's `replaceCidImages` — for the EmailTemplate / EmailMasterTemplate previews, where the bytes of
 * the ImageAttachments already travel with the entity.
 */
export function replaceCidImages(
    doc: Document,
    attachments: IAttachmentGeneratorEntity[],
    objectUrls: Map<string, string>,
): void {
    const images = attachments.filter(a => a instanceof ImageAttachmentEntity) as ImageAttachmentEntity[];

    forEachCidImage(doc, (img, contentId) => {
        const cached = objectUrls.get(contentId);
        if (cached != null) {
            img.src = cached;
            return;
        }

        const image = images.firstOrNull(a => a.contentId === contentId);
        if (image?.file?.binaryFile == null)
            return;

        const url = objectUrlFor(image.file);
        objectUrls.set(contentId, url);
        img.src = url;
    });
}

/**
 * Signum's `manipulateDom` from EmailMessage.tsx, lifted here beside its sibling: a MESSAGE's inline
 * attachment is a stored file, and its download route needs the Authorization header — so it cannot be an
 * `<img src>` and is fetched through the app's own ajax instead.
 */
export function replaceCidImagesOfMessage(
    doc: Document,
    message: EmailMessageEntity,
    objectUrls: Map<string, string>,
): void {
    forEachCidImage(doc, (img, contentId) => {
        const cached = objectUrls.get(contentId);
        if (cached != null) {
            img.src = cached;
            return;
        }

        const file = message.attachments.firstOrNull(a => a.contentId === contentId)?.file;
        if (file == null)
            return;

        // Not saved yet — the bytes came up with the form.
        if (file.binaryFile != null && file.binaryFile.length > 0) {
            const url = objectUrlFor(file);
            objectUrls.set(contentId, url);
            img.src = url;
            return;
        }

        // Stored: `cache: "default"` on purpose — the download response carries an ETag and a long max-age
        // keyed on the file's hash (FilesServer), so a revisit is a 304 or a cache hit.
        const fetchUrl = FilesClient.fileUrl(file);
        if (fetchUrl == null)
            return;

        void ajaxGetRaw({ url: fetchUrl, cache: "default" })
            .then(r => r.blob())
            .then(blob => {
                const url = URL.createObjectURL(blob);
                objectUrls.set(contentId, url);
                img.src = url;
            });
    });
}
