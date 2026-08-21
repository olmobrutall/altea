import * as React from "react";
import type { Extension } from "@codemirror/state";
import { html } from "@codemirror/lang-html";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { CodeMirrorComponent, commonKeymap, type CodeMirrorComponentHandler } from "./CodeMirrorComponent";

// Port of Signum.CodeMirror's HtmlCodeMirror.tsx — the one wrapper that binds a TypeContext rather than a
// raw string, because it edits an entity field (an email template's body). See CodeMirrorComponent.tsx for
// the CM5 → CM6 divergence; the dark-mode MutationObserver that lived here is now shared there
// (`useBootstrapTheme`), so `theme: dracula` is gone from this file.
export default function HtmlCodeMirror(p: {
    ctx: TypeContext<string | null | undefined>;
    onChange?: (newValue: string) => void;
    innerRef?: React.Ref<CodeMirrorComponentHandler>;
    extensions?: Extension[];
}): React.JSX.Element {

    const { ctx, onChange, innerRef } = p;

    function handleOnChange(newValue: string): void {
        if (!ctx.readOnly) {
            ctx.value = newValue;
            if (onChange != undefined)
                onChange(ctx.value);
        }
    }

    const extensions = React.useMemo(() => [html(), commonKeymap, ...(p.extensions ?? [])], [p.extensions]);

    return (
        <div>
            <CodeMirrorComponent value={ctx.value} ref={innerRef}
                extensions={extensions}
                readOnly={ctx.readOnly}
                onChange={handleOnChange} />
        </div>
    );
}
