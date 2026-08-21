import { $getRoot, type EditorState } from "lexical";

// Port of Signum.HtmlEditor's Utils/editorState.ts — verbatim.
export function isEmpty(editorState: EditorState | undefined): boolean {
    return editorState?.read(() => $getRoot().getTextContentSize() === 0) ?? false;
}
