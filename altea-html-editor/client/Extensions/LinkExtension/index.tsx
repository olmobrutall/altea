import * as React from "react";
import { $isLinkNode, LinkNode, type AutoLinkNode } from "@lexical/link";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { $getSelection, $isRangeSelection, CLICK_COMMAND, COMMAND_PRIORITY_EDITOR } from "lexical";
import type { HtmlEditorController } from "../../HtmlEditorController";
import { $findMatchingParent } from "../../Utils/node";
import { HtmlEditorExtension, type LexicalConfigNode, type OptionalCallback } from "../types";
import { AutoLinkExtension } from "./AutoLinkExtension";
import ToolbarLinkButton from "./ToolbarLinkButton";
import { validateUrl } from "./helper";

// Port of Signum.HtmlEditor's Extensions/LinkExtension/index.tsx — verbatim. Ctrl+click opens the link,
// which is how you follow a link inside an editable surface.
export class LinkExtension extends HtmlEditorExtension {
    override name = "LinkExtension";

    override getToolbarButtons(controller: HtmlEditorController): React.ReactNode {
        return <ToolbarLinkButton controller={controller} />;
    }

    override getBuiltPlugin(): React.ReactElement {
        return <LinkPlugin attributes={{ target: "_blank" }} validateUrl={validateUrl} />;
    }

    override getNodes(): LexicalConfigNode {
        return [LinkNode];
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

export { AutoLinkExtension };
export type { AutoLinkNode };
