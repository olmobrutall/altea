import {
    $applyNodeReplacement, DecoratorNode, type DOMConversionMap, type DOMExportOutput,
    type EditorConfig, type LexicalEditor, type NodeKey,
} from "lexical";
import type { ReactElement } from "react";
import type { ImageHandlerBase, ImageInfo } from "./ImageHandlerBase";

// Port of Signum.HtmlEditor's Extensions/ImageExtension/ImageNode.tsx — verbatim.
//
// A pseudo-abstract base: a concrete host subclasses it to override getType / clone / importJSON when it
// needs its own node type. Every rendering decision is delegated to the editor's `imageHandler`.
export class ImageNode extends DecoratorNode<ReactElement> {

    static override getType(): string {
        return "image";
    }

    constructor(public imageInfo: ImageInfo, key?: NodeKey) {
        super(key);
    }

    override createDOM(): HTMLElement {
        return document.createElement("div");
    }

    override updateDOM(): boolean {
        return false;
    }

    override decorate(editor: LexicalEditor, _config: EditorConfig): ReactElement {
        return editor.imageHandler!.renderImage(this.imageInfo);
    }

    override exportJSON(): any {
        return {
            type: "image",
            uploadedFile: this.imageInfo,
            version: 1,
        };
    }

    override exportDOM(editor: LexicalEditor): DOMExportOutput {
        const element = editor.imageHandler!.toElement(this.imageInfo) ?? null;
        return { element };
    }

    /** Signum's own note: `importDOM` is static and sync, so there is no editor to read the handler from. */
    static currentHandler: ImageHandlerBase | undefined;

    static override importDOM(): DOMConversionMap | null {
        return {
            img: () => ({
                priority: 1,
                conversion: (element: HTMLElement) => {
                    try {
                        if (this.currentHandler == undefined)
                            throw new Error("currentHandler not set");

                        const info = this.currentHandler.fromElement(element);
                        if (!info)
                            return null;
                        return { node: new this(info) };
                    } catch {
                        return null;
                    }
                },
            }),
        };
    }

    static override clone(node: ImageNode): ImageNode {
        return new ImageNode(node.imageInfo, node.__key);
    }

    static override importJSON(serializedNode: any): ImageNode {
        // Handles both a bare ImageInfo and the wrapped shape exportJSON writes.
        const imageInfo = serializedNode.uploadedFile ?? serializedNode;
        return new ImageNode(imageInfo);
    }
}

export function $createImageNode(file: ImageInfo, nodeType: typeof ImageNode): ImageNode {
    return $applyNodeReplacement(new nodeType(file));
}
