import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Parents, PhrasingContent, RootContent } from "mdast";

// Flatten stored markdown to readable plain text. Its consumer is the excel generator
// (@altea/altea-office-template's PlainExcelLogic): a spreadsheet cell wants text, not markup.
//
// DELIBERATELY INCOMPLETE, and both gaps are mirrored from Signum rather than fixed, so the two
// implementations stay comparable and a future Signum fix re-applies here unchanged:
//  - a CODE BLOCK contributes NOTHING, and so do `thematicBreak` and `html`;
//  - an ordered list renumbers from 1, ignoring the list's own `start`.
//
// Plain CommonMark, no extensions — so a GFM table is not parsed and comes through as literal pipe text.
//
// Port of Signum.Markdown's MarkdownToPlainText.cs (Markdig → mdast, with a node-by-node correspondence
// table) — see docs/port/Markdown.md.
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
            // The counter starts at 1 whatever the source says (see the header).
            let index = 1;
            for (const item of block.children) {
                parts.push(block.ordered ? `${index++}. ` : "- ");
                for (const child of item.children)
                    processBlock(child, parts, true);
                parts.push("\n");
            }
            break;

        default:
            // Every remaining CONTAINER kind is transparent: blockquote, and a listItem reached other than
            // through its list. A leaf without a case above — code, thematicBreak, html, definition —
            // contributes nothing (see the header).
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
            // A SOFT line break inside a paragraph is part of this value in mdast, which lands the same
            // newline in the same place a separate break node would.
            parts.push(inline.value);
            break;

        case "break":
            parts.push("\n");
            break;

        case "inlineCode":
            parts.push(inline.value);
            break;

        case "image":
            // mdast makes `alt` an attribute of a childless node, so there is nothing to recurse into.
            parts.push(inline.alt ?? "");
            break;

        default:
            if ("children" in inline)
                for (const child of inline.children as PhrasingContent[])
                    processInline(child, parts);
            break;
    }
}
