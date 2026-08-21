import { CodeHighlightNode, CodeNode, registerCodeHighlighting } from "@lexical/code";
import type { HtmlEditorController } from "../HtmlEditorController";
import { HtmlEditorExtension, type LexicalConfigNode, type OptionalCallback } from "./types";

// Port of Signum.HtmlEditor's Extensions/CodeBlockExtension.tsx — verbatim.
export class CodeBlockExtension extends HtmlEditorExtension {
    override name = "CodeBlockExtension";

    override registerExtension(controller: HtmlEditorController): OptionalCallback {
        return registerCodeHighlighting(controller.editor);
    }

    override getNodes(): LexicalConfigNode {
        return [CodeNode, CodeHighlightNode];
    }
}
