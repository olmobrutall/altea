import * as React from "react";
import type { Extension } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { CodeMirrorComponent, commonKeymap, type CodeMirrorComponentHandler } from "./CodeMirrorComponent";

// NEW in altea (Signum.CodeMirror has no markdown wrapper). It stands in for Signum.Markdown's
// `MarkdownLine`, which altea does not port: that component pairs a CM5 markdown editor with a rendered
// preview pane, and the only consumer altea has (altea-agent's SkillCustomization instructions) needs the
// EDITOR. Shaped like HtmlCodeMirror — a TypeContext, so it binds an entity field directly.
export default function MarkdownCodeMirror(p: {
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

    const extensions = React.useMemo(() => [markdown(), commonKeymap, ...(p.extensions ?? [])], [p.extensions]);

    return (
        <div>
            <CodeMirrorComponent value={ctx.value} ref={innerRef}
                extensions={extensions}
                readOnly={ctx.readOnly}
                onChange={handleOnChange} />
        </div>
    );
}
