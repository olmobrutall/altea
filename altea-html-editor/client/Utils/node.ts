import { $isListNode, type ListNode } from "@lexical/list";
import { $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import type { LexicalNode, RangeSelection } from "lexical";

// Port of Signum.HtmlEditor's Utils/node.ts — verbatim. `@lexical/utils` ships its own
// `$findMatchingParent`, but Signum's walks from the node ITSELF (matching the node before its parents),
// which the callers rely on; keeping Signum's version keeps that semantic.

/** Can only be used within a register/read/update callback of the editor. */
export function $findMatchingParent(node: LexicalNode, selector: (node: LexicalNode) => boolean): LexicalNode | undefined {
    if (selector(node))
        return node;

    const parentNode = node.getParent();
    if (!parentNode)
        return undefined;

    return $findMatchingParent(parentNode, selector);
}

export function isListActive(selection: RangeSelection, listTag?: string): boolean {
    const verifyListTag = (node: ListNode): boolean => listTag == undefined ? true : node.getTag() === listTag;
    return !!$findMatchingParent(selection.anchor.getNode(), node => $isListNode(node) && verifyListTag(node as ListNode));
}

export function isQuoteActive(selection: RangeSelection, blockType: string): boolean {
    return !!$findMatchingParent(selection.anchor.getNode(), node => $isQuoteNode(node) && blockType === "blockquote");
}

export function isHeadingActive(selection: RangeSelection, headingTag: string): boolean {
    return !!$findMatchingParent(selection.anchor.getNode(),
        node => $isHeadingNode(node) && node.getTag() === headingTag);
}
