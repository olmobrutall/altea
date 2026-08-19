// The mutable OOXML element tree — altea's stand-in for `DocumentFormat.OpenXml.OpenXmlElement`.
//
// DIVERGENCE (structural, unavoidable): Signum.Word is written against the OpenXML SDK, which gives it a
// strongly-typed, mutable DOM over the parts of a .docx / .pptx / .xlsx (`W.Paragraph`, `W.Run`, `S.Cell`, …).
// There is no such library for TypeScript, so this file provides the small slice of that DOM the port
// actually uses: an ordered element/text tree with `append` / `remove` / `cloneNode` / `descendants`, plus a
// virtual `writeTo` so a subclass can control its own serialization.
//
// That last point is the reason this is a class hierarchy and not a plain `{ name, attrs, children }` record:
// Signum's template nodes (MatchNode, TokenNode, ForeachNode, …) are themselves `OpenXmlElement` subclasses
// that are SPLICED INTO the document tree during parsing, walked with `Descendants<BaseNode>()`, and replaced
// during rendering. Keeping the same shape here means the parser and the node classes port line-for-line.
//
// Namespaces are handled the way OOXML itself does: by PREFIX. Every part declares its prefixes on the root
// element (`xmlns:w=…`) and never rebinds them, so `w:p` is a stable identity — matching on the qualified name
// is both correct and what the SDK's generated classes effectively do. `namespaceUriOf` resolves a prefix
// through the ancestor chain for the rare places that need the real URI.

/** The `xml:space="preserve"` values (Signum's `SpaceProcessingModeValues`). */
export const SpaceProcessingModeValues = {
    default: "default",
    preserve: "preserve",
} as const;
export type SpaceProcessingMode = typeof SpaceProcessingModeValues[keyof typeof SpaceProcessingModeValues];

/** Base of everything that can sit in an element's child list. */
export abstract class OxmlNode {
    /** Set by the containing element; `undefined` for a detached node or a part root. */
    parent: OxmlElement | undefined = undefined;

    /** Deep or shallow copy, DETACHED from any parent (the SDK's `CloneNode`). */
    abstract cloneNode(deep: boolean): OxmlNode;

    /** Serialize into `writer`. Virtual so template-node subclasses can override (Signum's `WriteTo`). */
    abstract writeTo(writer: XmlTextWriter): void;

    /** The concatenated text of this node and its descendants (the SDK's `InnerText`). */
    abstract get innerText(): string;

    /** Detach from the parent's child list (the SDK's `Remove()`). A no-op when already detached. */
    remove(): void {
        const p = this.parent;
        if (p == null)
            return;
        const i = p.childElements.indexOf(this);
        if (i >= 0)
            p.childElements.splice(i, 1);
        this.parent = undefined;
    }

    /** Replace this node in its parent with `nodes` (the SDK's `ReplaceBy`, generalised to many). */
    replaceBy(...nodes: OxmlNode[]): void {
        const p = this.parent;
        if (p == null)
            throw new Error("replaceBy on a detached node");
        const i = p.childElements.indexOf(this);
        for (const n of nodes)
            n.detachFromCurrentParent();
        p.childElements.splice(i, 1, ...nodes);
        for (const n of nodes)
            n.parent = p;
        this.parent = undefined;
    }

    /** Every ancestor, nearest first (the SDK's `Ancestors()`). */
    *ancestors(): Generator<OxmlElement> {
        let a = this.parent;
        while (a != null) {
            yield a;
            a = a.parent;
        }
    }

    /** The nearest ancestor of the given class, or undefined (the SDK's `Ancestors<T>().FirstOrDefault()`). */
    ancestorOfType<T extends OxmlElement>(ctor: abstract new (...args: never[]) => T): T | undefined {
        for (const a of this.ancestors())
            if (a instanceof ctor)
                return a;
        return undefined;
    }

    /** Internal: unhook from a previous parent before being adopted elsewhere. */
    protected detachFromCurrentParent(): void {
        this.remove();
    }
}

/** A text node. OOXML keeps significant text only inside leaf elements (`w:t`, `a:t`, `t` in a cell). */
export class OxmlText extends OxmlNode {
    constructor(public text: string) { super(); }

    override cloneNode(_deep: boolean): OxmlText { return new OxmlText(this.text); }
    override get innerText(): string { return this.text; }
    override writeTo(writer: XmlTextWriter): void { writer.writeText(this.text); }
}

/** An XML comment. Preserved so a round-trip does not silently drop authoring notes. */
export class OxmlComment extends OxmlNode {
    constructor(public text: string) { super(); }

    override cloneNode(_deep: boolean): OxmlComment { return new OxmlComment(this.text); }
    override get innerText(): string { return ""; }
    override writeTo(writer: XmlTextWriter): void { writer.writeComment(this.text); }
}

/** A `<![CDATA[…]]>` section. Rare in OOXML but legal, and dropping it would corrupt the part. */
export class OxmlCData extends OxmlNode {
    constructor(public text: string) { super(); }

    override cloneNode(_deep: boolean): OxmlCData { return new OxmlCData(this.text); }
    override get innerText(): string { return this.text; }
    override writeTo(writer: XmlTextWriter): void { writer.writeCData(this.text); }
}

/** An element: a qualified name, ordered attributes, and an ordered child list. */
export class OxmlElement extends OxmlNode {
    /** Ordered — OOXML consumers are order-sensitive and a stable order keeps diffs readable. */
    readonly attributes = new Map<string, string>();
    readonly childElements: OxmlNode[] = [];

    /**
     * @param qualifiedName the name AS WRITTEN, prefix included ("w:p", "a:t", "sheetData").
     */
    constructor(public qualifiedName: string) { super(); }

    /** "w" for "w:p"; "" for an unprefixed name. */
    get prefix(): string {
        const i = this.qualifiedName.indexOf(":");
        return i < 0 ? "" : this.qualifiedName.slice(0, i);
    }

    /** "p" for "w:p" (the SDK's `LocalName`). */
    get localName(): string {
        const i = this.qualifiedName.indexOf(":");
        return i < 0 ? this.qualifiedName : this.qualifiedName.slice(i + 1);
    }

    /** Resolve this element's prefix to a namespace URI through the ancestor `xmlns:` declarations. */
    get namespaceUri(): string | undefined {
        const attr = this.prefix === "" ? "xmlns" : "xmlns:" + this.prefix;
        for (const e of [this as OxmlElement, ...this.ancestors()]) {
            const v = e.attributes.get(attr);
            if (v != null)
                return v;
        }
        return undefined;
    }

    // ---- attributes ---------------------------------------------------------------------------

    getAttribute(name: string): string | undefined { return this.attributes.get(name); }

    setAttribute(name: string, value: string): this {
        this.attributes.set(name, value);
        return this;
    }

    removeAttribute(name: string): void { this.attributes.delete(name); }

    /** `xml:space` as a typed value; OOXML omits it to mean "default" (collapse surrounding whitespace). */
    get space(): SpaceProcessingMode {
        return this.attributes.get("xml:space") === "preserve" ? "preserve" : "default";
    }
    set space(value: SpaceProcessingMode) {
        if (value === "preserve")
            this.attributes.set("xml:space", "preserve");
        else
            this.attributes.delete("xml:space");
    }

    // ---- children -----------------------------------------------------------------------------

    /** Append one node, detaching it from any previous parent first (the SDK's `AppendChild`). */
    appendChild<T extends OxmlNode>(node: T): T {
        node.remove();
        node.parent = this;
        this.childElements.push(node);
        return node;
    }

    /** Append many (the SDK's `Append(params …)`). */
    append(...nodes: OxmlNode[]): this {
        for (const n of nodes)
            this.appendChild(n);
        return this;
    }

    prependChild<T extends OxmlNode>(node: T): T {
        node.remove();
        node.parent = this;
        this.childElements.unshift(node);
        return node;
    }

    /** Insert `node` immediately after `reference`, which must be a child of this element. */
    insertAfter<T extends OxmlNode>(node: T, reference: OxmlNode): T {
        const i = this.childElements.indexOf(reference);
        if (i < 0)
            throw new Error("insertAfter: the reference node is not a child of this element");
        node.remove();
        node.parent = this;
        this.childElements.splice(i + 1, 0, node);
        return node;
    }

    /** Insert `node` immediately before `reference`, which must be a child of this element. */
    insertBefore<T extends OxmlNode>(node: T, reference: OxmlNode): T {
        const i = this.childElements.indexOf(reference);
        if (i < 0)
            throw new Error("insertBefore: the reference node is not a child of this element");
        node.remove();
        node.parent = this;
        this.childElements.splice(i, 0, node);
        return node;
    }

    /** The index of `node` in this element's child list, or -1 (the SDK's `ChildElements.IndexOf`). */
    indexOf(node: OxmlNode): number {
        return this.childElements.indexOf(node);
    }

    /** Insert `node` at `index` (the SDK's `InsertAt`). */
    insertAt<T extends OxmlNode>(node: T, index: number): T {
        node.remove();
        node.parent = this;
        this.childElements.splice(index, 0, node);
        return node;
    }

    /** Swap `oldChild` for `newChild` in place (the SDK's `ReplaceChild`). */
    replaceChild(newChild: OxmlNode, oldChild: OxmlNode): void {
        const i = this.childElements.indexOf(oldChild);
        if (i < 0)
            throw new Error("replaceChild: the old child is not a child of this element");
        newChild.remove();
        this.childElements[i] = newChild;
        newChild.parent = this;
        oldChild.parent = undefined;
    }

    /** Detach `nodes` from wherever they are and append them here (Signum's `MoveChilds`). */
    moveChilds(nodes: Iterable<OxmlNode>): void {
        for (const c of [...nodes])
            this.appendChild(c);
    }

    /**
     * Detach `nodes` and insert them starting at `index`, returning the index just past the last one
     * (Signum's `MoveChildsAt(ref int index, …)` — C# passes the cursor by reference; TS returns it).
     */
    moveChildsAt(index: number, nodes: Iterable<OxmlNode>): number {
        for (const c of [...nodes])
            this.insertAt(c, index++);
        return index;
    }

    /** Drop every child (the SDK's `RemoveAllChildren()`). The parser rebuilds a paragraph this way. */
    removeAllChildren(): void {
        for (const c of this.childElements)
            c.parent = undefined;
        this.childElements.length = 0;
    }

    /** Detach one child (the SDK's `RemoveChild`). */
    removeChild<T extends OxmlNode>(node: T): T {
        node.remove();
        return node;
    }

    // ---- traversal ----------------------------------------------------------------------------

    /** Direct child ELEMENTS (text/comments skipped), optionally filtered by qualified name. */
    *elements(qualifiedName?: string): Generator<OxmlElement> {
        for (const c of this.childElements)
            if (c instanceof OxmlElement && (qualifiedName == null || c.qualifiedName === qualifiedName))
                yield c;
    }

    /** The first direct child element with this qualified name, or undefined. */
    element(qualifiedName: string): OxmlElement | undefined {
        for (const e of this.elements(qualifiedName))
            return e;
        return undefined;
    }

    /**
     * Every descendant element, document order, EXCLUDING self (the SDK's `Descendants()`).
     *
     * Callers that mutate while walking must materialise first (`[...root.descendants()]`) — Signum does
     * exactly this ("//eager") in the renderer for the same reason.
     */
    *descendants(): Generator<OxmlElement> {
        for (const c of this.childElements) {
            if (c instanceof OxmlElement) {
                yield c;
                yield* c.descendants();
            }
        }
    }

    /** Descendants of a given class, materialised (the SDK's `Descendants<T>().ToList()`). */
    descendantsOfType<T extends OxmlElement>(ctor: abstract new (...args: never[]) => T): T[] {
        const out: T[] = [];
        for (const d of this.descendants())
            if (d instanceof ctor)
                out.push(d as T);
        return out;
    }

    /** Self + descendants, document order — the natural root for a `descendants()`-style scan. */
    *selfAndDescendants(): Generator<OxmlElement> {
        yield this;
        yield* this.descendants();
    }

    /** Every descendant element with this qualified name, materialised. */
    descendantsNamed(qualifiedName: string): OxmlElement[] {
        const out: OxmlElement[] = [];
        for (const d of this.descendants())
            if (d.qualifiedName === qualifiedName)
                out.push(d);
        return out;
    }

    // ---- copy / serialize ---------------------------------------------------------------------

    /**
     * Copy this element (the SDK's `CloneNode`). Subclasses MUST override so that cloning a template node
     * yields the same node class — `ForeachNode` clones its block once per row and relies on this.
     */
    override cloneNode(deep: boolean): OxmlElement {
        const copy = new OxmlElement(this.qualifiedName);
        this.copyInto(copy, deep);
        return copy;
    }

    /** Shared clone tail: attributes always, children only when `deep`. For subclass `cloneNode`s. */
    protected copyInto(copy: OxmlElement, deep: boolean): void {
        for (const [k, v] of this.attributes)
            copy.attributes.set(k, v);
        if (deep)
            for (const c of this.childElements)
                copy.appendChild(c.cloneNode(true));
    }

    override get innerText(): string {
        let s = "";
        for (const c of this.childElements)
            s += c.innerText;
        return s;
    }

    override writeTo(writer: XmlTextWriter): void {
        writer.writeStartElement(this.qualifiedName, this.attributes);
        if (this.childElements.length === 0) {
            writer.writeEndElementEmpty();
            return;
        }
        writer.writeStartElementEnd();
        for (const c of this.childElements)
            c.writeTo(writer);
        writer.writeEndElement(this.qualifiedName);
    }

    toString(): string { return `<${this.qualifiedName}>`; }
}

/**
 * The XML serializer the tree writes into (the SDK hands `WriteTo` an `XmlWriter`; same idea).
 *
 * Escaping follows the XML spec's minimum: `&`, `<`, `>` in text; additionally `"` in attribute values.
 * `\r` is escaped as a character reference because an unescaped CR is normalised away by every XML parser,
 * which would silently corrupt a `w:t` that legitimately contains one.
 */
export class XmlTextWriter {
    private readonly parts: string[] = [];

    writeRaw(s: string): void { this.parts.push(s); }

    writeStartElement(qualifiedName: string, attributes: ReadonlyMap<string, string>): void {
        this.parts.push("<", qualifiedName);
        for (const [k, v] of attributes)
            this.parts.push(" ", k, "=\"", escapeAttribute(v), "\"");
    }

    /** Close the start tag of an element that HAS children. */
    writeStartElementEnd(): void { this.parts.push(">"); }

    /** Close an element with no children as `<w:b/>`. */
    writeEndElementEmpty(): void { this.parts.push("/>"); }

    writeEndElement(qualifiedName: string): void { this.parts.push("</", qualifiedName, ">"); }

    writeText(text: string): void { this.parts.push(escapeText(text)); }

    writeComment(text: string): void { this.parts.push("<!--", text, "-->"); }

    writeCData(text: string): void { this.parts.push("<![CDATA[", text, "]]>"); }

    toStringValue(): string { return this.parts.join(""); }
}

function escapeText(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\r/g, "&#xD;");
}

function escapeAttribute(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/\r/g, "&#xD;")
        .replace(/\n/g, "&#xA;")
        .replace(/\t/g, "&#x9;");
}
