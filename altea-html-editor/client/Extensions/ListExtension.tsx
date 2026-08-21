import {
    $isListItemNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode,
} from "@lexical/list";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import {
    $getSelection, $isRangeSelection, COMMAND_PRIORITY_LOW, INDENT_CONTENT_COMMAND, KEY_SPACE_COMMAND,
    KEY_TAB_COMMAND, OUTDENT_CONTENT_COMMAND,
} from "lexical";
import type { HtmlEditorController } from "../HtmlEditorController";
import { $findMatchingParent, isListActive } from "../Utils/node";
import { HtmlEditorExtension, type LexicalConfigNode, type OptionalCallback } from "./types";

// Port of Signum.HtmlEditor's Extensions/ListExtension.tsx — verbatim: the ListPlugin, markdown-ish
// shortcuts (`* `, `- `, `1. ` start a list) and Tab / Shift+Tab to indent within one.
const MAX_INDENT_LEVEL = 6;

export class ListExtension extends HtmlEditorExtension {
    override name = "ListExtension";

    override getBuiltPlugin(): React.ReactElement {
        return <ListPlugin />;
    }

    override getNodes(): LexicalConfigNode {
        return [ListNode, ListItemNode];
    }

    override registerExtension(controller: HtmlEditorController): OptionalCallback {
        const unsubscribeSpaceCommand = controller.editor.registerCommand(
            KEY_SPACE_COMMAND,
            () => {
                const selection = $getSelection();

                if (!$isRangeSelection(selection) || !selection.isCollapsed())
                    return false;

                const anchorNode = selection.anchor.getNode();
                const text = anchorNode.getTextContent();

                const command =
                    text === "*" || text === "-" ? INSERT_UNORDERED_LIST_COMMAND :
                        text === "1." ? INSERT_ORDERED_LIST_COMMAND :
                            null;

                if (!command)
                    return false;

                controller.editor.update(() => {
                    anchorNode.remove();
                    controller.editor.dispatchCommand(command, undefined);
                });
                return true;
            },
            COMMAND_PRIORITY_LOW);

        const unsubscribeTabCommand = controller.editor.registerCommand(
            KEY_TAB_COMMAND,
            event => {
                const selection = $getSelection();
                if (!$isRangeSelection(selection))
                    return false;

                if (!isListActive(selection))
                    return false;

                event.preventDefault();

                const listItemNode = $findMatchingParent(selection.anchor.getNode(),
                    node => $isListItemNode(node)) as ListItemNode | undefined;

                if (!listItemNode)
                    return false;

                const depth = listItemNode.getIndent() || 0;

                if (!event.shiftKey) {
                    if (depth >= MAX_INDENT_LEVEL)
                        return false;
                    controller.editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
                } else {
                    controller.editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
                }

                return true;
            },
            COMMAND_PRIORITY_LOW);

        return () => {
            unsubscribeTabCommand();
            unsubscribeSpaceCommand();
        };
    }
}
