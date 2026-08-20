// The OPC (Open Packaging Conventions) layer — altea's stand-in for `OpenXmlPackage` and its
// `WordprocessingDocument` / `PresentationDocument` / `SpreadsheetDocument` subclasses.
//
// An Office file is a ZIP of "parts" (each a URI like `word/document.xml`), described by two side files:
//
//   [Content_Types].xml   — the content type of every part, by extension (Default) or by name (Override)
//   <dir>/_rels/<f>.rels  — the relationships FROM part `<dir>/<f>` to other parts (and to external URLs)
//
// Signum reaches the parts through the SDK's typed graph (`document.MainDocumentPart.HeaderParts`, …); the
// port instead enumerates the package's parts directly and resolves relationships by id, which is what the
// port actually needs — `AllParts()` / `AllRootElements()` walks, plus targeted lookups for images and
// charts. The typed convenience properties the port uses (`mainPart`, `workbookPart`) are derived from the
// package-level relationship types rather than hard-coded paths, since Office does not guarantee the path.
//
// A part is re-serialized on save ONLY if its XML was materialised (`part.document`), so every part the
// template never touches — media, themes, fonts, the ~30 parts of a typical .docx — is written back
// byte-for-byte from the bytes we read.

import { unzipSync, zipSync } from "fflate";
import { OxmlElement } from "./OxmlElement.server";
import { OxmlDocument, parseXmlDocument, serializeXmlDocument } from "./OxmlXml.server";

const CONTENT_TYPES_PART = "[Content_Types].xml";
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1));
const PACKAGE_RELS_PART = "_rels/.rels";

/** Relationship types this port needs to recognise by name (the OPC/OOXML well-known set). */
export const RelationshipTypes = {
    officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
    image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    chart: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart",
    package: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package",
    oleObject: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject",
    worksheet: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
    sharedStrings: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings",
    styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
    comments: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
    vmlDrawing: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing",
    header: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
    footer: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
} as const;

/** The three document flavours the port supports (Signum's three `…Document` package classes). */
export type OfficeDocumentKind = "word" | "presentation" | "spreadsheet";

const mainPartContentTypes: { kind: OfficeDocumentKind; contentType: string }[] = [
    { kind: "word", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" },
    { kind: "word", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml" },
    { kind: "presentation", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml" },
    { kind: "presentation", contentType: "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml" },
    { kind: "presentation", contentType: "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml" },
    { kind: "spreadsheet", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" },
    { kind: "spreadsheet", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml" },
];

/** One relationship row out of a `.rels` part. */
export interface OxmlRelationship {
    readonly id: string;
    readonly type: string;
    /** As written in the .rels file — relative to the SOURCE part's folder, unless `external`. */
    readonly target: string;
    readonly external: boolean;
    /** The absolute part URI the target resolves to (undefined when `external`). */
    readonly targetPartUri: string | undefined;
}

/** One part of the package. XML content is parsed lazily and only re-serialized if it was touched. */
export class OxmlPart {
    private parsed: OxmlDocument | undefined;
    private touched = false;

    constructor(
        readonly package_: OxmlPackage,
        /** The absolute part URI, no leading slash: "word/document.xml". */
        readonly uri: string,
        readonly contentType: string,
        private bytes: Uint8Array,
    ) { }

    /** True when this part holds XML (as opposed to media / embedded binaries). */
    get isXml(): boolean {
        return this.contentType.endsWith("+xml") || this.contentType === "text/xml" || this.contentType === "application/xml";
    }

    /**
     * The parsed XML document, materialised on first access. Accessing it marks the part dirty — the port
     * only ever reads a part's XML in order to rewrite it, so this is the right default and keeps every
     * untouched part byte-identical on save.
     */
    get document(): OxmlDocument {
        if (!this.isXml)
            throw new Error(`Part '${this.uri}' (${this.contentType}) is not XML`);
        if (this.parsed == null)
            this.parsed = parseXmlDocument(new TextDecoder("utf-8").decode(this.bytes));
        this.touched = true;
        return this.parsed;
    }

    /** The part's root element, or undefined for a non-XML part (the SDK's `RootElement`). */
    get rootElement(): OxmlElement | undefined {
        return this.isXml ? this.document.root : undefined;
    }

    /** Raw bytes — for media parts, and for the writer. */
    getBytes(): Uint8Array {
        if (this.touched && this.parsed != null)
            return new TextEncoder().encode(serializeXmlDocument(this.parsed));
        return this.bytes;
    }

    /** Replace a media part's content (used by the image replacer). */
    setBytes(bytes: Uint8Array): void {
        this.bytes = bytes;
        this.parsed = undefined;
        this.touched = false;
    }

    /** The folder this part lives in, "" for a root-level part. Used to resolve relative rel targets. */
    get folder(): string {
        const i = this.uri.lastIndexOf("/");
        return i < 0 ? "" : this.uri.slice(0, i);
    }

    /** The relationships declared BY this part (its `_rels/<name>.rels` side file). */
    get relationships(): readonly OxmlRelationship[] {
        return this.package_.relationshipsOf(this.uri);
    }

    /** The part a relationship id points at, or undefined (the SDK's `GetPartById`). */
    getPartById(id: string): OxmlPart | undefined {
        const rel = this.relationships.find(r => r.id === id);
        return rel?.targetPartUri == null ? undefined : this.package_.getPart(rel.targetPartUri);
    }

    /** The relationship id that points at `part` from this part (the SDK's `GetIdOfPart`). */
    getIdOfPart(part: OxmlPart): string | undefined {
        return this.relationships.find(r => r.targetPartUri === part.uri)?.id;
    }

    /** Every part this one relates to, of a given relationship type. */
    partsOfType(relationshipType: string): OxmlPart[] {
        return this.relationships
            .filter(r => r.type === relationshipType && r.targetPartUri != null)
            .map(r => this.package_.getPart(r.targetPartUri!))
            .filter((p): p is OxmlPart => p != null);
    }

    /** Parts that declare a relationship pointing AT this part (the SDK's `GetParentParts`). */
    getParentParts(): OxmlPart[] {
        return this.package_.parts.filter(p => p.relationships.some(r => r.targetPartUri === this.uri));
    }

    toString(): string { return this.uri; }
}

export class OxmlPackage {
    /** partUri -> part. Excludes `[Content_Types].xml` and the `_rels/*.rels` side files. */
    private readonly partsByUri = new Map<string, OxmlPart>();
    /** source part uri ("" for the package itself) -> its relationships. */
    private readonly relsBySource = new Map<string, OxmlRelationship[]>();
    /** The raw bytes of every zip entry, so untouched entries are written back verbatim. */
    private readonly rawEntries = new Map<string, Uint8Array>();
    /** Content types: by lower-cased extension (Default) and by exact part uri (Override). */
    private readonly defaultsByExtension = new Map<string, string>();
    private readonly overridesByPart = new Map<string, string>();
    /** Rels files that were rewritten (a part added / removed) and must be re-emitted. */
    private readonly dirtyRelsSources = new Set<string>();
    private contentTypesDirty = false;

    private constructor() { }

    static load(bytes: Uint8Array): OxmlPackage {
        const pkg = new OxmlPackage();
        const entries = unzipSync(bytes);

        for (const [name, data] of Object.entries(entries)) {
            if (name.endsWith("/"))
                continue; // a directory entry
            pkg.rawEntries.set(name, data);
        }

        pkg.readContentTypes();
        pkg.readAllRelationships();

        for (const [name, data] of pkg.rawEntries) {
            if (name === CONTENT_TYPES_PART || isRelsPart(name))
                continue;
            pkg.partsByUri.set(name, new OxmlPart(pkg, name, pkg.contentTypeOf(name), data));
        }

        return pkg;
    }

    // ---- content types ------------------------------------------------------------------------

    private readContentTypes(): void {
        const raw = this.rawEntries.get(CONTENT_TYPES_PART);
        if (raw == null)
            throw new Error("Not an Office Open XML package: [Content_Types].xml is missing");

        const root = parseXmlDocument(new TextDecoder("utf-8").decode(raw)).root;
        for (const e of root.elements()) {
            if (e.localName === "Default") {
                const ext = e.getAttribute("Extension");
                const ct = e.getAttribute("ContentType");
                if (ext != null && ct != null)
                    this.defaultsByExtension.set(ext.toLowerCase(), ct);
            } else if (e.localName === "Override") {
                const name = e.getAttribute("PartName");
                const ct = e.getAttribute("ContentType");
                if (name != null && ct != null)
                    this.overridesByPart.set(name.replace(/^\//, ""), ct);
            }
        }
    }

    private contentTypeOf(partUri: string): string {
        const override = this.overridesByPart.get(partUri);
        if (override != null)
            return override;
        const dot = partUri.lastIndexOf(".");
        const ext = dot < 0 ? "" : partUri.slice(dot + 1).toLowerCase();
        return this.defaultsByExtension.get(ext) ?? "application/octet-stream";
    }

    /** Ensure the package declares a content type for `extension`; adds a Default entry if missing. */
    ensureDefaultContentType(extension: string, contentType: string): void {
        const key = extension.toLowerCase();
        if (this.defaultsByExtension.has(key))
            return;
        this.defaultsByExtension.set(key, contentType);
        this.contentTypesDirty = true;
    }

    // ---- relationships ------------------------------------------------------------------------

    private readAllRelationships(): void {
        for (const [name, data] of this.rawEntries) {
            if (!isRelsPart(name))
                continue;
            const source = sourceOfRelsPart(name);
            this.relsBySource.set(source, this.parseRels(source, data));
        }
    }

    private parseRels(sourceUri: string, data: Uint8Array): OxmlRelationship[] {
        const root = parseXmlDocument(new TextDecoder("utf-8").decode(data)).root;
        const sourceFolder = sourceUri === "" ? "" : folderOf(sourceUri);
        const out: OxmlRelationship[] = [];
        for (const e of root.elements()) {
            if (e.localName !== "Relationship")
                continue;
            const id = e.getAttribute("Id");
            const type = e.getAttribute("Type");
            const target = e.getAttribute("Target");
            if (id == null || type == null || target == null)
                continue;
            const external = e.getAttribute("TargetMode") === "External";
            out.push({
                id, type, target, external,
                targetPartUri: external ? undefined : resolvePartUri(sourceFolder, target),
            });
        }
        return out;
    }

    /** The relationships declared by a part ("" = the package itself). */
    relationshipsOf(sourceUri: string): readonly OxmlRelationship[] {
        return this.relsBySource.get(sourceUri) ?? [];
    }

    /** Add a relationship from `source` to `target`, returning the generated id. */
    addRelationship(sourceUri: string, targetPartUri: string, type: string): string {
        const list = this.relsBySource.get(sourceUri) ?? [];
        let n = list.length + 1;
        while (list.some(r => r.id === "rId" + n))
            n++;
        const id = "rId" + n;
        const sourceFolder = sourceUri === "" ? "" : folderOf(sourceUri);
        list.push({ id, type, target: relativeTarget(sourceFolder, targetPartUri), external: false, targetPartUri });
        this.relsBySource.set(sourceUri, list);
        this.dirtyRelsSources.add(sourceUri);
        return id;
    }

    // ---- parts --------------------------------------------------------------------------------

    /** Every part in the package (the SDK's `AllParts()`), excluding rels and content types. */
    get parts(): OxmlPart[] {
        return [...this.partsByUri.values()];
    }

    /** Every XML part's root element (Signum's `AllRootElements()`). */
    get allRootElements(): OxmlElement[] {
        return this.parts.filter(p => p.isXml).map(p => p.document.root);
    }

    getPart(uri: string): OxmlPart | undefined {
        return this.partsByUri.get(uri);
    }

    /** Add a new part with the given bytes; the caller wires the relationship. */
    addPart(uri: string, contentType: string, bytes: Uint8Array): OxmlPart {
        if (this.partsByUri.has(uri))
            throw new Error(`Part '${uri}' already exists`);
        const dot = uri.lastIndexOf(".");
        const ext = dot < 0 ? "" : uri.slice(dot + 1).toLowerCase();
        if (this.defaultsByExtension.get(ext) !== contentType) {
            this.overridesByPart.set(uri, contentType);
            this.contentTypesDirty = true;
        }
        const part = new OxmlPart(this, uri, contentType, bytes);
        this.partsByUri.set(uri, part);
        return part;
    }

    /**
     * Remove `part` and the relationship that points at it from `source` (the SDK's `DeletePart`).
     * The part itself is dropped only when nothing else still relates to it.
     */
    deletePart(source: OxmlPart, part: OxmlPart): void {
        const list = this.relsBySource.get(source.uri);
        if (list != null) {
            const kept = list.filter(r => r.targetPartUri !== part.uri);
            if (kept.length !== list.length) {
                this.relsBySource.set(source.uri, kept);
                this.dirtyRelsSources.add(source.uri);
            }
        }
        if (part.getParentParts().length === 0) {
            this.partsByUri.delete(part.uri);
            this.overridesByPart.delete(part.uri);
            this.contentTypesDirty = this.contentTypesDirty || true;
        }
    }

    // ---- typed entry points -------------------------------------------------------------------

    /** The package-level `officeDocument` relationship target: `word/document.xml` and friends. */
    get mainPart(): OxmlPart {
        const rel = this.relationshipsOf("").find(r => r.type === RelationshipTypes.officeDocument);
        const part = rel?.targetPartUri == null ? undefined : this.getPart(rel.targetPartUri);
        if (part == null)
            throw new Error("Not an Office Open XML package: no officeDocument relationship");
        return part;
    }

    /** Which of the three flavours this package is, derived from the main part's content type. */
    get kind(): OfficeDocumentKind {
        const ct = this.mainPart.contentType;
        const found = mainPartContentTypes.find(m => m.contentType === ct);
        if (found == null)
            throw new Error(`Unsupported Office document: main part content type '${ct}'`);
        return found.kind;
    }

    /** The workbook part of a .xlsx (Signum's `SpreadsheetDocument.WorkbookPart`), else undefined. */
    get workbookPart(): OxmlPart | undefined {
        return this.kind === "spreadsheet" ? this.mainPart : undefined;
    }

    // ---- save ---------------------------------------------------------------------------------

    save(): Uint8Array {
        const out: Record<string, Uint8Array> = {};

        // Untouched entries first, verbatim — including any rels file we did not rewrite.
        for (const [name, data] of this.rawEntries) {
            if (name === CONTENT_TYPES_PART)
                continue;
            if (isRelsPart(name)) {
                if (!this.dirtyRelsSources.has(sourceOfRelsPart(name)))
                    out[name] = data;
                continue;
            }
            if (this.partsByUri.has(name))
                continue; // written below, from the part (which may have been re-serialized)
            // The part was deleted — drop the entry.
        }

        for (const part of this.partsByUri.values())
            out[part.uri] = part.getBytes();

        for (const source of this.dirtyRelsSources)
            out[relsPartOf(source)] = new TextEncoder().encode(this.buildRelsXml(source));

        out[CONTENT_TYPES_PART] = this.contentTypesDirty
            ? new TextEncoder().encode(this.buildContentTypesXml())
            : this.rawEntries.get(CONTENT_TYPES_PART)!;

        // A FIXED timestamp keeps the output deterministic (the same template + data renders to the
        // same bytes). The ZIP DOS date field cannot represent anything before 1980, so that is the epoch
        // Office itself uses for generated packages.
        return zipSync(out, { level: 6, mtime: ZIP_EPOCH });
    }

    private buildRelsXml(source: string): string {
        const rels = this.relsBySource.get(source) ?? [];
        const rows = rels.map(r =>
            `<Relationship Id="${xmlAttr(r.id)}" Type="${xmlAttr(r.type)}" Target="${xmlAttr(r.target)}"` +
            (r.external ? ` TargetMode="External"` : "") + "/>").join("");
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows}</Relationships>`;
    }

    private buildContentTypesXml(): string {
        const defaults = [...this.defaultsByExtension].map(([ext, ct]) =>
            `<Default Extension="${xmlAttr(ext)}" ContentType="${xmlAttr(ct)}"/>`).join("");
        const overrides = [...this.overridesByPart]
            .filter(([uri]) => this.partsByUri.has(uri))
            .map(([uri, ct]) => `<Override PartName="/${xmlAttr(uri)}" ContentType="${xmlAttr(ct)}"/>`).join("");
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
            `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}${overrides}</Types>`;
    }
}

// ---- part-uri helpers ---------------------------------------------------------------------------

function isRelsPart(name: string): boolean {
    return name === PACKAGE_RELS_PART || (name.includes("/_rels/") && name.endsWith(".rels"));
}

/** `word/_rels/document.xml.rels` -> `word/document.xml`; `_rels/.rels` -> `` (the package). */
function sourceOfRelsPart(name: string): string {
    if (name === PACKAGE_RELS_PART)
        return "";
    const i = name.lastIndexOf("/_rels/");
    const folder = name.slice(0, i);
    const file = name.slice(i + "/_rels/".length, -".rels".length);
    return folder === "" ? file : folder + "/" + file;
}

/** The inverse: `word/document.xml` -> `word/_rels/document.xml.rels`. */
function relsPartOf(sourceUri: string): string {
    if (sourceUri === "")
        return PACKAGE_RELS_PART;
    const folder = folderOf(sourceUri);
    const file = sourceUri.slice(folder === "" ? 0 : folder.length + 1);
    return (folder === "" ? "" : folder + "/") + "_rels/" + file + ".rels";
}

function folderOf(uri: string): string {
    const i = uri.lastIndexOf("/");
    return i < 0 ? "" : uri.slice(0, i);
}

/** Resolve a relationship Target (relative to the source's folder, or absolute with a leading `/`). */
function resolvePartUri(sourceFolder: string, target: string): string {
    if (target.startsWith("/"))
        return target.slice(1);
    const segments = (sourceFolder === "" ? [] : sourceFolder.split("/"));
    for (const seg of target.split("/")) {
        if (seg === "." || seg === "")
            continue;
        if (seg === "..")
            segments.pop();
        else
            segments.push(seg);
    }
    return segments.join("/");
}

/** The inverse of resolvePartUri: express `targetPartUri` relative to `sourceFolder`. */
function relativeTarget(sourceFolder: string, targetPartUri: string): string {
    if (sourceFolder === "")
        return targetPartUri;
    const from = sourceFolder.split("/");
    const to = targetPartUri.split("/");
    let common = 0;
    while (common < from.length && common < to.length - 1 && from[common] === to[common])
        common++;
    const ups = from.length - common;
    return "../".repeat(ups) + to.slice(common).join("/");
}

function xmlAttr(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
