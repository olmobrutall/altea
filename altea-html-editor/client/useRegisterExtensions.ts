import * as React from "react";
import type { HtmlEditorExtension } from "./Extensions/types";
import type { HtmlEditorController } from "./HtmlEditorController";

// Port of Signum.HtmlEditor's useRegisterExtensions.ts — verbatim.
export function useRegisterExtensions(controller: HtmlEditorController, extensions: HtmlEditorExtension[] = []): void {
    React.useEffect(() => {
        if (!controller?.editor)
            return;

        const unsubscribeFns = extensions
            .map(e => e.registerExtension?.(controller))
            .filter((fn): fn is () => void => fn != undefined);

        return () => unsubscribeFns.forEach(fn => fn());
    }, [controller.editor, extensions]);
}
