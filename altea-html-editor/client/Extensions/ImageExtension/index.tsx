import { $getRoot } from "lexical";
import type { HtmlEditorController } from "../../HtmlEditorController";
import { HtmlEditorExtension, type LexicalConfigNode, type OptionalCallback } from "../types";
import type { ImageHandlerBase, ImageInfo } from "./ImageHandlerBase";
import { $createImageNode, ImageNode } from "./ImageNode";

// Port of Signum.HtmlEditor's Extensions/ImageExtension/index.tsx — verbatim: drag-and-drop and paste of
// image files, uploaded through the app's ImageHandlerBase and appended as ImageNodes.
export class ImageExtension extends HtmlEditorExtension {

    override name = "ImageExtension";

    constructor(public imageHandler: ImageHandlerBase) {
        super();
    }

    override registerExtension(controller: HtmlEditorController): OptionalCallback {
        const abortController = new AbortController();
        const element = controller.editableElement;

        if (!element)
            return undefined;

        if (controller.editor && controller.editor.imageHandler !== this.imageHandler)
            controller.editor.imageHandler = this.imageHandler;

        element.addEventListener("dragenter", event => {
            event.dataTransfer!.dropEffect = controller.editor.isEditable() ? "copy" : "none";
        }, { signal: abortController.signal });

        element.addEventListener("dragover", event => {
            event.preventDefault();

            if (!controller.editor.isEditable()) {
                event.dataTransfer!.dropEffect = "none";
                return;
            }

            event.dataTransfer!.dropEffect = "copy";
        }, { signal: abortController.signal });

        element.addEventListener("drop", event => {
            if (!controller.editor.isEditable())
                return;

            event.preventDefault();

            const files = event.dataTransfer?.files;
            if (!files?.length)
                return;

            void this.insertImageNodes(files, controller, controller.editor.imageHandler!);
        }, { signal: abortController.signal });

        element.addEventListener("paste", event => {
            if (!controller.editor.isEditable())
                return;

            const files = event.clipboardData?.files;
            if (!files?.length)
                return;

            event.preventDefault();
            void this.insertImageNodes(files, controller, controller.editor.imageHandler!);
        }, { signal: abortController.signal });

        return () => abortController.abort();
    }

    override getNodes(): LexicalConfigNode {
        return [ImageNode];
    }

    async insertImageNodes(files: FileList, controller: HtmlEditorController, handler: ImageHandlerBase): Promise<void> {

        const uploadPromises: Promise<ImageInfo>[] = Array.from(files)
            .filter(file => file.type.startsWith("image/"))
            .map(async file => {
                try {
                    return await handler.uploadData(file);
                } catch (error) {
                    console.error("Image upload failed.", error);
                    throw error;
                }
            });

        const uploadedFiles = await Promise.allSettled(uploadPromises);
        const successfulFiles = uploadedFiles
            .filter((r): r is PromiseFulfilledResult<ImageInfo> => r.status === "fulfilled")
            .map(r => r.value);

        if (!successfulFiles.length)
            return;

        controller.editor.update(() => {
            for (const file of successfulFiles)
                $getRoot().append($createImageNode(file, ImageNode));
        });

        controller.saveHtml(); // Signum's note: onBlur is not reliable here.
    }
}

export type { ImageHandlerBase, ImageInfo };
export { ImageNode, $createImageNode };
