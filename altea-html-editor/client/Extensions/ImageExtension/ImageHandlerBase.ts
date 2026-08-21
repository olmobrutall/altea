import type { SerializedLexicalNode } from "lexical";

// Port of Signum.HtmlEditor's Extensions/ImageExtension/ImageHandlerBase.ts — verbatim.
//
// The APP supplies the handler: how an uploaded blob becomes a stored image, how that image renders inside
// the editor, and how it round-trips through an `<img>` element in the saved HTML. altea has no built-in
// implementation (Signum's lives in Signum.Help, which is not ported), so the interface IS the extension
// point — a host over @altea/altea-files would implement it against a FilePathEmbedded.
export interface ImageHandlerBase {
    uploadData(blob: Blob): Promise<ImageInfo>;
    renderImage(val: ImageInfo): React.ReactElement;
    toElement(val: ImageInfo): HTMLElement | undefined;
    fromElement(val: HTMLElement): ImageInfo | undefined;
}

export interface ImageInfo extends Partial<SerializedLexicalNode> {
    imageId?: string;
    binaryFile?: string;
    fileName?: string;
}

// The handler travels on the EDITOR because a Lexical node's `decorate` / `exportDOM` receive the editor but
// nothing else (Signum widens the same interface).
declare module "lexical" {
    export interface LexicalEditor {
        imageHandler?: ImageHandlerBase;
    }
}
