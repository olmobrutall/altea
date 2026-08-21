// Port of Signum.HtmlEditor's HtmlToPlainText.cs — flatten stored HTML to readable plain text. Its consumer
// is the excel generator (Signum's PlainExcelGenerator; altea's `@altea/altea-office-template`'s
// PlainExcelLogic): a spreadsheet cell wants text, not markup.
//
// THE divergence: Signum walks an `HtmlAgilityPack.HtmlDocument`. There is no HtmlAgilityPack for Node, and
// the SERVER has no DOM (`DOMParser` is browser-only — the client half uses it, this half cannot), so the
// walk runs over a small hand-written tokenizer. That is the same call the EWS/POP3 ports made: a hundred
// lines of tokenizer beats a browser-emulation dependency for one function.
//
// The tokenizer is deliberately narrow, and safe for the job: it recognises tags, comments, CDATA and text,
// and it never builds a tree — the block/list handling only needs to know which tag opened and which closed.
// Behaviour matches Signum's `ProcessNode` case for case: text is de-entitized, `<br>` breaks the line, a
// block tag (p / div / h1-h6) ends with a newline, `<ul>`'s items are prefixed "- " and `<ol>`'s "1. ", "2. ",
// and any other tag is transparent.

type Token =
    | { kind: "text"; value: string }
    | { kind: "open"; name: string }
    | { kind: "close"; name: string }
    | { kind: "selfClose"; name: string };

const blockTags = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);

export function htmlToText(html: string | null | undefined): string | null {
    if (html == undefined)
        return null;

    const tokens = tokenize(html);
    const out: string[] = [];

    // One counter per open <ol>, so nested ordered lists each number from 1 (Signum restarts `i` per list).
    const listStack: { ordered: boolean; index: number }[] = [];

    for (const token of tokens) {
        switch (token.kind) {
            case "text":
                out.push(deEntitize(token.value));
                break;

            case "selfClose":
            case "open":
                if (token.name === "br") {
                    out.push("\n");
                } else if (token.name === "ul" || token.name === "ol") {
                    listStack.push({ ordered: token.name === "ol", index: 1 });
                } else if (token.name === "li") {
                    const list = listStack[listStack.length - 1];
                    if (list == undefined)
                        break; // an <li> outside any list: Signum's default branch — transparent
                    out.push(list.ordered ? `${list.index++}. ` : "- ");
                }
                break;

            case "close":
                if (token.name === "ul" || token.name === "ol")
                    listStack.pop();
                else if (token.name === "li")
                    out.push("\n");
                else if (blockTags.has(token.name))
                    out.push("\n");
                break;
        }
    }

    return out.join("").trim();
}

function tokenize(html: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;

    while (i < html.length) {
        const lt = html.indexOf("<", i);

        if (lt < 0) {
            pushText(tokens, html.slice(i));
            break;
        }

        if (lt > i)
            pushText(tokens, html.slice(i, lt));

        // A comment, a CDATA block or a doctype contributes nothing; skip to its end.
        if (html.startsWith("<!--", lt)) {
            const end = html.indexOf("-->", lt + 4);
            i = end < 0 ? html.length : end + 3;
            continue;
        }
        if (html.startsWith("<![CDATA[", lt)) {
            const end = html.indexOf("]]>", lt + 9);
            // CDATA content IS text.
            pushText(tokens, html.slice(lt + 9, end < 0 ? html.length : end));
            i = end < 0 ? html.length : end + 3;
            continue;
        }
        if (html.startsWith("<!", lt)) {
            const end = html.indexOf(">", lt + 2);
            i = end < 0 ? html.length : end + 1;
            continue;
        }

        const gt = findTagEnd(html, lt);
        if (gt < 0) {
            // An unterminated "<" is literal text, not a tag.
            pushText(tokens, html.slice(lt));
            break;
        }

        const raw = html.slice(lt + 1, gt).trim();
        i = gt + 1;

        if (raw === "")
            continue;

        // `<script>` / `<style>` bodies are code, never prose — drop them wholesale.
        const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
        if (nameMatch == null)
            continue;

        const name = nameMatch[1]!.toLowerCase();

        if (raw.startsWith("/")) {
            tokens.push({ kind: "close", name });
            continue;
        }

        if (name === "script" || name === "style") {
            const closeIndex = html.toLowerCase().indexOf(`</${name}`, i);
            i = closeIndex < 0 ? html.length : html.indexOf(">", closeIndex) + 1;
            continue;
        }

        tokens.push({ kind: raw.endsWith("/") ? "selfClose" : "open", name });
    }

    return tokens;
}

/** The `>` that closes a tag, skipping any inside a quoted attribute value (`<a title="a > b">`). */
function findTagEnd(html: string, start: number): number {
    let quote: string | undefined;

    for (let i = start + 1; i < html.length; i++) {
        const c = html[i]!;

        if (quote != undefined) {
            if (c === quote)
                quote = undefined;
            continue;
        }

        if (c === "\"" || c === "'")
            quote = c;
        else if (c === ">")
            return i;
    }

    return -1;
}

function pushText(tokens: Token[], value: string): void {
    if (value !== "")
        tokens.push({ kind: "text", value });
}

const namedEntities: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
    copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", eacute: "é", euro: "€",
};

/** `HtmlEntity.DeEntitize` — the named entities that actually occur in stored html, plus every numeric one. */
function deEntitize(text: string): string {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
        if (body.startsWith("#x") || body.startsWith("#X")) {
            const code = Number.parseInt(body.slice(2), 16);
            return Number.isNaN(code) ? whole : String.fromCodePoint(code);
        }
        if (body.startsWith("#")) {
            const code = Number.parseInt(body.slice(1), 10);
            return Number.isNaN(code) ? whole : String.fromCodePoint(code);
        }
        return namedEntities[body.toLowerCase()] ?? whole;
    });
}
