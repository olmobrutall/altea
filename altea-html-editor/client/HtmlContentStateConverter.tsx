import { $generateHtmlFromNodes, $generateNodesFromDOM } from "@lexical/html";
import { $getRoot, $getSelection, $setSelection, type EditorState, type LexicalEditor, type LexicalNode } from "lexical";
import { ImageNode } from "./Extensions/ImageExtension/ImageNode";

// Port of Signum.HtmlEditor's HtmlContentStateConverter.tsx — the two directions between the stored HTML
// string and Lexical's editor state. Verbatim, including `fixListHTML`: Lexical exports a nested list as a
// SIBLING `<li>` containing only the sub-list, which most mail clients render as an extra empty bullet, so
// the nested list is re-parented onto the preceding `<li>`.
export interface ITextConverter {
    $convertToText(editor: LexicalEditor): string;
    $convertFromText(editor: LexicalEditor, html: string): EditorState;
}

export class HtmlContentStateConverter implements ITextConverter {

    $convertToText(editor: LexicalEditor): string {
        return editor.read(() => fixListHTML($generateHtmlFromNodes(editor)));
    }

    $convertFromText(editor: LexicalEditor, html: string): EditorState {

        editor.update(() => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, "text/html");
            let nodes: LexicalNode[];
            try {
                // `importDOM` is SYNCHRONOUS and static — there is no editor to read the handler off — so the
                // handler is parked on the class for the duration of the parse (Signum's own note).
                ImageNode.currentHandler = editor.imageHandler;
                nodes = $generateNodesFromDOM(editor, doc);
            } finally {
                ImageNode.currentHandler = undefined;
            }
            $getRoot().clear().select();
            $getSelection()?.insertNodes(nodes);
            $setSelection(null);
        }, { discrete: true });

        return editor.getEditorState();
    }
}

function fixListHTML(html: string): string {
    // Remove `value="..."` from OL elements — Lexical emits an explicit item number that fights the browser.
    html = html.replace(/\svalue="\d+"/g, "");

    const container = document.createElement("div");
    container.innerHTML = html;

    fixBrokenNestedLists(container);

    return container.innerHTML;
}

function fixBrokenNestedLists(element: HTMLElement): void {
    const listTags = ["ol", "ul"];

    for (const tag of listTags) {
        const listElements = Array.from(element.querySelectorAll(tag));

        for (const list of listElements) {
            const children = Array.from(list.children);

            for (let i = 0; i < children.length; i++) {
                const child = children[i]!;

                if (child.tagName === "LI"
                    && child.children.length === 1
                    && (child.firstElementChild?.tagName === "OL" || child.firstElementChild?.tagName === "UL")) {

                    const prevLi = child.previousElementSibling;

                    if (prevLi?.tagName === "LI") {
                        const nestedList = child.firstElementChild as HTMLOListElement | HTMLUListElement;
                        prevLi.appendChild(nestedList);
                        child.remove();
                        i--;
                    }
                }
            }
        }
    }
}
