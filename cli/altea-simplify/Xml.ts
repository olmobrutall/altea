/**
 * A minimal XML reader, with NO dependencies.
 *
 * It replaces `fast-xml-parser` for one file: `Modules.xml`. That file is small, hand-written to a
 * documented grammar, and read by a tool that must run from a bare checkout — so a general parser was
 * paying for generality nobody uses. What is supported is exactly what the grammar needs:
 *
 *   elements, nested; attributes in single or double quotes; self-closing tags; comments; the XML
 *   declaration; the five predefined entities and numeric character references.
 *
 * What is NOT supported, and THROWS rather than guessing: CDATA, processing instructions other than the
 * declaration, namespaces (a prefix is part of the name), DTDs, and mixed content — an element has either
 * child elements or text, never both. A Modules.xml that needs any of those is not a Modules.xml.
 *
 * Failure carries the LINE, because a hand-edited file is the normal input.
 */

export interface XmlElement {
    name: string;
    attributes: Record<string, string>;
    children: XmlElement[];
    /** The line the element's open tag starts on, 1-based — for error messages. */
    line: number;
}

export namespace Xml {

    export function parse(text: string, fileName = "<xml>"): XmlElement {
        return new Parser(text, fileName).parseDocument();
    }
}

class Parser {
    private index = 0;

    constructor(private readonly text: string, private readonly fileName: string) { }

    parseDocument(): XmlElement {
        this.skipProlog();

        const root = this.parseElement();

        this.skipTrivia();
        if (this.index < this.text.length)
            this.fail("content after the root element");

        return root;
    }

    /** The XML declaration, comments and whitespace that may precede the root. */
    private skipProlog(): void {
        for (; ;) {
            this.skipTrivia();
            if (this.startsWith("<?")) {
                const end = this.text.indexOf("?>", this.index);
                if (end < 0) this.fail("unterminated <? … ?>");
                this.index = end + 2;
                continue;
            }
            if (this.startsWith("<!DOCTYPE"))
                this.fail("DTDs are not supported");
            return;
        }
    }

    private parseElement(): XmlElement {
        const line = this.lineOf(this.index);

        if (!this.startsWith("<"))
            this.fail("expected an element");
        this.index++;

        const name = this.readName();
        const attributes: Record<string, string> = {};

        for (; ;) {
            this.skipWhitespace();

            if (this.startsWith("/>")) { this.index += 2; return { name, attributes, children: [], line }; }
            if (this.startsWith(">")) { this.index++; break; }

            const attribute = this.readName();
            this.skipWhitespace();
            if (!this.startsWith("=")) this.fail(`attribute '${attribute}' has no value`);
            this.index++;
            this.skipWhitespace();

            const quote = this.text[this.index];
            if (quote !== `"` && quote !== `'`) this.fail(`attribute '${attribute}' is not quoted`);
            this.index++;

            const end = this.text.indexOf(quote, this.index);
            if (end < 0) this.fail(`attribute '${attribute}' is not closed`);

            attributes[attribute] = decode(this.text.slice(this.index, end));
            this.index = end + 1;
        }

        const children: XmlElement[] = [];
        for (; ;) {
            this.skipTrivia();

            if (this.startsWith(`</`)) {
                this.index += 2;
                const closing = this.readName();
                if (closing !== name)
                    this.fail(`</${closing}> closes <${name}>`);
                this.skipWhitespace();
                if (!this.startsWith(">")) this.fail(`</${closing} is not closed`);
                this.index++;
                return { name, attributes, children, line };
            }

            if (this.index >= this.text.length)
                this.fail(`<${name}> (line ${line}) is never closed`);

            if (!this.startsWith("<"))
                this.fail(`text content inside <${name}>; only child elements are supported`);

            children.push(this.parseElement());
        }
    }

    // ---- lexing ------------------------------------------------------------------------------------

    private startsWith(token: string): boolean {
        return this.text.startsWith(token, this.index);
    }

    private skipWhitespace(): void {
        while (this.index < this.text.length && /\s/.test(this.text[this.index]))
            this.index++;
    }

    /** Whitespace and comments — everything that may appear between markup. */
    private skipTrivia(): void {
        for (; ;) {
            this.skipWhitespace();
            if (!this.startsWith("<!--"))
                return;
            const end = this.text.indexOf("-->", this.index);
            if (end < 0) this.fail("unterminated comment");
            this.index = end + 3;
        }
    }

    private readName(): string {
        const start = this.index;
        while (this.index < this.text.length && /[A-Za-z0-9_.:-]/.test(this.text[this.index]))
            this.index++;
        if (this.index === start)
            this.fail("expected a name");
        return this.text.slice(start, this.index);
    }

    private lineOf(index: number): number {
        let line = 1;
        for (let i = 0; i < index; i++)
            if (this.text[i] === "\n")
                line++;
        return line;
    }

    private fail(message: string): never {
        throw new Error(`${this.fileName}:${this.lineOf(this.index)}: ${message}`);
    }
}

/** The five predefined entities plus numeric character references. Nothing else is legal XML. */
function decode(text: string): string {
    if (!text.includes("&"))
        return text;

    return text.replace(/&(#x?[0-9A-Fa-f]+|[a-z]+);/g, (whole, body: string) => {
        switch (body) {
            case "amp": return "&";
            case "lt": return "<";
            case "gt": return ">";
            case "quot": return `"`;
            case "apos": return `'`;
        }
        if (body.startsWith("#x") || body.startsWith("#X"))
            return String.fromCodePoint(parseInt(body.slice(2), 16));
        if (body.startsWith("#"))
            return String.fromCodePoint(parseInt(body.slice(1), 10));

        throw new Error(`Unknown XML entity '${whole}'`);
    });
}
