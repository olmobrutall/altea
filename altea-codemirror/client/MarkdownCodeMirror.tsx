import * as React from "react";
import type { Extension } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { CodeMirrorComponent, commonKeymap, type CodeMirrorComponentHandler } from "./CodeMirrorComponent";

// NEW in altea (Signum.CodeMirror has no markdown wrapper), and the one wrapper here with no Signum
// counterpart. It was written while Signum.Markdown was unported, to stand in for its `MarkdownLine`; that
// module IS ported now (@altea/altea-markdown), and its two consumers — altea-agent's SkillCustomization and
// altea-tour's TourStep — use the real MarkdownLine, as Signum does. This stays as the SYNTAX-HIGHLIGHTING
// alternative: MarkdownLine is a plain text area with a rendered preview toggle, so a caller who wants
// highlighted source while typing reaches for this instead. Shaped like HtmlCodeMirror — a TypeContext, so
// it binds an entity field directly.
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
