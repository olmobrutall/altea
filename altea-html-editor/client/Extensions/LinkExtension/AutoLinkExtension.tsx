import * as React from "react";
import { $isLinkNode, AutoLinkNode, type LinkNode } from "@lexical/link";
import { AutoLinkPlugin, type LinkMatcher } from "@lexical/react/LexicalAutoLinkPlugin";
import { $getSelection, $isRangeSelection, CLICK_COMMAND, COMMAND_PRIORITY_EDITOR } from "lexical";
import type { HtmlEditorController } from "../../HtmlEditorController";
import { $findMatchingParent } from "../../Utils/node";
import { HtmlEditorExtension, type LexicalConfigNode, type OptionalCallback } from "../types";
import { urlRegExp } from "./helper";

// Port of Signum.HtmlEditor's Extensions/LinkExtension/AutoLinkExtension.tsx — verbatim: typed urls become
// links as you go. NOT one of the defaults; a host adds it when it wants that behaviour.
const MATCHERS: LinkMatcher[] = [
    (text: string) => {
        const match = urlRegExp.exec(text);
        if (match === null)
            return null;

        const [fullMatch] = match;

        return {
            index: match.index,
            length: fullMatch.length,
            text: fullMatch,
            url: fullMatch.startsWith("http") ? fullMatch : `https://${fullMatch}`,
        };
    },
];

export class AutoLinkExtension extends HtmlEditorExtension {
    override name = "AutoLinkExtension";

    override getBuiltPlugin(): React.ReactElement {
        return <AutoLinkPlugin matchers={MATCHERS} />;
    }

    override getNodes(): LexicalConfigNode {
        return [AutoLinkNode];
    }

    override registerExtension(controller: HtmlEditorController): OptionalCallback {
        return controller.editor.registerCommand(
            CLICK_COMMAND,
            event => {
                if (!event.ctrlKey)
                    return false;
                const selection = $getSelection();
                if (!$isRangeSelection(selection))
                    return false;
                const linkNode = $findMatchingParent(selection.anchor.getNode(), node => $isLinkNode(node));

                if (linkNode) {
                    window.open((linkNode as LinkNode).getURL(), "_blank");
                    return true;
                }
                return false;
            },
            COMMAND_PRIORITY_EDITOR);
    }
}
