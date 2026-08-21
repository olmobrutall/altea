import { COMMAND_PRIORITY_NORMAL, KEY_DOWN_COMMAND } from "lexical";
import type { HtmlEditorController } from "../HtmlEditorController";
import { HtmlEditorExtension } from "./types";

// Port of Signum.HtmlEditor's Extensions/BasicCommandsExtension.ts — verbatim: Ctrl+S saves the html back
// onto the binding without leaving the editor.
export class BasicCommandsExtensions extends HtmlEditorExtension {
    override name = "BasicCommandsExtensions";

    override registerExtension(controller: HtmlEditorController): () => void {
        return controller.editor.registerCommand(
            KEY_DOWN_COMMAND,
            event => {
                if (event.ctrlKey && event.key === "s") {
                    controller.saveHtml();
                    return true;
                }
                return false;
            },
            COMMAND_PRIORITY_NORMAL);
    }
}
