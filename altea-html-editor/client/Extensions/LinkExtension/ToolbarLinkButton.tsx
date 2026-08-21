import * as React from "react";
import { $isLinkNode, type LinkNode } from "@lexical/link";
import { $getSelection, $isRangeSelection, type RangeSelection } from "lexical";
import { HtmlEditorMessage } from "../../../data/HtmlEditor";
import { HtmlEditorButton } from "../../HtmlEditorButtons";
import type { HtmlEditorController } from "../../HtmlEditorController";
import { formatLink } from "../../Utils/format";
import { $findMatchingParent } from "../../Utils/node";
import EditLinkModal from "./EditLinkModal";
import { restoreSelection, sanitizeUrl, validateUrl } from "./helper";

// Port of Signum.HtmlEditor's Extensions/LinkExtension/ToolbarLinkButton.tsx.
//
// altea divergence: the url prompt is `EditLinkModal` rather than `AutoLineModal` with a custom component
// (see that file). The three-way result is what the flow needs: undefined = cancelled (do nothing),
// "" = unlink, anything else = set that url.
export default function ToolbarLinkButton({ controller }: { controller: HtmlEditorController }): React.ReactNode {
    const { editor, editorState } = controller;

    const isActive = React.useMemo(() => {
        let active = false;
        editorState?.read(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection))
                return;
            active = !!$findMatchingParent(selection.anchor.getNode(), node => $isLinkNode(node));
        });
        return active;
    }, [editorState]);

    const toggleLink = React.useCallback(async () => {
        let selection: RangeSelection | undefined;
        let initialUrl = "";

        editor.read(() => {
            const currentSelection = $getSelection();
            if (!$isRangeSelection(currentSelection))
                return;
            selection = currentSelection;
            const linkNode = $findMatchingParent(currentSelection.anchor.getNode(),
                node => $isLinkNode(node)) as LinkNode | undefined;
            if (linkNode)
                initialUrl = linkNode.getURL();
        });

        if (!selection)
            return;

        const url = await EditLinkModal.show(initialUrl);

        if (url === undefined)
            return; // cancelled

        if (url === "") {
            formatLink(editor); // unlink
            return;
        }

        const sanitizedUrl = sanitizeUrl(url);

        if (!validateUrl(sanitizedUrl))
            throw new Error("The entered URL is not valid.");

        editor.update(() => {
            if (!selection)
                return;
            // Opening a modal blurred the editor, so the selection the command needs is gone — put it back.
            restoreSelection(editor, selection);
            const linkNode = $findMatchingParent(selection.anchor.getNode(),
                node => $isLinkNode(node)) as LinkNode | undefined;
            if (linkNode)
                linkNode.setURL(sanitizedUrl);
            else
                formatLink(editor, sanitizedUrl);
        });
    }, [editor]);

    return (
        <HtmlEditorButton isActive={isActive} onClick={() => void toggleLink()} icon="link"
            title={HtmlEditorMessage.InsertHyperlink.niceToString()} />
    );
}
