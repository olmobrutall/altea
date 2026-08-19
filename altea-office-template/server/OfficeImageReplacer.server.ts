// Port of Signum.Word's WordImageReplacer.cs — swapping a PLACEHOLDER image in a template for a real one.
//
// The addressing works the same way TableBinder's does, and for the same reason: there is no token syntax
// for "put a picture here". The author inserts any image, then names it in the shape's **alternative text**:
//
//     Word: right-click the image -> Format Picture -> Alt Text -> Title (or Description)
//
// Code then calls `replaceImage(package, "Logo", bytes)`. The drawing, its size, its position and its
// wrapping are the author's; only the image BYTES change.
//
// altea divergences:
//  - `IImageConverter<TImage>` exists for the same reason as in Signum (System.Drawing is Windows-only, so
//    the image library is pluggable), but here it is OPTIONAL. Signum always needs one because its API is
//    generic over TImage; altea's default currency is raw bytes, so the common case — replace this
//    placeholder with these PNG bytes — needs no image library at all. A converter is only required for
//    `adaptSize`, which has to decode the placeholder to learn its pixel size and re-encode the result.
//  - Signum's two concrete converters (GdiBitmapConverter / ImageSharpConverter) are NOT ported: both are
//    .NET-only, and they are the pluggable half by design. An app that wants `adaptSize` supplies its own,
//    backed by whatever it already depends on.
//  - `ImagePartType` (an SDK enum) becomes the image's CONTENT TYPE, derived from the file extension.

import { OxmlElement } from "./oxml/OxmlElement.server";
import { RelationshipTypes, type OxmlPackage, type OxmlPart } from "./oxml/OxmlPackage.server";

/** Where a resized image sits inside the placeholder's box (Signum's ImageVerticalPosition). */
export type ImageVerticalPosition = "Top" | "Center" | "Bottom";
/** Signum's ImageHorizontalPosition. */
export type ImageHorizontalPosition = "Left" | "Center" | "Right";

/**
 * Signum's `IImageConverter<TImage>` — the pluggable image library.
 *
 * Only needed for `adaptSize`. An implementation typically wraps `sharp` or an equivalent; altea ships
 * none, exactly as Signum ships its two only as optional add-ons.
 */
export interface IImageConverter {
    getSize(image: Uint8Array): { width: number; height: number };
    resize(
        image: Uint8Array, maxWidth: number, maxHeight: number,
        verticalPosition: ImageVerticalPosition, horizontalPosition: ImageHorizontalPosition,
    ): Uint8Array;
}

export interface ReplaceImageOptions {
    /** Scale the new image to the placeholder's pixel size. Requires a `converter`. */
    adaptSize?: boolean;
    converter?: IImageConverter;
    verticalPosition?: ImageVerticalPosition;
    horizontalPosition?: ImageHorizontalPosition;
    /** The new part's content type; derived from `fileName` when omitted, else PNG. */
    contentType?: string;
    /** Names the new media part (`word/media/<fileName>`); defaults to a generated `image<N>.png`. */
    fileName?: string;
}

/**
 * Signum's ReplaceImage — replace the single placeholder named `titleOrDescription` with `image`.
 *
 * Throws when the name matches no drawing or more than one, because either is an authoring mistake that
 * would otherwise silently produce a report with the wrong picture.
 */
export function replaceImage(
    package_: OxmlPackage, titleOrDescription: string, image: Uint8Array, options: ReplaceImageOptions = {},
): void {
    const { blip, part } = findBlip(package_, titleOrDescription);

    let bytes = image;
    if (options.adaptSize) {
        const converter = requireConverter(options.converter);
        const old = blipBytes(package_, part, blip);
        const size = converter.getSize(old);
        bytes = converter.resize(
            image, size.width, size.height,
            options.verticalPosition ?? "Center", options.horizontalPosition ?? "Center");
    }

    replaceBlipContent(package_, part, blip, bytes, options);
}

/**
 * Signum's ReplaceMultipleImages — replace EVERY placeholder carrying this name, in document order, with
 * the matching entry of `images`.
 *
 * The counts must match exactly: a mismatch means the template and the code disagree about how many
 * pictures there are, which is never something to guess at.
 */
export function replaceMultipleImages(
    package_: OxmlPackage, titleOrDescription: string, images: Uint8Array[], options: ReplaceImageOptions = {},
): void {
    const found = findAllBlips(package_, p =>
        p.getAttribute("title") === titleOrDescription || p.getAttribute("descr") === titleOrDescription);

    if (found.length !== images.length)
        throw new Error(
            `Images count does not match: the template has ${found.length} image(s) named ` +
            `'${titleOrDescription}', ${images.length} were supplied`);

    found.forEach(({ blip, part }, i) => {
        let bytes = images[i];
        if (options.adaptSize) {
            const converter = requireConverter(options.converter);
            const size = converter.getSize(blipBytes(package_, part, blip));
            bytes = converter.resize(
                bytes, size.width, size.height,
                options.verticalPosition ?? "Center", options.horizontalPosition ?? "Center");
        }
        replaceBlipContent(package_, part, blip, bytes, options);
    });
}

/**
 * Signum's RemoveImage — drop the placeholder.
 *
 * `removeFullDrawing` decides how much goes: the whole `w:drawing` (the picture and the space it occupied)
 * or just the `a:blip`, which leaves an empty frame of the original size — useful when the layout depends
 * on that space being reserved.
 */
export function removeImage(package_: OxmlPackage, titleOrDescription: string, removeFullDrawing: boolean): void {
    const { blip, part } = findBlip(package_, titleOrDescription);
    removeBlip(package_, part, blip, removeFullDrawing);
}

/** Signum's RemoveMultipleImage. */
export function removeMultipleImages(package_: OxmlPackage, titleOrDescription: string, removeFullDrawing: boolean): void {
    const found = findAllBlips(package_, p =>
        p.getAttribute("title") === titleOrDescription || p.getAttribute("descr") === titleOrDescription);

    for (const { blip, part } of found)
        removeBlip(package_, part, blip, removeFullDrawing);
}

/** Signum's HasBlip — is there a placeholder with this name? */
export function hasBlip(package_: OxmlPackage, titleOrDescription: string): boolean {
    return findAllBlips(package_, p =>
        p.getAttribute("title") === titleOrDescription || p.getAttribute("descr") === titleOrDescription).length > 0;
}

// ---- blip lookup ---------------------------------------------------------------------------------------

/** One `a:blip` together with the part it lives in (needed to resolve its relationship id). */
export interface BlipRef {
    readonly blip: OxmlElement;
    readonly part: OxmlPart;
}

/** Signum's FindBlip — exactly one match, or an error naming which way it went wrong. */
export function findBlip(package_: OxmlPackage, titleOrDescription: string): BlipRef {
    const found = findAllBlips(package_, p =>
        p.getAttribute("title") === titleOrDescription || p.getAttribute("descr") === titleOrDescription);

    if (found.length === 0)
        throw new Error(`No image with Title or Description '${titleOrDescription}' found in the template`);
    if (found.length > 1)
        throw new Error(
            `${found.length} images with Title or Description '${titleOrDescription}' found in the template; ` +
            `use replaceMultipleImages to replace them all`);

    return found[0];
}

/** Signum's FindAllBlips — every drawing whose `wp:docPr` satisfies `predicate`, in document order. */
export function findAllBlips(package_: OxmlPackage, predicate: (docPr: OxmlElement) => boolean): BlipRef[] {
    const out: BlipRef[] = [];

    for (const part of drawingParts(package_)) {
        for (const drawing of part.document.root.descendantsNamed("w:drawing")) {
            const docPr = [...drawing.descendants()].find(d => d.qualifiedName === "wp:docPr");
            if (docPr == null || !predicate(docPr))
                continue;

            const blips = [...drawing.descendants()].filter(d => d.qualifiedName === "a:blip");

            // DIVERGENCE: Signum takes `SingleEx()` here, which throws on a drawing with no blip. But not
            // every `w:drawing` is a picture — a TEXT BOX is one too, and Southwind's own Order.docx has
            // one. A blip-less drawing is simply not an image placeholder, so skip it; that also makes
            // `findAllBlips(() => true)` usable for discovering what a template contains. More than one
            // blip in a single drawing IS ambiguous, so that still throws.
            if (blips.length === 0)
                continue;
            if (blips.length > 1)
                throw new Error(
                    `Expected at most one <a:blip> in the drawing '${docPr.getAttribute("name") ?? ""}', found ${blips.length}`);

            out.push({ blip: blips[0], part });
        }
    }

    return out;
}

/**
 * Signum's GetDrawings — the main document plus every header and footer.
 *
 * Headers and footers matter more than they look: a logo placeholder almost always lives in one of them,
 * and each is its OWN part with its own relationships, which is why `BlipRef` carries the part.
 */
function drawingParts(package_: OxmlPackage): OxmlPart[] {
    const main = package_.mainPart;
    return [main, ...main.partsOfType(RelationshipTypes.header), ...main.partsOfType(RelationshipTypes.footer)]
        .filter(p => p.isXml);
}

// ---- part surgery --------------------------------------------------------------------------------------

/** The bytes the blip currently points at. */
function blipBytes(package_: OxmlPackage, part: OxmlPart, blip: OxmlElement): Uint8Array {
    const embed = blip.getAttribute("r:embed");
    const imagePart = embed == null ? undefined : part.getPartById(embed);
    if (imagePart == null)
        throw new Error(`The image relationship '${embed}' does not resolve to a part of the package`);
    return imagePart.getBytes();
}

/** Signum's ReplaceBlipContent — drop the old media part, add a new one, re-point the blip at it. */
export function replaceBlipContent(
    package_: OxmlPackage, part: OxmlPart, blip: OxmlElement, image: Uint8Array, options: ReplaceImageOptions = {},
): void {
    const embed = blip.getAttribute("r:embed");
    const oldPart = embed == null ? undefined : part.getPartById(embed);
    if (oldPart != null)
        package_.deletePart(part, oldPart);

    const fileName = options.fileName ?? nextMediaFileName(package_, options.contentType);
    const contentType = options.contentType ?? contentTypeOf(fileName);
    const imagePart = package_.addPart(mediaUri(part, fileName), contentType, image);

    blip.setAttribute("r:embed", package_.addRelationship(part.uri, imagePart.uri, RelationshipTypes.image));
}

function removeBlip(package_: OxmlPackage, part: OxmlPart, blip: OxmlElement, removeFullDrawing: boolean): void {
    const embed = blip.getAttribute("r:embed");
    const imagePart = embed == null ? undefined : part.getPartById(embed);
    if (imagePart != null)
        package_.deletePart(part, imagePart);

    if (removeFullDrawing) {
        const drawing = [...blip.ancestors()].find(a => a.qualifiedName === "w:drawing");
        if (drawing == null)
            throw new Error("The blip is not inside a <w:drawing>");
        drawing.remove();
    } else {
        blip.remove();
    }
}

/** `word/media/image3.png` for a main part, `word/media/…` for a header too (they share the folder). */
function mediaUri(part: OxmlPart, fileName: string): string {
    const folder = part.folder === "" ? "media" : part.folder + "/media";
    return `${folder}/${fileName}`;
}

/** The next free `imageN.<ext>` in the package, so a replacement never collides with an existing part. */
function nextMediaFileName(package_: OxmlPackage, contentType: string | undefined): string {
    const ext = extensionOf(contentType) ?? "png";
    const taken = new Set(package_.parts.map(p => p.uri));
    for (let n = 1; ; n++) {
        const candidate = `image${n}.${ext}`;
        if (![...taken].some(uri => uri.endsWith("/" + candidate)))
            return candidate;
    }
}

const imageContentTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    emf: "image/x-emf",
    wmf: "image/x-wmf",
};

function contentTypeOf(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    const ext = dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
    return imageContentTypes[ext] ?? "image/png";
}

function extensionOf(contentType: string | undefined): string | undefined {
    if (contentType == null)
        return undefined;
    return Object.entries(imageContentTypes).find(([, ct]) => ct === contentType)?.[0];
}

function requireConverter(converter: IImageConverter | undefined): IImageConverter {
    if (converter == null)
        throw new Error(
            "adaptSize requires an IImageConverter: it has to decode the placeholder to read its pixel size " +
            "and re-encode the result. altea ships none (Signum's two are .NET-only) — supply one backed by " +
            "whatever image library the app already uses.");
    return converter;
}
