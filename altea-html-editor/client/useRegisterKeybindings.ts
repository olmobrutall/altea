import * as React from "react";
import { COMMAND_PRIORITY_NORMAL, KEY_DOWN_COMMAND } from "lexical";
import type { HtmlEditorController } from "./HtmlEditorController";

// Port of Signum.HtmlEditor's useRegisterKeybindings.ts — verbatim.
export function useRegisterKeybindings(controller: HtmlEditorController,
    keybindingFn?: (event: KeyboardEvent) => boolean): void {

    React.useEffect(() => {
        if (!controller?.editor || !keybindingFn)
            return;

        return controller.editor.registerCommand(KEY_DOWN_COMMAND, keybindingFn, COMMAND_PRIORITY_NORMAL);
    }, [controller.editor, keybindingFn]);
}
