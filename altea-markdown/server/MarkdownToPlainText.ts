import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Parents, PhrasingContent, RootContent } from "mdast";

// Port of Signum.Markdown's MarkdownToPlainText.cs — flatten stored markdown to readable plain text. Its
// consumer is the excel generator (Signum's PlainExcelGenerator; altea's @altea/altea-office-template's
// PlainExcelLogic): a spreadsheet cell wants text, not markup.
//
// THE divergence is the substrate: **Markdig → mdast**. `Markdig.Markdown.Parse(markdown, pipeline)` becomes
// `fromMarkdown(markdown)`, the parser react-markdown itself is built on — which makes this the one flattener
// in the workspace that does NOT need a hand-written tokenizer (@altea/altea-html-editor's HtmlToPlainText
// does, because there is no HtmlAgilityPack for Node). The two trees line up node for node, and both parsers
// default to plain CommonMark with no extensions: `new MarkdownPipelineBuilder().Build()` enables none, and
// `fromMarkdown` with no `extensions` enables none. So a GFM table is not parsed on either side and comes
// through as the literal pipe text — same output, same reason.
//
// The correspondence, and it is exact:
//
//   Markdig                     mdast                    handled as
//   MarkdownDocument            root                     recurse
//   ParagraphBlock              paragraph                inlines, then a newline unless inside a list item
//   HeadingBlock                heading                  inlines, then a newline
//   ListBlock / ListItemBlock    list / listItem         "- " or "1. " per item, then a newline
//   ContainerBlock (quote, …)   blockquote, …            recurse, transparently
//   LiteralInline               text                     appended verbatim
//   LineBreakInline             break, and the "\n"      a newline
//                               already inside a text
//   CodeInline                  inlineCode               its content, without the backticks
//   ContainerInline (strong,    strong, emphasis,        recurse, so the emphasis markers vanish
//     emphasis, link, …)          link, delete, …
//
// Two notes on what that leaves out, both mirroring Signum rather than improving on it:
//  - a CODE BLOCK contributes NOTHING. Markdig's `CodeBlock` is a LeafBlock, so Signum's switch — which has
//    cases for the container kinds and for Paragraph / Heading / List only — never reaches it, and the same
//    holds for `ThematicBreakBlock` and `HtmlBlock` (mdast: `code`, `thematicBreak`, `html`). Kept as-is so
//    the two implementations stay comparable; a future Signum fix re-applies here unchanged.
//  - an IMAGE is the one place mdast is poorer than Markdig, so it needs a line of code rather than a
//    recursion: Markdig models an image as a `LinkInline` whose CHILDREN are the alt text, which Signum's
//    ContainerInline case walks into; mdast makes `alt` an attribute of a childless `image` node. Appending
//    that attribute is what reproduces Signum's output.
export function markdownToText(markdown: string | null | undefined): string | null {
    if (markdown == undefined)
        return null;

    const parts: string[] = [];
    processBlock(fromMarkdown(markdown), parts, false);
    return parts.join("").trim();
}

function processBlock(block: Nodes, parts: string[], insideListItem: boolean): void {
    switch (block.type) {
        case "paragraph":
            processInlines(block.children, parts);
            if (!insideListItem)
                parts.push("\n");
            break;

        case "heading":
            processInlines(block.children, parts);
            parts.push("\n");
            break;

        case "list":
            // Signum's `index` counts from 1 and ignores the list's own `start`, so an "3. " list renumbers
            // from 1; mirrored. mdast marks an ordered list with `ordered: true` where Markdig uses `IsOrdered`.
            let index = 1;
            for (const item of block.children) {
                parts.push(block.ordered ? `${index++}. ` : "- ");
                for (const child of item.children)
                    processBlock(child, parts, true);
                parts.push("\n");
            }
            break;

        default:
            // Every remaining CONTAINER kind is transparent (Markdig's `case ContainerBlock container`):
            // blockquote, and a listItem reached other than through its list. A leaf without a case above —
            // code, thematicBreak, html, definition — contributes nothing, as in Signum.
            if ("children" in block)
                for (const child of (block as Parents).children as RootContent[])
                    processBlock(child, parts, insideListItem);
            break;
    }
}

function processInlines(inlines: PhrasingContent[] | undefined, parts: string[]): void {
    if (inlines == undefined)
        return;

    for (const inline of inlines)
        processInline(inline, parts);
}

function processInline(inline: PhrasingContent, parts: string[]): void {
    switch (inline.type) {
        case "text":
            // Signum's LiteralInline. A SOFT line break inside a paragraph is part of this value in mdast
            // (Markdig gives it its own LineBreakInline), which lands the same newline in the same place.
            parts.push(inline.value);
            break;

        case "break":
            parts.push("\n");
            break;

        case "inlineCode":
            parts.push(inline.value);
            break;

        case "image":
            // See the header: mdast's alt is an attribute, Markdig's is the node's children.
            parts.push(inline.alt ?? "");
            break;

        default:
            if ("children" in inline)
                for (const child of inline.children as PhrasingContent[])
                    processInline(child, parts);
            break;
    }
}
