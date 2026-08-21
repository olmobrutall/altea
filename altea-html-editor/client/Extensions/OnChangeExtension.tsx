import type { EditorState } from "lexical";
import type { HtmlEditorController } from "../HtmlEditorController";
import { HtmlEditorExtension, type OptionalCallback } from "./types";

// Port of Signum.HtmlEditor's Extensions/OnChangeExtension.tsx — verbatim. It is one of the four DEFAULT
// extensions: registering an update listener is what keeps `controller.editorState` fresh, which every
// toolbar button's active state reads.
type OnChangeCallback = (editorState?: EditorState) => void;

export class OnChangeExtension extends HtmlEditorExtension {
    override name = "OnChangeExtension";

    props: { onChange?: OnChangeCallback };

    constructor(onChange?: OnChangeCallback) {
        super();
        this.props = { onChange };
    }

    override registerExtension(controller: HtmlEditorController): OptionalCallback {
        if (!controller.editor)
            return undefined;

        return controller.editor.registerUpdateListener(({ editorState }) => {
            controller.editorState = editorState;
            this.props.onChange?.(editorState);
            controller.forceUpdate?.();
        });
    }
}
