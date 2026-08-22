// XML text <-> XmlElement tree (see xmlElement.ts for the tree itself). The read half delegates to
// `fast-xml-parser` (already a dependency of @altea/altea, used by the user-asset and AuthRules XML); the
// write half is hand-written so escaping, attribute order and empty-element form are exactly under our
// control — a document that round-trips with a subtly different encoding is one Word (or a BPMN modeler)
// may refuse to open.
//
// A pragmatic XML subset is supported: one root element, an optional declaration and prolog, attributes,
// text, comments and CDATA. No DTDs and no external entities — which is also the right posture for
// documents uploaded by users.
//
// TWO deliberate choices, both learned from round-tripping a real Word document:
//
//  • Entities are decoded HERE, not by fast-xml-parser. Its `processEntities` decodes named references
//    (`&amp;`) but leaves NUMERIC ones (`&#xA;`) alone, so re-escaping the result would turn `&#xA;` into
//    `&amp;#xA;` — a silent corruption. Parsing with entity processing OFF and running one left-to-right
//    decode pass over the raw text is both correct and immune to the double-decode hazard (`&amp;#xA;`
//    must stay the literal five characters `&#xA;`, and a two-pass decode would turn it into a newline).
//
//  • The prolog (declaration, processing instructions, leading comments) and the epilog (trailing
//    whitespace) are captured VERBATIM as strings rather than modelled, so they survive a round-trip
//    exactly. Reconstructing a `<?mso-contentType?>` from a parse tree cannot preserve its spacing.
//
// One accepted normalization: an element written `<x></x>` is re-emitted as `<x/>`. The two are the same
// XML infoset, and Office itself emits both forms.

import { XMLParser } from "fast-xml-parser";
import { XmlCData, XmlComment, XmlElement, XmlText, XmlTextWriter, type XmlNode } from "./xmlElement";

const TEXT = "#text";
const COMMENT = "#comment";
const CDATA = "#cdata";
const ATTRS = ":@";

const parser = new XMLParser({
    preserveOrder: true,          // keep document order + repeated tags — the tree IS the document
    ignoreAttributes: false,
    attributeNamePrefix: "",      // attribute keys stay exactly as written ("w:val", "xml:space", "xmlns:w")
    allowBooleanAttributes: true,
    trimValues: false,            // `<w:t xml:space="preserve"> </w:t>` must keep its space
    parseTagValue: false,         // never coerce "0123" / "1e5" to a number
    parseAttributeValue: false,
    processEntities: false,       // see the header — we decode entities ourselves, in one pass
    commentPropName: COMMENT,
    cdataPropName: CDATA,
});

/** A parsed part: its verbatim prolog/epilog plus the single root element. */
export class XmlDocument {
    constructor(
        public root: XmlElement,
        /** Everything before the root element's `<` — BOM, `<?xml …?>`, PIs, comments. Verbatim. */
        public readonly prolog: string = "",
        /** Everything after the root element's final `>`. Verbatim (usually a trailing newline). */
        public readonly epilog: string = "",
        /** Comments that followed the root element but preceded the epilog, in order. */
        public readonly trailingNodes: XmlNode[] = [],
    ) { }
}

export function parseXmlDocument(text: string): XmlDocument {
    // Slice off the prolog verbatim: everything up to the first `<` that starts a real element (i.e. is
    // not `<?…?>` or `<!…>`). Everything after the LAST `>` is the epilog.
    const rootStart = findRootStart(text);
    if (rootStart < 0)
        throw new Error("Malformed XML document: no root element");
    const lastGt = text.lastIndexOf(">");
    const prolog = text.slice(0, rootStart);
    const epilog = text.slice(lastGt + 1);
    const body = text.slice(rootStart, lastGt + 1);

    const nodes = parser.parse(body) as Record<string, unknown>[];

    let root: XmlElement | undefined;
    const trailingNodes: XmlNode[] = [];
    for (const raw of nodes) {
        const converted = convertNode(raw);
        if (converted == null)
            continue;
        if (converted instanceof XmlElement) {
            if (root != null)
                throw new Error("Malformed XML document: more than one root element");
            root = converted;
        } else if (root != null) {
            trailingNodes.push(converted); // a comment after the root
        }
    }

    if (root == null)
        throw new Error("Malformed XML document: no root element");

    return new XmlDocument(root, prolog, epilog, trailingNodes);
}

/** Index of the first `<` that opens an element (skipping `<?…?>` prologs and `<!…>` comments/doctypes). */
function findRootStart(text: string): number {
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== "<")
            continue;
        const next = text[i + 1];
        if (next !== "?" && next !== "!")
            return i;
    }
    return -1;
}

/** One `fast-xml-parser` preserveOrder entry -> one node. Returns undefined for entries we drop. */
function convertNode(raw: Record<string, unknown>): XmlNode | undefined {
    const keys = Object.keys(raw).filter(k => k !== ATTRS);
    if (keys.length === 0)
        return undefined;
    const name = keys[0];
    const value = raw[name];

    if (name === TEXT)
        return new XmlText(decodeXmlEntities(String(value ?? "")));

    if (name === COMMENT)
        return new XmlComment(rawInnerTextOf(value)); // comment bodies are not entity-encoded

    if (name === CDATA)
        return new XmlCData(rawInnerTextOf(value));   // CDATA is literal by definition

    if (name.startsWith("?"))
        return undefined; // a processing instruction inside the body — neither OOXML nor BPMN uses them

    const element = new XmlElement(name);
    const attrs = raw[ATTRS] as Record<string, unknown> | undefined;
    if (attrs != null)
        for (const [k, v] of Object.entries(attrs))
            element.attributes.set(k, v === true ? "" : decodeXmlEntities(String(v)));

    if (Array.isArray(value))
        for (const child of value as Record<string, unknown>[]) {
            const c = convertNode(child);
            if (c != null)
                element.appendChild(c);
        }

    return element;
}

/** `#comment` / `#cdata` carry their payload as a nested `[{ '#text': … }]`. */
function rawInnerTextOf(value: unknown): string {
    if (Array.isArray(value)) {
        let s = "";
        for (const entry of value as Record<string, unknown>[])
            if (entry[TEXT] != null)
                s += String(entry[TEXT]);
        return s;
    }
    return String(value ?? "");
}

const entityRegex = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g;
const namedEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/**
 * Decode XML character/entity references in ONE left-to-right pass, so a reference produced by decoding
 * another (`&amp;#xA;` -> the literal `&#xA;`) is never decoded a second time.
 */
export function decodeXmlEntities(s: string): string {
    if (!s.includes("&"))
        return s;
    return s.replace(entityRegex, (_m, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
        if (hex != null)
            return safeFromCodePoint(parseInt(hex, 16));
        if (dec != null)
            return safeFromCodePoint(parseInt(dec, 10));
        return namedEntities[named!];
    });
}

/** An out-of-range or surrogate code point is not valid XML; leave such a reference untouched. */
function safeFromCodePoint(code: number): string {
    if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF))
        return "�";
    return String.fromCodePoint(code);
}

export function serializeXmlDocument(doc: XmlDocument): string {
    const writer = new XmlTextWriter();
    writer.writeRaw(doc.prolog);
    doc.root.writeTo(writer);
    for (const n of doc.trailingNodes)
        n.writeTo(writer);
    writer.writeRaw(doc.epilog);
    return writer.toStringValue();
}

/** Serialize a detached subtree — used by the error paths that need to show what a node contains. */
export function serializeElement(element: XmlElement): string {
    const writer = new XmlTextWriter();
    element.writeTo(writer);
    return writer.toStringValue();
}
